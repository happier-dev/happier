import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';

type StreamedTranscriptEphemeralOptions = Readonly<{
  localId: string;
  createdAt: number;
  updatedAt?: number;
  meta?: Record<string, unknown>;
}>;

export type OpenCodeTranscriptStreamSessionSource = Readonly<{
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
  sendAgentMessageEphemeral?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: StreamedTranscriptEphemeralOptions,
  ) => void | Promise<void>;
}>;

export type OpenCodeTranscriptStreamSession = StreamedTranscriptWriterSession & Readonly<{
  sendAgentMessageEphemeral?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: StreamedTranscriptEphemeralOptions,
  ) => void | Promise<void>;
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
  return {
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
    ...(typeof params.session.sendAgentMessageEphemeral === 'function'
      ? {
          sendAgentMessageEphemeral: (provider, body, opts) =>
            params.session.sendAgentMessageEphemeral?.(provider, body, {
              ...opts,
              meta: mergeBaseMeta(params.baseMeta, opts.meta),
            }),
        }
      : {}),
  };
}
