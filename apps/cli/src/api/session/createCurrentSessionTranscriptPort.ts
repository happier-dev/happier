import type { TranscriptSessionPort } from './transcriptPort';

export function createCurrentSessionTranscriptPort(
  getSession: () => TranscriptSessionPort,
): TranscriptSessionPort {
  return {
    get turnAssistantTextSnapshotStore() {
      return getSession().turnAssistantTextSnapshotStore;
    },
    sendAgentMessage: (provider, body, opts) => {
      const session = getSession();
      return session.sendAgentMessage?.call(session, provider, body, opts);
    },
    sendAgentMessageEphemeral: (provider, body, opts) => {
      const session = getSession();
      return session.sendAgentMessageEphemeral?.call(session, provider, body, opts);
    },
    // Delta support is a capability handshake by method presence: only expose these members when
    // the current underlying session actually implements them, so the streamed transcript writer
    // falls back to full snapshots (never emits deltas into a void) for delta-unaware sessions.
    get sendAgentMessageEphemeralDelta() {
      const session = getSession();
      if (typeof session.sendAgentMessageEphemeralDelta !== 'function') return undefined;
      return (
        ...args: Parameters<NonNullable<TranscriptSessionPort['sendAgentMessageEphemeralDelta']>>
      ) => {
        const current = getSession();
        return current.sendAgentMessageEphemeralDelta?.call(current, ...args);
      };
    },
    get getEphemeralStreamConnectionEpoch() {
      const session = getSession();
      if (typeof session.getEphemeralStreamConnectionEpoch !== 'function') return undefined;
      return () => {
        const current = getSession();
        return current.getEphemeralStreamConnectionEpoch?.call(current) ?? 0;
      };
    },
    enqueueAgentMessageCommitted: (provider, body, opts) => {
      const session = getSession();
      const enqueueAgentMessageCommitted = session.enqueueAgentMessageCommitted;
      if (!enqueueAgentMessageCommitted) {
        throw new Error('Current session does not support durable committed transcript enqueue');
      }
      return enqueueAgentMessageCommitted.call(session, provider, body, opts);
    },
    sendAgentMessageCommitted: (provider, body, opts) => {
      const session = getSession();
      return session.sendAgentMessageCommitted.call(session, provider, body, opts);
    },
    sendAgentSessionMediaCommitted: async (provider, request) => {
      const session = getSession();
      const sendAgentSessionMediaCommitted = session.sendAgentSessionMediaCommitted;
      if (!sendAgentSessionMediaCommitted) {
        throw new Error('Current session does not support committed session media messages');
      }
      await sendAgentSessionMediaCommitted.call(session, provider, request);
    },
  };
}
