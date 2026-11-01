import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { EphemeralSendResult } from '@/api/session/ephemeralSendOutcome';
import type { SessionTranscriptObservationProvenanceV1 } from '@happier-dev/protocol';

type StreamedTranscriptEphemeralOptions = Readonly<{
  localId: string;
  createdAt: number;
  updatedAt?: number;
  meta?: Record<string, unknown>;
  tick?: number;
}>;

type StreamedTranscriptEphemeralDeltaOptions = Readonly<{
  localId: string;
  tick: number;
  baseLength: number;
  createdAt: number;
  updatedAt?: number;
  meta?: Record<string, unknown>;
}>;

export type OpenCodeTranscriptStreamSessionSource = Readonly<{
  subscribeToSessionConnectionState?: StreamedTranscriptWriterSession['subscribeToSessionConnectionState'];
  sendAgentMessage: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts?: { localId?: string; meta?: Record<string, unknown> },
  ) => void;
  sendAgentMessageCommitted: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; meta?: Record<string, unknown> },
  ) => Promise<void>;
  enqueueAgentMessageCommitted?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: {
      localId: string;
      meta?: Record<string, unknown>;
      provenance: SessionTranscriptObservationProvenanceV1;
    },
  ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  sendAgentMessageEphemeral?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: StreamedTranscriptEphemeralOptions,
  ) => EphemeralSendResult;
  sendAgentMessageEphemeralDelta?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: StreamedTranscriptEphemeralDeltaOptions,
  ) => EphemeralSendResult;
  getEphemeralStreamConnectionEpoch?: () => number;
}>;

export type OpenCodeTranscriptStreamSession = StreamedTranscriptWriterSession & Readonly<{
  sendAgentMessageEphemeral?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: StreamedTranscriptEphemeralOptions,
  ) => EphemeralSendResult;
}>;

function mergeBaseMeta(
  baseMeta: Record<string, unknown>,
  optsMeta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...baseMeta,
    ...(optsMeta ?? {}),
  };
}
export function createOpenCodeTranscriptStreamSession(params: Readonly<{
  session: OpenCodeTranscriptStreamSessionSource;
  baseMeta: Record<string, unknown>;
}>): OpenCodeTranscriptStreamSession {
  const sendEphemeral = params.session.sendAgentMessageEphemeral?.bind(params.session);
  const sendEphemeralDelta = params.session.sendAgentMessageEphemeralDelta?.bind(params.session);
  return {
    subscribeToSessionConnectionState: params.session.subscribeToSessionConnectionState?.bind(params.session),
    sendAgentMessage: (provider, body, opts) =>
      params.session.sendAgentMessage(provider, body, {
        ...opts,
        meta: mergeBaseMeta(params.baseMeta, opts?.meta),
      }),
    sendAgentMessageCommitted: (provider, body, opts) =>
      params.session.sendAgentMessageCommitted(provider, body, {
        ...opts,
        meta: mergeBaseMeta(params.baseMeta, opts.meta),
      }),
    ...(typeof params.session.enqueueAgentMessageCommitted === 'function'
      ? {
	          enqueueAgentMessageCommitted: (provider, body, opts) =>
	            params.session.enqueueAgentMessageCommitted?.(provider, body, {
	              ...opts,
	              meta: mergeBaseMeta(params.baseMeta, opts.meta),
	            }) ?? Promise.resolve({ persisted: false, delivered: false }),
	        }
      : {}),
    ...(typeof sendEphemeral === 'function'
      ? {
          sendAgentMessageEphemeral: (provider, body, opts) =>
            sendEphemeral(provider, body, {
              ...opts,
              meta: mergeBaseMeta(params.baseMeta, opts.meta),
            }),
        }
      : {}),
    ...(typeof sendEphemeralDelta === 'function'
      ? {
          sendAgentMessageEphemeralDelta: (
            provider: ACPProvider,
            body: ACPMessageData,
            opts: StreamedTranscriptEphemeralDeltaOptions,
          ) => sendEphemeralDelta(provider, body, {
            ...opts,
            meta: mergeBaseMeta(params.baseMeta, opts.meta),
          }),
        }
      : {}),
    ...(typeof params.session.getEphemeralStreamConnectionEpoch === 'function'
      ? {
          getEphemeralStreamConnectionEpoch: () => params.session.getEphemeralStreamConnectionEpoch?.() ?? 0,
        }
      : {}),
  };
}
