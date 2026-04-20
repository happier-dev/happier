import type { PiRpcStateData } from './types';
import type { PiRpcSessionStateContext } from './sessionState';

export function createPiRpcSessionStateContext(params: Readonly<{
  options: Readonly<{
    cwd: string;
    command: string;
    args: string[];
    env: Record<string, string>;
  }>;
  isDisposed: () => boolean;
  getSessionId: () => string | null;
  setSessionId: (sessionId: string | null) => void;
  getSessionFile: () => string | null;
  setSessionFile: (sessionFile: string | null) => void;
  hasPendingTurn: () => boolean;
  emitStartingStatus: () => void;
  emitIdleStatus: () => void;
  ensureProcess: () => Promise<void>;
  stopRpcProcessForRestart: () => Promise<void>;
  spawnRpcProcess: (params: Readonly<{ args: string[] }>) => void;
  captureAuthJsonSnapshot: () => Promise<void>;
  createSession: () => Promise<void>;
  getState: () => Promise<PiRpcStateData>;
  publishRuntimeState: (state: PiRpcStateData) => Promise<void>;
}>): PiRpcSessionStateContext {
  return {
    options: params.options,
    isDisposed: params.isDisposed,
    getSessionId: params.getSessionId,
    setSessionId: params.setSessionId,
    getSessionFile: params.getSessionFile,
    setSessionFile: params.setSessionFile,
    hasPendingTurn: params.hasPendingTurn,
    emitStartingStatus: params.emitStartingStatus,
    emitIdleStatus: params.emitIdleStatus,
    ensureProcess: params.ensureProcess,
    stopRpcProcessForRestart: params.stopRpcProcessForRestart,
    spawnRpcProcess: params.spawnRpcProcess,
    captureAuthJsonSnapshot: params.captureAuthJsonSnapshot,
    createSession: params.createSession,
    getState: params.getState,
    publishRuntimeState: params.publishRuntimeState,
  };
}
