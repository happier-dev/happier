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
}>;

export function createCurrentSessionTranscriptPort(
  getSession: () => TranscriptPortSession,
): TranscriptPortSession {
  return {
    sendAgentMessage: (provider, body, opts) => getSession().sendAgentMessage?.(provider, body, opts),
    sendAgentMessageCommitted: (provider, body, opts) => getSession().sendAgentMessageCommitted(provider, body, opts),
  };
}
