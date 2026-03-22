import type { ACPMessageData, ACPProvider } from './sessionMessageTypes';

type TranscriptPortSession = Readonly<{
  sendAgentMessage?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts?: { localId?: string; meta?: Record<string, unknown> },
  ) => void;
  sendAgentMessageCommitted: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; meta?: Record<string, unknown> },
  ) => Promise<void>;
  sendTranscriptDraftDelta: (
    provider: ACPProvider,
    params: {
      localId: string;
      segmentKind: 'assistant' | 'thinking';
      sidechainId: string | null;
      deltaText: string;
      createdAtMs: number;
    },
  ) => void;
}>;

export function createCurrentSessionTranscriptPort(
  getSession: () => TranscriptPortSession,
): TranscriptPortSession {
  return {
    sendAgentMessage: (provider, body, opts) => getSession().sendAgentMessage?.(provider, body, opts),
    sendAgentMessageCommitted: (provider, body, opts) => getSession().sendAgentMessageCommitted(provider, body, opts),
    sendTranscriptDraftDelta: (provider, params) => getSession().sendTranscriptDraftDelta(provider, params),
  };
}
