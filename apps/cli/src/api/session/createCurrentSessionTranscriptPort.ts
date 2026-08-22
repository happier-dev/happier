import type { TranscriptSessionPort } from './transcriptPort';
import {
  createEphemeralSendFailure,
  normalizeEphemeralSendOutcome,
  type EphemeralSendOutcome,
  type EphemeralSendResult,
} from './client/transcript/ephemeralSendOutcome';

function readUnderlyingEpoch(session: TranscriptSessionPort): Readonly<{
  available: boolean;
  epoch: number;
  error?: unknown;
}> {
  try {
    const epoch = session.getEphemeralStreamConnectionEpoch?.call(session);
    return typeof epoch === 'number' && Number.isFinite(epoch) && epoch >= 0
      ? { available: true, epoch: Math.trunc(epoch) }
      : { available: false, epoch: 0 };
  } catch (error) {
    return { available: false, epoch: 0, error };
  }
}

async function forwardEphemeralSend(params: Readonly<{
  selected: Readonly<{
    session: TranscriptSessionPort;
    underlyingEpoch: number;
    facadeEpoch: number;
    supportsEpoch: boolean;
    epochAvailable: boolean;
    epochReadError?: unknown;
  }>;
  selectCurrent: () => Readonly<{
    session: TranscriptSessionPort;
    underlyingEpoch: number;
    facadeEpoch: number;
    supportsEpoch: boolean;
    epochAvailable: boolean;
    epochReadError?: unknown;
  }>;
  send: () => EphemeralSendResult | undefined;
}>): Promise<EphemeralSendOutcome> {
  let raw: unknown;
  try {
    raw = await params.send();
  } catch (error) {
    return createEphemeralSendFailure('transport_unavailable', params.selectCurrent().facadeEpoch, error);
  }
  const current = params.selectCurrent();
  if (
    current.session !== params.selected.session
    || current.underlyingEpoch !== params.selected.underlyingEpoch
  ) {
    return createEphemeralSendFailure('connection_epoch_changed', current.facadeEpoch);
  }
  const normalized = normalizeEphemeralSendOutcome(raw, params.selected.underlyingEpoch);
  if (!normalized.accepted) {
    return {
      ...normalized,
      epoch: current.facadeEpoch,
    };
  }
  if (params.selected.supportsEpoch && normalized.epoch !== params.selected.underlyingEpoch) {
    return createEphemeralSendFailure('connection_epoch_changed', current.facadeEpoch);
  }
  return {
    accepted: true,
    epoch: params.selected.supportsEpoch ? current.facadeEpoch : normalized.epoch,
  };
}

export function createCurrentSessionTranscriptPort(
  getSession: () => TranscriptSessionPort,
): TranscriptSessionPort {
  let lastSession: TranscriptSessionPort | null = null;
  let lastUnderlyingEpoch = 0;
  let facadeEpoch = 0;

  const selectCurrent = () => {
    const session = getSession();
    const supportsEpoch = typeof session.getEphemeralStreamConnectionEpoch === 'function';
    const underlying = readUnderlyingEpoch(session);
    const underlyingEpoch = underlying.epoch;
    if (lastSession === null) {
      facadeEpoch = underlyingEpoch;
    } else if (session !== lastSession || underlyingEpoch !== lastUnderlyingEpoch) {
      facadeEpoch = Math.max(facadeEpoch + 1, underlyingEpoch);
    }
    lastSession = session;
    lastUnderlyingEpoch = underlyingEpoch;
    return {
      session,
      underlyingEpoch,
      facadeEpoch,
      supportsEpoch,
      epochAvailable: !supportsEpoch || underlying.available,
      ...(underlying.error === undefined ? {} : { epochReadError: underlying.error }),
    } as const;
  };

  return {
    get turnAssistantTextSnapshotStore() {
      return getSession().turnAssistantTextSnapshotStore;
    },
    sendAgentMessageEphemeral: (provider, body, opts) => {
      const selected = selectCurrent();
      if (!selected.epochAvailable) {
        return createEphemeralSendFailure(
          'transport_unavailable',
          selected.facadeEpoch,
          selected.epochReadError,
        );
      }
      const send = selected.session.sendAgentMessageEphemeral;
      if (typeof send !== 'function') {
        return createEphemeralSendFailure('transport_unavailable', selected.facadeEpoch);
      }
      return forwardEphemeralSend({
        selected,
        selectCurrent,
        send: () => send.call(selected.session, provider, body, opts),
      });
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
        const selected = selectCurrent();
        if (!selected.epochAvailable) {
          return createEphemeralSendFailure(
            'transport_unavailable',
            selected.facadeEpoch,
            selected.epochReadError,
          );
        }
        const send = selected.session.sendAgentMessageEphemeralDelta;
        if (typeof send !== 'function') {
          return createEphemeralSendFailure('transport_unavailable', selected.facadeEpoch);
        }
        return forwardEphemeralSend({
          selected,
          selectCurrent,
          send: () => send.call(selected.session, ...args),
        });
      };
    },
    get getEphemeralStreamConnectionEpoch() {
      const session = getSession();
      if (typeof session.getEphemeralStreamConnectionEpoch !== 'function') return undefined;
      return () => {
        return selectCurrent().facadeEpoch;
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
