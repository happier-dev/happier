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

type ActiveTool = {
  callId: string;
  generationKey?: string;
};

export function isTerminalOpenCodeToolPartStatus(status: string): boolean {
  return status === 'completed'
    || status === 'error'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'canceled'
    || status === 'aborted';
}

export function createOpenCodeForegroundToolTracker() {
  const activeTools = new Map<string, ActiveTool>();
  let generationKey: string | null = null;

  const observeToolPart = (params: Readonly<{
    part: OpenCodeToolPart;
  }>): string => {
    const key = `${params.part.sessionID}:${params.part.callID}`;
    if (isTerminalOpenCodeToolPartStatus(normalizeString(params.part.state.status))) {
      activeTools.delete(key);
      return key;
    }
    activeTools.set(key, {
      callId: params.part.callID,
      ...(generationKey ? { generationKey } : {}),
    });
    return key;
  };

  const hasActiveToolCalls = (): boolean => activeTools.size > 0;

  const hasActiveToolCallsForGeneration = (currentGenerationKey: string): boolean => {
    for (const tool of activeTools.values()) {
      if (tool.generationKey === undefined || tool.generationKey === currentGenerationKey) return true;
    }
    return false;
  };

  const clearOrphanedToolCalls = (currentGenerationKey: string | null): void => {
    if (!currentGenerationKey) {
      activeTools.clear();
      return;
    }
    for (const [key, tool] of activeTools) {
      if (tool.generationKey !== currentGenerationKey) activeTools.delete(key);
    }
  };

  return {
    observeToolPart,
    hasActiveToolCalls,
    hasActiveToolCallsForGeneration,
    setGenerationKey(value: string | null) {
      generationKey = value && value.length > 0 ? value : null;
    },
    clearOrphanedToolCalls,
    reset() {
      activeTools.clear();
    },
    describe() {
      return activeTools.size === 0
        ? { active: false as const }
        : { active: true as const, activeToolCallCount: activeTools.size };
    },
  };
}

export type OpenCodeForegroundToolTracker = ReturnType<typeof createOpenCodeForegroundToolTracker>;
