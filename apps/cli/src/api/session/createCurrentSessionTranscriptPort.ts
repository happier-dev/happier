import type { TranscriptSessionPort } from './transcriptPort';

export function createCurrentSessionTranscriptPort(
  getSession: () => TranscriptSessionPort,
): TranscriptSessionPort {
  return {
    sendAgentMessage: (provider, body, opts) => getSession().sendAgentMessage?.(provider, body, opts),
    sendAgentMessageEphemeral: (provider, body, opts) => getSession().sendAgentMessageEphemeral?.(provider, body, opts),
    sendAgentMessageCommitted: (provider, body, opts) => getSession().sendAgentMessageCommitted(provider, body, opts),
  };
}
