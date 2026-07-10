import type { TerminalHostHandle } from '@happier-dev/plugin-sdk/experimental/runtime/session';

export type ClaudeUnifiedTerminalRuntimeState = {
  activePromptText: string | null;
  activeTurnId: string | null;
  dispatchAttemptInFlight: boolean;
  disposed: boolean;
  handle: TerminalHostHandle | null;
  lastTurnFailure: Error | null;
  providerSessionId: string | null;
  providerAccepted: boolean;
  promptNonce: number;
  terminalOriginTurnInFlight: boolean;
  turnInFlight: boolean;
  turnCompleted: boolean;
};

export function createClaudeUnifiedTerminalRuntimeState(): ClaudeUnifiedTerminalRuntimeState {
  return {
    activePromptText: null,
    activeTurnId: null,
    dispatchAttemptInFlight: false,
    disposed: false,
    handle: null,
    lastTurnFailure: null,
    providerSessionId: null,
    providerAccepted: false,
    promptNonce: 0,
    terminalOriginTurnInFlight: false,
    turnInFlight: false,
    turnCompleted: false,
  };
}
