import { normalizeString } from '../openCodeParsing.js';

export type OpenCodeForegroundToolSource = 'history' | 'live' | 'session-next';

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

export type OpenCodeActiveToolSummary = Readonly<{
  key: string;
  sessionId: string;
  callId: string;
  toolName: string;
  status: string;
  messageId?: string;
  partId?: string;
  sources: readonly OpenCodeForegroundToolSource[];
  observedAtMs: number;
  observedGenerationKey?: string;
}>;

export type OpenCodeForegroundToolClearReason =
  | 'provider_session_reset'
  | 'turn_reset'
  | 'managed_server_generation_replaced';

export type OpenCodeProviderWorkState =
  | Readonly<{ active: false }>
  | Readonly<{
    active: true;
    activeToolCallCount: number;
    activeToolCalls: readonly OpenCodeActiveToolSummary[];
  }>;

type ActiveToolRecord = {
  key: string;
  sessionId: string;
  callId: string;
  toolName: string;
  status: string;
  messageId?: string;
  partId?: string;
  sources: Set<OpenCodeForegroundToolSource>;
  observedAtMs: number;
  observedGenerationKey?: string;
};

export type OpenCodeForegroundToolTracker = ReturnType<typeof createOpenCodeForegroundToolTracker>;

export function buildOpenCodeProviderToolCallKey(remoteSessionId: string, callId: string): string {
  return `${remoteSessionId}:${callId}`;
}

export function readSessionIdFromOpenCodeProviderToolCallKey(callKey: string): string | null {
  const separatorIndex = callKey.indexOf(':');
  if (separatorIndex <= 0) return null;
  return callKey.slice(0, separatorIndex);
}

export function isTerminalOpenCodeToolPartStatus(status: string): boolean {
  return (
    status === 'completed'
    || status === 'error'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'canceled'
    || status === 'aborted'
  );
}

export function createOpenCodeForegroundToolTracker() {
  const activeToolsByKey = new Map<string, ActiveToolRecord>();
  let providerSessionId: string | null = null;
  // The managed-server generation key under which subsequent live/session-next observations are
  // stamped. A generation change (managed server replaced mid-turn) re-stamps surviving work; work
  // observed only under an older generation is orphaned and must not keep a turn alive indefinitely
  // (this closes the F4 wedge where an orphaned non-terminal tool reads as eternal work).
  let observedGenerationKey: string | null = null;

  const resetForProviderSession = (remoteSessionId: string | null): void => {
    providerSessionId = remoteSessionId;
    activeToolsByKey.clear();
  };

  const setObservedGenerationKey = (generationKey: string | null): void => {
    observedGenerationKey = generationKey && generationKey.length > 0 ? generationKey : null;
  };

  const stampObservation = (record: ActiveToolRecord): void => {
    record.observedAtMs = Date.now();
    if (observedGenerationKey) {
      record.observedGenerationKey = observedGenerationKey;
    }
  };

  const observeToolPart = (params: Readonly<{
    part: OpenCodeToolPart;
    source: OpenCodeForegroundToolSource;
    partId?: string | null;
  }>): string => {
    const status = normalizeString(params.part.state.status);
    const key = buildOpenCodeProviderToolCallKey(params.part.sessionID, params.part.callID);
    if (isTerminalOpenCodeToolPartStatus(status)) {
      activeToolsByKey.delete(key);
      return key;
    }

    const existing = activeToolsByKey.get(key);
    const next: ActiveToolRecord = existing ?? {
      key,
      sessionId: params.part.sessionID,
      callId: params.part.callID,
      toolName: params.part.tool,
      status,
      ...(params.part.messageID ? { messageId: params.part.messageID } : {}),
      ...(params.partId ? { partId: params.partId } : {}),
      sources: new Set<OpenCodeForegroundToolSource>(),
      observedAtMs: Date.now(),
    };
    next.status = status;
    next.toolName = params.part.tool;
    if (params.part.messageID) next.messageId = params.part.messageID;
    if (params.partId) next.partId = params.partId;
    next.sources.add(params.source);
    stampObservation(next);
    activeToolsByKey.set(key, next);
    return key;
  };

  const observeSessionNextTool = (params: Readonly<{
    sessionId: string;
    callId: string;
    terminal: boolean;
    source: OpenCodeForegroundToolSource;
  }>): string => {
    const key = buildOpenCodeProviderToolCallKey(params.sessionId, params.callId);
    if (params.terminal) {
      activeToolsByKey.delete(key);
      return key;
    }
    const existing = activeToolsByKey.get(key);
    const next: ActiveToolRecord = existing ?? {
      key,
      sessionId: params.sessionId,
      callId: params.callId,
      toolName: '',
      status: 'running',
      sources: new Set<OpenCodeForegroundToolSource>(),
      observedAtMs: Date.now(),
    };
    next.sources.add(params.source);
    stampObservation(next);
    activeToolsByKey.set(key, next);
    return key;
  };

  const hasActiveProviderWork = (): boolean => activeToolsByKey.size > 0;

  /**
   * Liveness for the generation-aware completion gate / turn-interruption supervisor. Active work
   * counts as live when it is backed by the current generation OR has no generation stamp (observed
   * before a generation was established — not provably orphaned). Only work stamped with a DIFFERENT
   * (replaced) generation is treated as orphaned and excluded, which closes the F4 indefinite-wedge.
   */
  const hasActiveProviderWorkNotOrphanedByGeneration = (currentGenerationKey: string): boolean => {
    if (!currentGenerationKey) return activeToolsByKey.size > 0;
    for (const tool of activeToolsByKey.values()) {
      if (tool.observedGenerationKey === undefined || tool.observedGenerationKey === currentGenerationKey) {
        return true;
      }
    }
    return false;
  };

  const summarizeActiveTool = (tool: ActiveToolRecord): OpenCodeActiveToolSummary => ({
    key: tool.key,
    sessionId: tool.sessionId,
    callId: tool.callId,
    toolName: tool.toolName,
    status: tool.status,
    ...(tool.messageId ? { messageId: tool.messageId } : {}),
    ...(tool.partId ? { partId: tool.partId } : {}),
    sources: Array.from(tool.sources),
    observedAtMs: tool.observedAtMs,
    ...(tool.observedGenerationKey ? { observedGenerationKey: tool.observedGenerationKey } : {}),
  });

  const buildWorkState = (records: readonly ActiveToolRecord[]): OpenCodeProviderWorkState => {
    if (records.length === 0) return { active: false };
    const activeToolCalls = records.map((tool) => summarizeActiveTool(tool));
    return {
      active: true,
      activeToolCallCount: activeToolCalls.length,
      activeToolCalls,
    };
  };

  const getProviderWorkState = (): OpenCodeProviderWorkState =>
    buildWorkState(Array.from(activeToolsByKey.values()));

  /**
   * Drop provider work for an interrupted/orphaned turn. With a generation key, only work observed
   * under a DIFFERENT generation is cleared so genuine current-generation work survives; without one,
   * clear everything. Returns the cleared work for diagnostics.
   */
  const clearActiveWork = (params: Readonly<{
    reason: OpenCodeForegroundToolClearReason;
    generationKey?: string | null;
  }>): OpenCodeProviderWorkState => {
    const generationKey = params.generationKey && params.generationKey.length > 0 ? params.generationKey : null;
    const cleared: ActiveToolRecord[] = [];
    for (const [key, record] of [...activeToolsByKey.entries()]) {
      if (generationKey && record.observedGenerationKey === generationKey) continue;
      activeToolsByKey.delete(key);
      cleared.push(record);
    }
    return buildWorkState(cleared);
  };

  const getActiveSessionIds = (): readonly string[] => {
    const sessionIds = new Set<string>();
    for (const key of activeToolsByKey.keys()) {
      const sessionId = readSessionIdFromOpenCodeProviderToolCallKey(key);
      if (sessionId) sessionIds.add(sessionId);
    }
    if (providerSessionId) sessionIds.add(providerSessionId);
    return Array.from(sessionIds);
  };

  return {
    resetForProviderSession,
    setObservedGenerationKey,
    observeToolPart,
    observeSessionNextTool,
    hasActiveProviderWork,
    hasActiveProviderWorkNotOrphanedByGeneration,
    getProviderWorkState,
    clearActiveWork,
    getActiveSessionIds,
  };
}
