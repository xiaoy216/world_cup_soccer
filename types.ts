
export enum GameState {
  IDLE = 'IDLE',
  DRAGGING = 'DRAGGING',
  KICKED = 'KICKED',
  RESULT = 'RESULT'
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface GameMetrics {
  score: number;
  streak: number;
  bestStreak: number;
  attempts: number;
}
