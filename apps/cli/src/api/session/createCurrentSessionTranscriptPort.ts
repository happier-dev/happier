import type { ACPMessageData, ACPProvider } from './sessionMessageTypes';
import type { EphemeralSendResult } from './ephemeralSendOutcome';
import { createUnavailableEphemeralSendOutcome } from './ephemeralSendOutcome';
import type { StreamedTranscriptCommitOptions, StreamedTranscriptEnqueueOptions, StreamedTranscriptWriterSession } from './streamedTranscriptWriter/types';

type TranscriptPortSession = Readonly<{
  subscribeToSessionConnectionState?: StreamedTranscriptWriterSession['subscribeToSessionConnectionState'];
  sendAgentMessage?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts?: { localId?: string; meta?: Record<string, unknown> },
  ) => void;
  sendAgentMessageCommitted: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: StreamedTranscriptCommitOptions,
  ) => Promise<void>;
  enqueueAgentMessageCommitted?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: StreamedTranscriptEnqueueOptions,
  ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  sendAgentMessageEphemeral?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown>; tick?: number },
  ) => EphemeralSendResult;
  sendAgentMessageEphemeralDelta?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; tick: number; baseLength: number; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
  ) => EphemeralSendResult;
  getEphemeralStreamConnectionEpoch?: () => number;
}>;

export function createCurrentSessionTranscriptPort(
  getSession: () => TranscriptPortSession,
): TranscriptPortSession {
  const readEpoch = (session: TranscriptPortSession): number => {
    const epoch = session.getEphemeralStreamConnectionEpoch?.();
    return typeof epoch === 'number' && Number.isFinite(epoch) && epoch >= 0
      ? Math.trunc(epoch)
      : 0;
  };

  const markSessionReplacement = (): EphemeralSendResult => ({
    accepted: false,
    epoch: readEpoch(getSession()),
    reason: { code: 'connection_epoch_changed' },
  });

  const preserveCurrentSessionOutcome = (
    selectedSession: TranscriptPortSession,
    result: EphemeralSendResult,
  ): EphemeralSendResult => {
    if (typeof (result as PromiseLike<unknown>)?.then === 'function') {
      return Promise.resolve(result).then((outcome) => (
        getSession() === selectedSession ? outcome : markSessionReplacement()
      ));
    }
    return getSession() === selectedSession ? result : markSessionReplacement();
  };

  return {
    get subscribeToSessionConnectionState() {
      const session = getSession();
      return session.subscribeToSessionConnectionState?.bind(session);
    },
    sendAgentMessage: (provider, body, opts) => getSession().sendAgentMessage?.(provider, body, opts),
    sendAgentMessageCommitted: (provider, body, opts) => getSession().sendAgentMessageCommitted(provider, body, opts),
    get enqueueAgentMessageCommitted() {
      if (typeof getSession().enqueueAgentMessageCommitted !== 'function') return undefined;
      return (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: StreamedTranscriptEnqueueOptions,
      ) => getSession().enqueueAgentMessageCommitted?.(provider, body, opts) ?? Promise.resolve({ persisted: false, delivered: false });
    },
    get sendAgentMessageEphemeral() {
      if (typeof getSession().sendAgentMessageEphemeral !== 'function') return undefined;
      return (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown>; tick?: number },
      ) => {
        const session = getSession();
        const result = session.sendAgentMessageEphemeral?.(provider, body, opts);
        return result === undefined
          ? createUnavailableEphemeralSendOutcome(readEpoch(session))
          : preserveCurrentSessionOutcome(session, result);
      };
    },
    get sendAgentMessageEphemeralDelta() {
      if (typeof getSession().sendAgentMessageEphemeralDelta !== 'function') return undefined;
      return (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; tick: number; baseLength: number; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
      ) => {
        const session = getSession();
        const result = session.sendAgentMessageEphemeralDelta?.(provider, body, opts);
        return result === undefined
          ? createUnavailableEphemeralSendOutcome(readEpoch(session))
          : preserveCurrentSessionOutcome(session, result);
      };
    },
    get getEphemeralStreamConnectionEpoch() {
      if (typeof getSession().getEphemeralStreamConnectionEpoch !== 'function') return undefined;
      return () => getSession().getEphemeralStreamConnectionEpoch?.() ?? 0;
    },
  };
}
