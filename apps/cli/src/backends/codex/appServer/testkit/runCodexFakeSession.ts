import { vi } from 'vitest';

/**
 * Session-client double for `runCodex` integration tests that drive the real app-server runtime
 * against a fake Codex process. Only the API session client is faked; Codex runs for real.
 */
export type RunCodexFakeSession = {
  sessionId: string;
  rpcHandlerManager: {
    registerHandler: ReturnType<typeof vi.fn>;
    invokeLocal: ReturnType<typeof vi.fn>;
  };
  onUserMessage: ReturnType<typeof vi.fn>;
  sendSessionEvent: ReturnType<typeof vi.fn>;
  keepAlive: ReturnType<typeof vi.fn>;
  sendSessionDeath: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  updateAgentState: ReturnType<typeof vi.fn>;
  updateMetadata: ReturnType<typeof vi.fn>;
  getMetadataSnapshot: ReturnType<typeof vi.fn>;
  fetchLatestUserPermissionIntentFromTranscript: ReturnType<typeof vi.fn>;
  waitForMetadataUpdate: ReturnType<typeof vi.fn>;
  popPendingMessage: ReturnType<typeof vi.fn>;
  sendCodexMessage: ReturnType<typeof vi.fn>;
  sendAgentMessage: ReturnType<typeof vi.fn>;
  getLastObservedMessageSeq: ReturnType<typeof vi.fn>;
  getLastObservedUserMessageSeq: ReturnType<typeof vi.fn>;
  markObservedUserMessage: ReturnType<typeof vi.fn>;
  beginTurnAssistantTextSnapshot: ReturnType<typeof vi.fn>;
};

export function createRunCodexFakeSession(initialMetadata: Record<string, unknown>): {
  session: RunCodexFakeSession;
  getMetadataSnapshot: () => Record<string, unknown>;
} {
  let metadata = { ...initialMetadata };
  let lastObservedMessageSeq = 0;
  let lastObservedUserMessageSeq = 0;

  const session = {
    sessionId: 'sess_1',
    rpcHandlerManager: {
      registerHandler: vi.fn(),
      invokeLocal: vi.fn(),
    },
    onUserMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    keepAlive: vi.fn(),
    sendSessionDeath: vi.fn(),
    close: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    updateAgentState: vi.fn((updater: (state: Record<string, unknown>) => Record<string, unknown>) => updater({})),
    updateMetadata: vi.fn((updater: (current: Record<string, unknown>) => Record<string, unknown>) => {
      metadata = updater(metadata);
      return metadata;
    }),
    getMetadataSnapshot: vi.fn(() => metadata),
    fetchLatestUserPermissionIntentFromTranscript: vi.fn(async () => null),
    waitForMetadataUpdate: vi.fn(async () => false),
    popPendingMessage: vi.fn(async () => false),
    sendCodexMessage: vi.fn(() => {
      lastObservedMessageSeq += 1;
    }),
    sendAgentMessage: vi.fn(() => {
      lastObservedMessageSeq += 1;
    }),
    getLastObservedMessageSeq: vi.fn(() => lastObservedMessageSeq),
    getLastObservedUserMessageSeq: vi.fn(() => lastObservedUserMessageSeq),
    markObservedUserMessage: vi.fn(() => {
      lastObservedUserMessageSeq += 1;
      lastObservedMessageSeq = Math.max(lastObservedMessageSeq, lastObservedUserMessageSeq);
    }),
    beginTurnAssistantTextSnapshot: vi.fn(() => 'turn-token'),
  };

  return {
    session,
    getMetadataSnapshot: () => metadata,
  };
}
