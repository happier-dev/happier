import { normalizeString } from '../openCodeParsing.js';

export type OpenCodeProviderActivitySource = 'history' | 'live' | 'session-next';

export type OpenCodeToolPart = Readonly<{
  sessionID: string;
  callID: string;
  tool: string;
  messageID?: string;
  state: Readonly<{
    status: string;
    input?: unknown;
    output?: unknown;
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
  sources: readonly OpenCodeProviderActivitySource[];
}>;

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
  sources: Set<OpenCodeProviderActivitySource>;
};

export type OpenCodeProviderActivityTracker = ReturnType<typeof createOpenCodeProviderActivityTracker>;

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

export function createOpenCodeProviderActivityTracker() {
  const activeToolsByKey = new Map<string, ActiveToolRecord>();
  let providerSessionId: string | null = null;

  const resetForProviderSession = (remoteSessionId: string | null): void => {
    providerSessionId = remoteSessionId;
    activeToolsByKey.clear();
  };

  const observeToolPart = (params: Readonly<{
    part: OpenCodeToolPart;
    source: OpenCodeProviderActivitySource;
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
      sources: new Set<OpenCodeProviderActivitySource>(),
    };
    next.status = status;
    next.toolName = params.part.tool;
    if (params.part.messageID) next.messageId = params.part.messageID;
    if (params.partId) next.partId = params.partId;
    next.sources.add(params.source);
    activeToolsByKey.set(key, next);
    return key;
  };

  const observeSessionNextTool = (params: Readonly<{
    sessionId: string;
    callId: string;
    terminal: boolean;
    source: OpenCodeProviderActivitySource;
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
      sources: new Set<OpenCodeProviderActivitySource>(),
    };
    next.sources.add(params.source);
    activeToolsByKey.set(key, next);
    return key;
  };

  const hasActiveProviderWork = (): boolean => activeToolsByKey.size > 0;

  const getProviderWorkState = (): OpenCodeProviderWorkState => {
    if (activeToolsByKey.size === 0) return { active: false };
    const activeToolCalls = Array.from(activeToolsByKey.values()).map((tool) => ({
      key: tool.key,
      sessionId: tool.sessionId,
      callId: tool.callId,
      toolName: tool.toolName,
      status: tool.status,
      ...(tool.messageId ? { messageId: tool.messageId } : {}),
      ...(tool.partId ? { partId: tool.partId } : {}),
      sources: Array.from(tool.sources),
    }));
    return {
      active: true,
      activeToolCallCount: activeToolCalls.length,
      activeToolCalls,
    };
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
    observeToolPart,
    observeSessionNextTool,
    hasActiveProviderWork,
    getProviderWorkState,
    getActiveSessionIds,
  };
}
