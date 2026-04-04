import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';

type FlushReason = 'tool-call-boundary' | 'turn-end' | 'abort';

function buildSidechainMeta(params: {
  streamKey: string;
  remoteSessionId: string;
  messageId: string;
  sidechainId: string | null;
}): Record<string, unknown> {
  if (!params.sidechainId) {
    return {
      happierStreamKey: params.streamKey,
      opencodeMessageId: params.messageId,
      opencodeRemoteSessionId: params.remoteSessionId,
    };
  }

  return {
    happierStreamKey: params.streamKey,
    opencodeMessageId: params.messageId,
    opencodeRemoteSessionId: params.remoteSessionId,
    importedFrom: 'acp-sidechain',
    remoteSessionId: params.remoteSessionId,
    sidechainId: params.sidechainId,
    happierSidechainStreamKey: params.streamKey,
  };
}

export function createOpenCodeTranscriptStreamBridge(params: {
  provider: ACPProvider;
  session: TranscriptSessionPort;
  initialCheckpointDelayMs?: number | null;
  checkpointIntervalMs?: number | null;
  checkpointMinChars?: number | null;
}) {
  return createKeyedStreamedTranscriptBridge<{
    streamKey: string;
    remoteSessionId: string;
    messageId: string;
    sidechainId: string | null;
  }>({
    provider: params.provider,
    initialCheckpointDelayMs: params.initialCheckpointDelayMs,
    checkpointIntervalMs: params.checkpointIntervalMs,
    checkpointMinChars: params.checkpointMinChars,
    createSessionForStream: (args) => {
      const baseMeta = buildSidechainMeta(args);
      return {
        sendAgentMessage:
          typeof params.session.sendAgentMessage === 'function'
            ? (provider, body, opts) =>
                params.session.sendAgentMessage?.(provider, body, {
                  ...opts,
                  meta: {
                    ...baseMeta,
                    ...(opts?.meta ?? {}),
                  },
                })
            : undefined,
        sendAgentMessageEphemeral:
          typeof params.session.sendAgentMessageEphemeral === 'function'
            ? (provider, body, opts) =>
                params.session.sendAgentMessageEphemeral?.(provider, body, {
                  ...opts,
                  meta: {
                    ...baseMeta,
                    ...(opts?.meta ?? {}),
                  },
                })
            : undefined,
        sendAgentMessageCommitted: (provider, body, opts) =>
          params.session.sendAgentMessageCommitted(provider, body, {
            ...opts,
            meta: {
              ...baseMeta,
              ...(opts.meta ?? {}),
            },
          }),
      };
    },
  });
}
