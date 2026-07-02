import type { TranscriptSessionPort } from './transcriptPort';

export function createCurrentSessionTranscriptPort(
  getSession: () => TranscriptSessionPort,
): TranscriptSessionPort {
  return {
    get turnAssistantTextSnapshotStore() {
      return getSession().turnAssistantTextSnapshotStore;
    },
    sendAgentMessage: (provider, body, opts) => getSession().sendAgentMessage?.(provider, body, opts),
    sendAgentMessageEphemeral: (provider, body, opts) => getSession().sendAgentMessageEphemeral?.(provider, body, opts),
    enqueueAgentMessageCommitted: (provider, body, opts) => {
      const enqueueAgentMessageCommitted = getSession().enqueueAgentMessageCommitted;
      if (!enqueueAgentMessageCommitted) {
        throw new Error('Current session does not support durable committed transcript enqueue');
      }
      return enqueueAgentMessageCommitted(provider, body, opts);
    },
    sendAgentMessageCommitted: (provider, body, opts) => getSession().sendAgentMessageCommitted(provider, body, opts),
    sendAgentSessionMediaCommitted: async (provider, request) => {
      const sendAgentSessionMediaCommitted = getSession().sendAgentSessionMediaCommitted;
      if (!sendAgentSessionMediaCommitted) {
        throw new Error('Current session does not support committed session media messages');
      }
      await sendAgentSessionMediaCommitted(provider, request);
    },
  };
}
