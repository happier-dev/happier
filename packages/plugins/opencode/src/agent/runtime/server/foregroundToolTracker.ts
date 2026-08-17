import { normalizeString } from './openCodeParsing.js';

export type OpenCodeToolPart = Readonly<{
  sessionID: string;
  callID: string;
  tool: string;
  messageID?: string;
  state: Readonly<{
    status: string;
    input?: unknown;
    output?: unknown;
    title?: string;
    metadata?: unknown;
  }>;
}>;

export function isTerminalOpenCodeToolPartStatus(status: string): boolean {
  return status === 'completed'
    || status === 'error'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'canceled'
    || status === 'aborted';
}

export function createOpenCodeForegroundToolTracker() {
  const activeToolKeys = new Set<string>();

  const observeToolPart = (params: Readonly<{
    part: OpenCodeToolPart;
  }>): string => {
    const key = `${params.part.sessionID}:${params.part.callID}`;
    if (isTerminalOpenCodeToolPartStatus(normalizeString(params.part.state.status))) {
      activeToolKeys.delete(key);
      return key;
    }
    activeToolKeys.add(key);
    return key;
  };

  const hasActiveToolCalls = (): boolean => activeToolKeys.size > 0;

  return {
    observeToolPart,
    hasActiveToolCalls,
    reset() {
      activeToolKeys.clear();
    },
    describe() {
      return activeToolKeys.size === 0
        ? { active: false as const }
        : { active: true as const, activeToolCallCount: activeToolKeys.size };
    },
  };
}

export type OpenCodeForegroundToolTracker = ReturnType<typeof createOpenCodeForegroundToolTracker>;
