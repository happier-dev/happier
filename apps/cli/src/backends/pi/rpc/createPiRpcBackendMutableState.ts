import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { PiRpcStreamReader } from './streamReaders';

export type PiRpcBackendMutableState = Readonly<{
  getProcess: () => ChildProcessWithoutNullStreams | null;
  setProcess: (process: ChildProcessWithoutNullStreams | null) => void;
  getStdoutLineReader: () => PiRpcStreamReader | null;
  setStdoutLineReader: (reader: PiRpcStreamReader | null) => void;
  getStderrLineReader: () => PiRpcStreamReader | null;
  setStderrLineReader: (reader: PiRpcStreamReader | null) => void;
  getSessionId: () => string | null;
  setSessionId: (sessionId: string | null) => void;
  getSessionFile: () => string | null;
  setSessionFile: (sessionFile: string | null) => void;
  getLastAuthJsonMtimeMs: () => number | null;
  setLastAuthJsonMtimeMs: (mtimeMs: number | null) => void;
  getAuthRestartPendingMtimeMs: () => number | null;
  setAuthRestartPendingMtimeMs: (mtimeMs: number | null) => void;
  getAuthRestartInFlight: () => Promise<void> | null;
  setAuthRestartInFlight: (restart: Promise<void> | null) => void;
}>;

export function createPiRpcBackendMutableState(): PiRpcBackendMutableState {
  let process: ChildProcessWithoutNullStreams | null = null;
  let stdoutLineReader: PiRpcStreamReader | null = null;
  let stderrLineReader: PiRpcStreamReader | null = null;
  let sessionId: string | null = null;
  let sessionFile: string | null = null;
  let lastAuthJsonMtimeMs: number | null = null;
  let authRestartPendingMtimeMs: number | null = null;
  let authRestartInFlight: Promise<void> | null = null;

  return {
    getProcess: () => process,
    setProcess: (nextProcess) => {
      process = nextProcess;
    },
    getStdoutLineReader: () => stdoutLineReader,
    setStdoutLineReader: (reader) => {
      stdoutLineReader = reader;
    },
    getStderrLineReader: () => stderrLineReader,
    setStderrLineReader: (reader) => {
      stderrLineReader = reader;
    },
    getSessionId: () => sessionId,
    setSessionId: (nextSessionId) => {
      sessionId = nextSessionId;
    },
    getSessionFile: () => sessionFile,
    setSessionFile: (nextSessionFile) => {
      sessionFile = nextSessionFile;
    },
    getLastAuthJsonMtimeMs: () => lastAuthJsonMtimeMs,
    setLastAuthJsonMtimeMs: (nextMtimeMs) => {
      lastAuthJsonMtimeMs = nextMtimeMs;
    },
    getAuthRestartPendingMtimeMs: () => authRestartPendingMtimeMs,
    setAuthRestartPendingMtimeMs: (nextMtimeMs) => {
      authRestartPendingMtimeMs = nextMtimeMs;
    },
    getAuthRestartInFlight: () => authRestartInFlight,
    setAuthRestartInFlight: (restart) => {
      authRestartInFlight = restart;
    },
  };
}
