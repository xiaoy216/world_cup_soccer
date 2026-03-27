
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GameState, Vec2, Vec3, GameMetrics } from './types';
import { RotateCcw, Box, Trophy, Activity, Sparkles, Zap, Settings2, Flame } from 'lucide-react';
import confetti from 'canvas-confetti';

const SOCCER_BALL_URL = "https://upload.wikimedia.org/wikipedia/commons/d/d3/Soccerball.svg";

// --- 3D WORLD CONSTANTS ---
const GOAL_DIST = 11.0; 
const GOAL_WIDTH = 10.0; 
const GOAL_HEIGHT = 3.0; 
const NET_DEPTH = 2.5; 
const BASE_BALL_RADIUS = 0.22; // Renamed to BASE
const GRAVITY = 0.012; 
const AIR_RESISTANCE = 0.985;
const FLOOR_BOUNCE = 0.5;
const GROUND_FRICTION = 0.92;
const CAM_POS = { x: 0, y: 1.6, z: -4.5 }; 
const MAX_ATTEMPTS_PER_ROUND = 5;
const BALL_SCALES = [1.0, 1.8, 2.8]; // Level 1, 2, 3 sizes

// --- TARGET SYSTEM ---
interface TargetPanel {
  id: number;
  row: number; 
  col: number; 
  x: number;
  y: number;
  width: number;
  height: number;
  active: boolean;
  scoreValue: number;
  baseColor: string;
  highlightColor: string;
}

// --- PARTICLE SYSTEM ---
interface FireParticle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;      // 0.0 to 1.0
    decay: number;
    size: number;
    maxSize: number;
}

const MAX_WIND_FORCE = 0.008;

const App: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(GameState.IDLE);
  const [difficulty, setDifficulty] = useState<number>(0.2); 
  
  // Game State
  const [score, setScore] = useState(0);
  const [attemptsLeft, setAttemptsLeft] = useState(MAX_ATTEMPTS_PER_ROUND);
  const [totalPotential, setTotalPotential] = useState(0);
  const [isGameOver, setIsGameOver] = useState(false);
  
  // Growth & Fever System
  const [ballLevel, setBallLevel] = useState(1); 
  const [energy, setEnergy] = useState(0); // 0 to 100

  const [lastResult, setLastResult] = useState<string | null>(null);
  const [isShaking, setIsShaking] = useState(false);
  
  // Target State
  const [targets, setTargets] = useState<TargetPanel[]>([]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ballImageRef = useRef<HTMLImageElement>(new Image());
  
  // 3D Physics State
  const ballPos = useRef<Vec3>({ x: 0, y: BASE_BALL_RADIUS, z: 0 });
  const ballVel = useRef<Vec3>({ x: 0, y: 0, z: 0 });
  const ballSpin = useRef<number>(0); 
  const ballRotation = useRef<number>(0); 
  const netOffset = useRef<Vec3>({ x: 0, y: 0, z: 0 });
  
  // VFX State
  const fireParticles = useRef<FireParticle[]>([]);
  
  // Input State
  const dragStart = useRef<Vec2 | null>(null);
  const dragPath = useRef<Vec2[]>([]);
  const windVector = useRef<Vec3>({ x: 0, y: 0, z: 0 });
  const stuckWatchdog = useRef<number>(0);

  // Initialize Targets
  const initTargets = useCallback(() => {
    const newTargets: TargetPanel[] = [];
    const rows = 3;
    const cols = 3;
    const panelW = GOAL_WIDTH / cols;
    const panelH = GOAL_HEIGHT / rows;
    
    // Generate values
    const values = [100, 200, 300, 400, 500, 600, 700, 800, 900];
    // Shuffle
    for (let i = values.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [values[i], values[j]] = [values[j], values[i]];
    }

    let idCounter = 1;
    let valIndex = 0;
    let potentialSum = 0;
    
    for (let r = rows - 1; r >= 0; r--) {
        for (let c = 0; c < cols; c++) {
            const centerX = (c - 1) * panelW;
            const centerY = (r + 0.5) * panelH;

            // Premium Gold/Amber Theme
            const baseColor = r === 0 ? '#b45309' : r === 1 ? '#d97706' : '#f59e0b'; 
            const highlightColor = '#fcd34d';

            const val = values[valIndex++];
            potentialSum += val;

            newTargets.push({
                id: idCounter++,
                row: r,
                col: c,
                x: centerX,
                y: centerY,
                width: panelW * 0.92, 
                height: panelH * 0.92,
                active: true,
                scoreValue: val,
                baseColor,
                highlightColor
            });
        }
    }
    setTargets(newTargets);
    setTotalPotential(potentialSum);
    setAttemptsLeft(MAX_ATTEMPTS_PER_ROUND);
    setScore(0);
    setBallLevel(1); 
    setEnergy(0);
    setIsGameOver(false);
    fireParticles.current = [];
  }, []);

  useEffect(() => {
    initTargets();
    ballImageRef.current.crossOrigin = "Anonymous";
    ballImageRef.current.src = SOCCER_BALL_URL;
  }, [initTargets]);

  // Global Input Handlers
  useEffect(() => {
    const handleGlobalUp = () => {
      if (gameState === GameState.DRAGGING) {
         handleInteractionEnd();
      }
    };
    window.addEventListener('mouseup', handleGlobalUp);
    window.addEventListener('touchend', handleGlobalUp);
    return () => {
      window.removeEventListener('mouseup', handleGlobalUp);
      window.removeEventListener('touchend', handleGlobalUp);
    };
  }, [gameState, ballLevel]); 

  // 3D Projection Helper
  const project = useCallback((p: Vec3, width: number, height: number) => {
    const rx = p.x - CAM_POS.x;
    const ry = p.y - CAM_POS.y;
    const rz = p.z - CAM_POS.z;

    if (rz <= 0.1) return { x: -9999, y: -9999, scale: 0, visible: false };
    const effectiveFocal = Math.min(950, width * 1.25);
    const scale = effectiveFocal / rz;
    const x = width / 2 + rx * scale;
    const y = height * 0.35 - ry * scale; 
    return { x, y, scale: scale / 100, visible: true, zIndex: rz }; 
  }, []);

  const getDifficultyParams = useCallback(() => {
    const d = difficulty;
    return {
      windStrength: d * MAX_WIND_FORCE,
    };
  }, [difficulty]);

  useEffect(() => {
    const interval = setInterval(() => {
        const angle = Date.now() / 2000;
        windVector.current = {
            x: Math.sin(angle) * getDifficultyParams().windStrength,
            y: 0,
            z: Math.cos(angle * 0.7) * getDifficultyParams().windStrength * 0.5
        };
    }, 100);
    return () => clearInterval(interval);
  }, [getDifficultyParams]);

  const resetGame = () => {
      ballPos.current = { x: 0, y: BASE_BALL_RADIUS * BALL_SCALES[ballLevel-1], z: 0 };
      ballVel.current = { x: 0, y: 0, z: 0 };
      ballSpin.current = 0;
      ballRotation.current = 0;
      dragPath.current = [];
      stuckWatchdog.current = 0;
      netOffset.current = { x: 0, y: 0, z: 0 };
      setGameState(GameState.IDLE);
      setLastResult(null);

      // Check if all targets are inactive
      const allCleared = targets.length > 0 && targets.every(t => !t.active);

      // Trigger Game Over if no attempts left OR all targets cleared
      if (attemptsLeft === 0 || allCleared) {
          setIsGameOver(true);
      }
  };

  const fullReset = () => {
      setIsGameOver(false);
      setAttemptsLeft(MAX_ATTEMPTS_PER_ROUND);
      setBallLevel(1);
      setEnergy(0);
      fireParticles.current = [];
      setTimeout(() => {
        resetGame();
        initTargets(); 
      }, 0);
  }

  useEffect(() => {
      if (gameState === GameState.IDLE) {
          ballPos.current.y = BASE_BALL_RADIUS * BALL_SCALES[ballLevel - 1];
      }
  }, [ballLevel, gameState]);


  const handleInteractionStart = (e: React.MouseEvent | React.TouchEvent) => {
    if (gameState === GameState.RESULT) {
      resetGame();
      return;
    }
    if (attemptsLeft <= 0 || isGameOver) return; 
    if ((e.target as HTMLElement).closest('button')) return;
    if (gameState !== GameState.IDLE) return;

    const x = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const y = 'touches' in e ? e.touches[0].clientY : e.clientY;
    dragStart.current = { x, y };
    dragPath.current = [{ x, y }];
    setGameState(GameState.DRAGGING);
  };

  const handleInteractionMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (gameState !== GameState.DRAGGING) return;
    const x = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const y = 'touches' in e ? e.touches[0].clientY : e.clientY;
    dragPath.current.push({ x, y });
    if (dragPath.current.length > 40) dragPath.current.shift();
  };

  const handleInteractionEnd = () => {
    if (gameState !== GameState.DRAGGING) return;

    if (dragPath.current.length < 2) {
        setGameState(GameState.IDLE);
        return;
    }

    const start = dragPath.current[0];
    const end = dragPath.current[dragPath.current.length - 1];
    
    const dx = (end.x - start.x) / window.innerWidth;
    const dy = (end.y - start.y) / window.innerHeight; 
    
    const swipeDist = Math.sqrt(dx*dx + dy*dy);
    
    // --- TAP DETECTION (Ball Growth) ---
    if (swipeDist < 0.02) {
        const w = window.innerWidth;
        const h = window.innerHeight;
        const ballProj = project(ballPos.current, w, h);
        
        if (ballProj.visible) {
             const currentRadiusPx = BASE_BALL_RADIUS * BALL_SCALES[ballLevel-1] * ballProj.scale * 100;
             const touchRadius = currentRadiusPx * 1.5; 
             const distToBall = Math.sqrt(Math.pow(end.x - ballProj.x, 2) + Math.pow(end.y - ballProj.y, 2));
             
             if (distToBall < touchRadius) {
                 setBallLevel(prev => {
                     const next = prev >= 3 ? 1 : prev + 1;
                     confetti({
                        particleCount: 30,
                        spread: 60,
                        origin: { x: ballProj.x / w, y: ballProj.y / h },
                        colors: ['#38bdf8', '#ffffff'],
                        ticks: 100,
                        gravity: 0.8,
                        scalar: 0.6
                     });
                     return next;
                 });
                 setGameState(GameState.IDLE);
                 return;
             }
        }
        setGameState(GameState.IDLE);
        return;
    }
    
    // --- SHOOTING LOGIC (Swipe) ---
    if (swipeDist < 0.05) {
        setGameState(GameState.IDLE);
        return;
    }

    const swipeSpeed = swipeDist; 
    let curveSum = 0;
    for(let i=1; i<dragPath.current.length-1; i++) {
        const p1 = dragPath.current[i-1];
        const p2 = dragPath.current[i];
        const p3 = dragPath.current[i+1];
        const v1 = { x: p2.x - p1.x, y: p2.y - p1.y };
        const v2 = { x: p3.x - p2.x, y: p3.y - p2.y };
        const cross = v1.x * v2.y - v1.y * v2.x;
        curveSum += cross;
    }
    const MAX_CURVE = 0.03;
    ballSpin.current = Math.max(-MAX_CURVE, Math.min(MAX_CURVE, curveSum * 0.00005));
    
    // FIRE SHOT PHYSICS BOOST
    const isFireShot = energy >= 100;
    
    const powerZ = Math.min(0.95, Math.abs(dy) * 2.1 + swipeSpeed * 0.55); 
    const lift = Math.min(0.5, Math.abs(dy) * 1.3); 
    const side = dx * 1.5;

    ballVel.current = {
        x: side,
        y: lift * 0.5 + 0.11, 
        z: (powerZ * 0.75 + 0.16) * (isFireShot ? 1.2 : 1.0) // Fire shot is 20% faster
    };

    setGameState(GameState.KICKED);
    setAttemptsLeft(prev => Math.max(0, prev - 1));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;

    const update = () => {
      if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
          canvas.width = window.innerWidth;
          canvas.height = window.innerHeight;
      }
      
      const w = canvas.width;
      const h = canvas.height;
      const isFireShot = energy >= 100;

      ctx.clearRect(0, 0, w, h);

      // --- RENDER ATMOSPHERE ---
      const horizonY = h * 0.35; 
      // Dynamic Sky for Fire Mode
      const skyGrad = ctx.createLinearGradient(0, 0, 0, horizonY);
      if (isFireShot && gameState !== GameState.IDLE) {
          skyGrad.addColorStop(0, '#2d0606'); // Darker Red
          skyGrad.addColorStop(1, '#601010'); // Red
      } else {
          skyGrad.addColorStop(0, '#0f172a');
          skyGrad.addColorStop(1, '#1e293b');
      }
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, w, horizonY);

      // Lights
      ctx.fillStyle = isFireShot && gameState !== GameState.IDLE ? 'rgba(255, 100, 50, 0.1)' : 'rgba(255, 255, 255, 0.03)';
      ctx.beginPath(); ctx.arc(w * 0.2, horizonY * 0.5, 100, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(w * 0.8, horizonY * 0.5, 100, 0, Math.PI * 2); ctx.fill();

      // Field
      const fieldGrad = ctx.createLinearGradient(0, horizonY, 0, h);
      fieldGrad.addColorStop(0, '#104e3b'); 
      fieldGrad.addColorStop(1, '#15803d'); 
      ctx.fillStyle = fieldGrad;
      ctx.fillRect(0, horizonY, w, h - horizonY);

      // Stripes
      ctx.save();
      for (let z = 0; z < 30; z += 3) {
          const p1 = project({ x: -20, y: 0, z }, w, h);
          const p2 = project({ x: 20, y: 0, z }, w, h);
          const p3 = project({ x: 20, y: 0, z: z + 1.5 }, w, h);
          const p4 = project({ x: -20, y: 0, z: z + 1.5 }, w, h);
          if (p1.visible) {
              ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
              ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.fill();
          }
      }
      ctx.restore();

      // Box Line
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 2;
      const b1 = project({ x: -20, y: 0.05, z: 5 }, w, h);
      const b2 = project({ x: 20, y: 0.05, z: 5 }, w, h);
      if (b1.visible && b2.visible) {
          ctx.beginPath(); ctx.moveTo(b1.x, b1.y); ctx.lineTo(b2.x, b2.y); ctx.stroke();
      }

      // --- PHYSICS UPDATE ---
      const isMoving = gameState === GameState.KICKED || gameState === GameState.RESULT; 
      const currentRadius = BASE_BALL_RADIUS * BALL_SCALES[ballLevel - 1];

      if (isMoving) {
        ballVel.current.x *= AIR_RESISTANCE;
        ballVel.current.z *= AIR_RESISTANCE;
        ballVel.current.y -= GRAVITY;
        ballPos.current.y += ballVel.current.y;

        // Ground collision
        if (ballPos.current.y < currentRadius) {
            ballPos.current.y = currentRadius;
            ballVel.current.y *= -FLOOR_BOUNCE;
            ballVel.current.x *= GROUND_FRICTION;
            ballVel.current.z *= GROUND_FRICTION;
            if (Math.abs(ballVel.current.y) < 0.05) ballVel.current.y = 0;
            if (Math.abs(ballVel.current.z) < 0.08 && Math.abs(ballVel.current.x) < 0.08) {
                 ballVel.current.x = 0; ballVel.current.z = 0;
            }
        }

        ballVel.current.x += windVector.current.x + ballSpin.current;
        ballVel.current.z += windVector.current.z;
        ballPos.current.x += ballVel.current.x;
        ballPos.current.z += ballVel.current.z;
        
        const speed = Math.sqrt(ballVel.current.x**2 + ballVel.current.y**2 + ballVel.current.z**2);
        ballRotation.current += speed * 0.8;

        stuckWatchdog.current += 1;
        if (stuckWatchdog.current > 600 && gameState === GameState.KICKED) resetGame(); 

        // TARGET COLLISION CHECK
        if (gameState === GameState.KICKED && ballPos.current.z >= GOAL_DIST) {
            const overshoot = ballPos.current.z - GOAL_DIST;
            const vz = Math.max(0.001, ballVel.current.z);
            const timeStepCorrection = overshoot / vz;

            const impactX = ballPos.current.x - ballVel.current.x * timeStepCorrection;
            const impactY = ballPos.current.y - ballVel.current.y * timeStepCorrection;

            // Collision Logic
            const HIT_TOLERANCE = currentRadius * 0.95; 

            // If FireShot, we have a massive explosion radius
            const EXPLOSION_RADIUS = 3.5; 
            
            // First check direct hits for positioning (or if not fire shot)
            const directHits = targets.filter(t => 
                t.active && 
                Math.abs(impactX - t.x) < (t.width / 2 + HIT_TOLERANCE) && 
                Math.abs(impactY - t.y) < (t.height / 2 + HIT_TOLERANCE)
            );

            // Determine if we hit anything at all (Targets OR Net) to trigger explosion
            let didHitAnything = directHits.length > 0;
            const inGoal = Math.abs(impactX) < GOAL_WIDTH/2 + currentRadius && impactY < GOAL_HEIGHT + currentRadius && impactY > -currentRadius;
            
            if (!didHitAnything && inGoal) {
                didHitAnything = true; // Hit the net/air inside goal
            }

            if (didHitAnything) {
                let hitTargets: TargetPanel[] = [];

                if (isFireShot) {
                    // EXPLOSION LOGIC: Hit everything within radius of impact point
                    hitTargets = targets.filter(t => 
                        t.active && 
                        Math.sqrt(Math.pow(t.x - impactX, 2) + Math.pow(t.y - impactY, 2)) < EXPLOSION_RADIUS
                    );
                    setEnergy(0); // Reset energy
                } else {
                    hitTargets = directHits;
                }

                if (hitTargets.length > 0) {
                    let roundScore = 0;
                    let hitIds: number[] = [];
                    
                    hitTargets.forEach(t => {
                        roundScore += t.scoreValue;
                        hitIds.push(t.id);
                    });

                    // Bonus for Fire Shot
                    if (isFireShot) roundScore *= 2;

                    setTargets(prev => prev.map(t => hitIds.includes(t.id) ? { ...t, active: false } : t));
                    
                    const text = isFireShot 
                        ? `火焰轰炸! +${roundScore}` 
                        : (hitTargets.length > 1 ? `连击 x${hitTargets.length}!` : `获得 ${roundScore} 京豆`);
                    
                    setLastResult(text);
                    setGameState(GameState.RESULT);
                    setScore(s => s + roundScore);
                    
                    // Energy Gain (only if not fire shot)
                    if (!isFireShot) {
                        setEnergy(prev => Math.min(100, prev + 25 * hitTargets.length));
                    }

                    // Visuals
                    confetti({ particleCount: isFireShot ? 300 : 100 * hitTargets.length, spread: isFireShot ? 150 : 100, origin: { y: 0.4 }, colors: isFireShot ? ['#ef4444', '#f59e0b', '#7f1d1d'] : ['#fbbf24', '#d97706', '#ffffff'] });
                    setIsShaking(true); setTimeout(() => setIsShaking(false), 300);
                    
                    ballVel.current.z *= 0.5; 
                } else if (inGoal) {
                    // Hit net but no targets
                    if (isFireShot) {
                         // Fire shot hit net -> Still explodes nearby targets? 
                         // Let's keep it simple: if it didn't hit targets radius, it's just a cool miss
                         setLastResult("火焰冲击!");
                         setEnergy(0);
                    } else {
                        setLastResult("未击中");
                         // Penalty for missing targets but hitting goal? Maybe small energy loss
                         setEnergy(prev => Math.max(0, prev - 10));
                    }
                    setGameState(GameState.RESULT);
                    ballVel.current.z *= 0.9;
                }
            } else {
                 setLastResult("MISS");
                 setGameState(GameState.RESULT);
                 setEnergy(prev => Math.max(0, prev - 20)); // Penalty for complete miss
            }
        }
        
        // NET PHYSICS
        if (gameState === GameState.RESULT && (lastResult !== 'MISS')) {
             const netBackZ = GOAL_DIST + NET_DEPTH;
             if (ballPos.current.z > netBackZ - currentRadius) {
                 ballPos.current.z = netBackZ - currentRadius;
                 ballVel.current.z *= -0.1; ballVel.current.x *= 0.5; ballVel.current.y *= 0.5;
                 const impactForce = isFireShot ? 1.5 : 0.5;
                 netOffset.current.z = Math.min(netOffset.current.z + impactForce, 1.5);
                 netOffset.current.x = ballPos.current.x * 0.3;
                 netOffset.current.y = ballPos.current.y * 0.3;
             }
             if (ballPos.current.z < GOAL_DIST + 0.5 && ballVel.current.z < 0) {
                 ballVel.current.z = 0.02; ballVel.current.x *= 0.8;
             }
        }
        netOffset.current.z *= 0.9; netOffset.current.x *= 0.9; netOffset.current.y *= 0.9;
      } 
      else if (gameState === GameState.IDLE) {
         ballPos.current.x = 0;
         ballPos.current.z = 0;
         netOffset.current = { x: 0, y: 0, z: 0 };
      }

      // --- RENDER SCENE ---
      const gD = GOAL_DIST; const gW = GOAL_WIDTH / 2; const gH = GOAL_HEIGHT;
      const bl = project({x: -gW, y: 0, z: gD}, w, h);
      const tl = project({x: -gW, y: gH, z: gD}, w, h);
      const tr = project({x: gW, y: gH, z: gD}, w, h);
      const br = project({x: gW, y: 0, z: gD}, w, h);

      // Render Targets
      if (bl.visible && tr.visible) {
          // Draw Net (Behind targets)
          const depth = NET_DEPTH;
          const bld = project({x: -gW, y: 0, z: gD + depth}, w, h);
          const tld = project({x: -gW, y: gH, z: gD + depth * 0.4}, w, h);
          const trd = project({x: gW, y: gH, z: gD + depth * 0.4}, w, h);
          const brd = project({x: gW, y: 0, z: gD + depth}, w, h);
          
          ctx.strokeStyle = isFireShot && gameState === GameState.RESULT ? 'rgba(255, 100, 50, 0.4)' : 'rgba(230, 230, 230, 0.2)'; 
          ctx.lineWidth = 1;
          ctx.beginPath();
          // Simple net grid
          const netDivs = 10;
          for(let i=0; i<=netDivs; i++) {
             const t = i/netDivs;
             // Horizontal
             const ly = bld.y + (tld.y - bld.y)*t; const ry = brd.y + (trd.y - brd.y)*t;
             ctx.moveTo(bld.x, ly); ctx.lineTo(brd.x, ry);
             // Vertical
             const tx = tld.x + (trd.x - tld.x)*t; const bx = bld.x + (brd.x - bld.x)*t;
             ctx.moveTo(bx, bld.y); ctx.lineTo(tx, tld.y);
          }
          ctx.stroke();

          // DRAW LUCKY BLOCKS
          const showHiddenValues = isGameOver || (attemptsLeft === 0 && gameState === GameState.RESULT);

          targets.forEach(target => {
              if (!target.active) return; 

              const pZ = gD;
              const halfW = target.width / 2;
              const halfH = target.height / 2;
              
              const p1 = project({ x: target.x - halfW, y: target.y - halfH, z: pZ }, w, h);
              const p2 = project({ x: target.x + halfW, y: target.y - halfH, z: pZ }, w, h);
              const p3 = project({ x: target.x + halfW, y: target.y + halfH, z: pZ }, w, h);
              const p4 = project({ x: target.x - halfW, y: target.y + halfH, z: pZ }, w, h);

              if (p1.visible) {
                  const isRevealState = showHiddenValues;
                  const cx = (p1.x + p2.x + p3.x + p4.x) / 4;
                  const cy = (p1.y + p2.y + p3.y + p4.y) / 4;
                  const radius = Math.abs(p2.x - p1.x) * 0.8;

                  if (isRevealState) {
                      ctx.fillStyle = 'rgba(30, 41, 59, 0.9)'; 
                      ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)'; 
                  } else {
                      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
                      grad.addColorStop(0, target.highlightColor);
                      grad.addColorStop(0.5, target.baseColor);
                      grad.addColorStop(1, '#92400e'); 
                      ctx.fillStyle = grad;
                      ctx.strokeStyle = '#fcd34d'; 
                  }

                  ctx.beginPath();
                  ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y);
                  ctx.closePath();
                  ctx.fill();
                  ctx.lineWidth = Math.max(2, p1.scale * 12);
                  ctx.stroke();

                  // Highlight
                  if (!isRevealState) {
                      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
                      ctx.lineWidth = Math.max(1, p1.scale * 4);
                      ctx.beginPath(); ctx.moveTo(p2.x, p2.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p4.x, p4.y); ctx.stroke();
                      ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
                      ctx.beginPath(); ctx.moveTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.stroke();
                  }

                  // Content
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'middle';
                  
                  if (isRevealState) {
                      ctx.fillStyle = '#cbd5e1'; 
                      ctx.font = `800 ${Math.max(10, p1.scale * 90)}px Inter`; 
                      ctx.fillText(target.scoreValue.toString(), cx, cy);
                  } else {
                      ctx.fillStyle = '#78350f'; 
                      ctx.font = `900 ${Math.max(12, p1.scale * 110)}px Inter`; 
                      ctx.save();
                      ctx.shadowColor = 'rgba(255,255,255,0.4)';
                      ctx.shadowBlur = 0;
                      ctx.shadowOffsetY = 2;
                      ctx.fillText("?", cx, cy);
                      ctx.restore();
                  }
              }
          });

          // Draw Frame
          ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = tl.scale * 12; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          ctx.beginPath(); ctx.moveTo(bl.x, bl.y); ctx.lineTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); ctx.stroke();
      }

      // --- BALL RENDER ---
      if (ballPos.current.y > 0) {
          const shadowProj = project({x: ballPos.current.x, y: 0.02, z: ballPos.current.z}, w, h);
          if (shadowProj.visible) {
              const heightFactor = Math.max(0, 1 - ballPos.current.y / 2.5);
              const sSize = currentRadius * shadowProj.scale * 100 * (0.8 + 0.2 * heightFactor); 
              ctx.fillStyle = `rgba(0,0,0,${0.3 * heightFactor})`;
              ctx.beginPath(); ctx.ellipse(shadowProj.x, shadowProj.y, sSize, sSize * 0.3, 0, 0, Math.PI*2); ctx.fill();
          }
      }

      const ballProj = project(ballPos.current, w, h);
      if (ballProj.visible) {
          const bRad = currentRadius * ballProj.scale * 100;

          // --- FIRE PARTICLE SYSTEM UPDATE & RENDER ---
          if (isFireShot) {
             // 1. SPAWN PARTICLES
             // More particles when moving to create trail
             const velocityMagnitude = Math.sqrt(ballVel.current.x**2 + ballVel.current.y**2 + ballVel.current.z**2);
             const spawnCount = gameState === GameState.KICKED ? 5 : 2;

             for (let i = 0; i < spawnCount; i++) {
                 const angle = Math.random() * Math.PI * 2;
                 const r = Math.sqrt(Math.random()) * bRad * 0.8;
                 
                 // Trail calculation: move opposite to ball velocity
                 // Note: ballVel is in 3D world space, we need a simple screen space approximation for the trail visual
                 // or just use randomness + slight upward drift for "fire"
                 
                 // Simple upward drift with some random spread
                 const vx = (Math.random() - 0.5) * bRad * 0.2;
                 const vy = -Math.random() * bRad * 0.4 - bRad * 0.1; // Always up
                 
                 fireParticles.current.push({
                     x: ballProj.x + Math.cos(angle) * r,
                     y: ballProj.y + Math.sin(angle) * r,
                     vx: vx - (ballVel.current.x * 200 * ballProj.scale), // Add trail influence opposite to movement
                     vy: vy + (ballVel.current.y * 200 * ballProj.scale), // Add trail influence
                     life: 1.0,
                     decay: 0.03 + Math.random() * 0.03,
                     size: bRad * (0.4 + Math.random() * 0.6),
                     maxSize: bRad
                 });
             }
          }

          // 2. RENDER PARTICLES (Additive Blending)
          if (fireParticles.current.length > 0) {
              ctx.save();
              ctx.globalCompositeOperation = 'lighter'; // This makes the fire look "hot"/glowing
              
              for (let i = fireParticles.current.length - 1; i >= 0; i--) {
                  const p = fireParticles.current[i];
                  
                  // Physics Update
                  p.x += p.vx;
                  p.y += p.vy;
                  p.life -= p.decay;
                  p.size *= 0.95; // Shrink over time

                  if (p.life <= 0) {
                      fireParticles.current.splice(i, 1);
                      continue;
                  }

                  // Color Interpolation based on Life
                  // 1.0 -> 0.7: White/Yellow
                  // 0.7 -> 0.3: Orange
                  // 0.3 -> 0.0: Red/Dark
                  
                  const alpha = p.life;
                  let color = '';
                  if (p.life > 0.7) {
                      color = `rgba(255, 255, ${Math.floor(200 * p.life)}, ${alpha})`; // White-ish Yellow
                  } else if (p.life > 0.3) {
                      color = `rgba(255, ${Math.floor(165 * (p.life / 0.7))}, 0, ${alpha})`; // Orange
                  } else {
                      color = `rgba(${Math.floor(255 * (p.life / 0.3))}, 20, 20, ${alpha})`; // Red fading out
                  }

                  ctx.fillStyle = color;
                  ctx.beginPath();
                  ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                  ctx.fill();
              }
              ctx.restore();
          }

          ctx.save();
          ctx.translate(ballProj.x, ballProj.y);
          ctx.rotate(ballRotation.current);

          const ballImg = ballImageRef.current;
          if (ballImg && ballImg.complete && ballImg.naturalWidth > 0) {
             // Tint ball red if fire shot
             ctx.drawImage(ballImg, -bRad, -bRad, bRad * 2, bRad * 2);
             if (isFireShot) {
                 ctx.globalCompositeOperation = 'overlay';
                 ctx.fillStyle = '#ef4444';
                 ctx.beginPath(); ctx.arc(0, 0, bRad, 0, Math.PI*2); ctx.fill();
             }
          } else {
              ctx.fillStyle = isFireShot ? '#ef4444' : 'white'; 
              ctx.beginPath(); ctx.arc(0, 0, bRad, 0, Math.PI*2); ctx.fill();
          }
          ctx.restore();

          // Render Growth Indicator (Only in IDLE)
          if (gameState === GameState.IDLE && !isGameOver) {
             ctx.save();
             ctx.translate(ballProj.x, ballProj.y);
             ctx.strokeStyle = isFireShot ? '#ef4444' : 'rgba(56, 189, 248, 0.6)'; 
             ctx.lineWidth = 2;
             const time = Date.now() / 500;
             const ringScale = 1.2 + Math.sin(time) * 0.1;
             ctx.beginPath();
             ctx.arc(0, 0, bRad * ringScale, 0, Math.PI*2);
             ctx.stroke();
             
             // Level dots
             for(let i=0; i<3; i++) {
                 const dotAngle = (i - 1) * 0.5 + Math.PI/2;
                 const dotX = Math.cos(dotAngle) * bRad * 1.5;
                 const dotY = Math.sin(dotAngle) * bRad * 1.5;
                 ctx.fillStyle = i < ballLevel ? (isFireShot ? '#ef4444' : '#38bdf8') : '#334155';
                 ctx.beginPath(); ctx.arc(dotX, dotY, 4, 0, Math.PI*2); ctx.fill();
             }
             ctx.restore();
          }
      }

      if (gameState === GameState.DRAGGING && dragPath.current.length > 1) {
          ctx.beginPath();
          const start = dragPath.current[0];
          ctx.moveTo(start.x, start.y);
          for (let p of dragPath.current) ctx.lineTo(p.x, p.y);
          ctx.strokeStyle = isFireShot ? 'rgba(255, 100, 50, 0.8)' : 'rgba(255, 255, 255, 0.5)'; 
          ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.stroke();
      }

      animationFrameId = requestAnimationFrame(update);
    };

    update();
    return () => cancelAnimationFrame(animationFrameId);
  }, [gameState, getDifficultyParams, lastResult, project, targets, attemptsLeft, isGameOver, ballLevel, energy]);

  return (
    <div 
      className={`relative w-full h-screen select-none overflow-hidden bg-zinc-950 font-sans ${isShaking ? 'shake' : ''}`}
      onMouseDown={handleInteractionStart}
      onMouseMove={handleInteractionMove}
      onTouchStart={handleInteractionStart}
      onTouchMove={handleInteractionMove}
    >
      <canvas ref={canvasRef} className="w-full h-full block" width={window.innerWidth} height={window.innerHeight} />

      {/* NEW HUD */}
      <div className="absolute top-6 left-1/2 -translate-x-1/2 w-[90%] max-w-lg">
        <div className="flex items-center justify-between bg-zinc-900/90 backdrop-blur-md rounded-2xl border border-white/10 p-4 shadow-xl">
            {/* Total Potential */}
            <div className="flex flex-col items-center flex-1 border-r border-white/10">
                <div className="flex items-center gap-1.5 text-zinc-400 mb-1">
                    <Box size={14} />
                    <span className="text-[10px] font-bold uppercase tracking-widest">本局总额</span>
                </div>
                <span className="text-xl font-bold text-white">{totalPotential}</span>
            </div>

            {/* Current Score (Replaces Ball Level) */}
            <div className="flex flex-col items-center flex-1 border-r border-white/10">
                <div className="flex items-center gap-1.5 text-amber-400 mb-1">
                    <Trophy size={14} />
                    <span className="text-[10px] font-bold uppercase tracking-widest">已获奖励</span>
                </div>
                <span className="text-xl font-bold text-amber-400">{score}</span>
            </div>

            {/* Energy / Attempts */}
            <div className="flex flex-col items-center flex-1 relative">
                <div className="flex items-center gap-1.5 text-pink-400 mb-1">
                    <Activity size={14} />
                    <span className="text-[10px] font-bold uppercase tracking-widest">剩余次数</span>
                </div>
                <span className={`text-xl font-bold ${attemptsLeft <= 1 ? 'text-red-500' : 'text-white'}`}>
                    {attemptsLeft} / {MAX_ATTEMPTS_PER_ROUND}
                </span>
            </div>
        </div>
      </div>

      {/* ENERGY BAR (FEVER METER) */}
      <div className="absolute right-6 top-1/2 -translate-y-1/2 h-64 w-6 bg-zinc-900/80 rounded-full border border-white/10 p-1 flex flex-col justify-end overflow-hidden shadow-2xl">
          <div 
            className={`w-full rounded-full transition-all duration-500 ease-out relative ${
                energy >= 100 ? 'bg-gradient-to-t from-red-500 via-orange-500 to-yellow-400 animate-pulse shadow-[0_0_20px_rgba(239,68,68,0.6)]' : 'bg-gradient-to-t from-sky-600 to-sky-400'
            }`}
            style={{ height: `${energy}%` }}
          >
              {energy >= 100 && (
                  <div className="absolute inset-0 flex items-center justify-center">
                      <Flame size={12} className="text-white animate-bounce" fill="white" />
                  </div>
              )}
          </div>
          <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] font-bold text-white uppercase tracking-wider whitespace-nowrap">
              {energy >= 100 ? 'MAX!!' : 'Energy'}
          </div>
      </div>

      {/* Manual Reset Button */}
      <button 
        onClick={fullReset}
        className="absolute bottom-6 right-6 p-3 bg-white/10 hover:bg-white/20 backdrop-blur-md rounded-full border border-white/10 text-white transition-all z-50 active:scale-95 group"
        title="Restart Game"
      >
        <RotateCcw size={24} className="group-hover:-rotate-90 transition-transform" />
      </button>

      {/* DEBUG: BALL LEVEL & ENERGY */}
      <div className="absolute left-4 top-1/2 -translate-y-1/2 flex flex-col gap-2 bg-zinc-900/80 backdrop-blur-md p-2 rounded-xl border border-white/10 z-50 shadow-2xl">
         <div className="flex items-center gap-1 justify-center mb-1 text-zinc-500">
             <Settings2 size={10} />
             <span className="text-[10px] font-bold uppercase tracking-wider">Debug</span>
         </div>
         {[1, 2, 3].map(lvl => (
             <button
                key={lvl}
                onClick={(e) => { e.stopPropagation(); setBallLevel(lvl); }}
                className={`w-10 h-10 rounded-lg flex items-center justify-center font-bold text-sm transition-all border ${
                    ballLevel === lvl 
                    ? 'bg-sky-500 border-sky-400 text-white shadow-lg shadow-sky-500/30 scale-105' 
                    : 'bg-zinc-800 border-white/5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300'
                }`}
             >
                 {lvl}
             </button>
         ))}
         <div className="h-[1px] bg-white/10 my-1" />
         <button
            onClick={(e) => { e.stopPropagation(); setEnergy(100); }}
            className={`w-10 h-10 rounded-lg flex items-center justify-center font-bold text-sm transition-all border bg-red-900/50 border-red-500/30 text-red-400 hover:bg-red-800 hover:text-white`}
            title="Max Energy"
         >
             <Flame size={16} />
         </button>
      </div>

      {/* RESULT OVERLAY (Immediate Feedback) */}
      {lastResult && !isGameOver && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-20 bg-black/20">
           <h2 className={`text-[2.5rem] md:text-[4rem] font-black italic uppercase tracking-tighter text-center leading-tight px-4 ${
              lastResult.includes('获得') || lastResult.includes('连击') || lastResult.includes('火焰') ? 'text-transparent bg-clip-text bg-gradient-to-b from-amber-300 to-amber-600 drop-shadow-2xl' :
              lastResult === 'MISS' ? 'text-zinc-500' : 'text-zinc-300'
            }`}>
              {lastResult}
            </h2>
             <div className="mt-8 bg-black/40 backdrop-blur text-white px-6 py-2 rounded-full text-xs tracking-widest uppercase border border-white/20 animate-pulse">
              Tap Screen
            </div>
        </div>
      )}

      {/* GAME OVER STATE (Final Score) */}
      {isGameOver && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-40 animate-in fade-in duration-500">
              <div className="flex flex-col items-center bg-zinc-900 border border-amber-500/30 p-8 rounded-3xl shadow-2xl max-w-sm w-full mx-6 transform transition-all">
                <Sparkles className="text-amber-400 w-12 h-12 mb-4" />
                <h2 className="text-3xl font-black text-white mb-2 uppercase tracking-tight">幸运大奖赛结束</h2>
                <div className="text-zinc-400 text-sm mb-6 uppercase tracking-widest font-bold">本局战绩</div>
                
                <div className="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-br from-amber-300 to-amber-600 mb-8">
                    {score}
                </div>
                
                <button 
                    onClick={fullReset}
                    className="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-black py-4 px-8 rounded-xl uppercase tracking-widest transition-transform hover:scale-105 active:scale-95 shadow-lg shadow-amber-500/20"
                >
                    再玩一次
                </button>
              </div>
          </div>
      )}

      {/* LAST CHANCE HINT */}
      {attemptsLeft === 1 && !isGameOver && gameState === GameState.IDLE && (
          <div className="absolute bottom-[26%] left-1/2 -translate-x-1/2 animate-pulse pointer-events-none z-10">
             <div className="bg-red-500/80 backdrop-blur-md px-3 py-1.5 rounded-full border border-red-400/50 shadow-lg shadow-red-900/20 flex items-center gap-2 transform transition-all">
                <div className="w-1.5 h-1.5 bg-white rounded-full animate-ping" />
                <span className="text-white text-xs font-bold tracking-wider">只剩最后一次机会咯</span>
             </div>
          </div>
      )}

      {/* IDLE HINT */}
      {gameState === GameState.IDLE && attemptsLeft > 0 && !isGameOver && (
          <div className="absolute bottom-[16%] left-1/2 -translate-x-1/2 flex flex-col items-center gap-3 opacity-60 animate-bounce pointer-events-none">
             <div className="w-10 h-10 border-2 border-white rounded-full flex items-center justify-center">
                 <div className="w-2 h-2 bg-white rounded-full" />
             </div>
             <p className="text-white font-bold text-xs uppercase tracking-widest text-shadow">点击球体变大 / 向上滑动射门</p>
          </div>
      )}

      {/* Energy Max Hint */}
      {energy >= 100 && gameState === GameState.IDLE && !isGameOver && (
           <div className="absolute top-[30%] left-1/2 -translate-x-1/2 animate-bounce pointer-events-none z-30">
              <div className="text-red-500 font-black text-2xl tracking-tighter uppercase drop-shadow-[0_2px_10px_rgba(220,38,38,0.8)] border-2 border-red-500 px-4 py-1 rounded-xl bg-black/50 backdrop-blur -rotate-6">
                  MAX POWER!
              </div>
           </div>
      )}

      <style>{`
        .shake { animation: shake 0.4s cubic-bezier(.36,.07,.19,.97) both; }
        @keyframes shake { 10%, 90% { transform: translate3d(-1px, 0, 0); } 20%, 80% { transform: translate3d(2px, 0, 0); } 30%, 50%, 70% { transform: translate3d(-4px, 0, 0); } 40%, 60% { transform: translate3d(4px, 0, 0); } }
        .text-shadow { text-shadow: 0 2px 4px rgba(0,0,0,0.5); }
      `}</style>
    </div>
  );
};

export default App;
