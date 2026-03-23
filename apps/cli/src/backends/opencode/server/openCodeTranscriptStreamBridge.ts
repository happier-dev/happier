import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';

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
  session: Pick<ApiSessionClient, 'sendAgentMessage' | 'sendAgentMessageCommitted' | 'sendTranscriptDraftDelta'>;
  draftFlushIntervalMs: number;
}) {
  return createKeyedStreamedTranscriptBridge<{
    streamKey: string;
    remoteSessionId: string;
    messageId: string;
    sidechainId: string | null;
  }>({
    provider: params.provider,
    draftFlushIntervalMs: params.draftFlushIntervalMs,
    createSessionForStream: (args) => {
      const baseMeta = buildSidechainMeta(args);
      return {
        sendTranscriptDraftDelta: (provider, draftParams) => params.session.sendTranscriptDraftDelta(provider, draftParams),
        sendAgentMessage: (provider, body, opts) =>
          params.session.sendAgentMessage(provider, body, {
            ...opts,
            meta: {
              ...baseMeta,
              ...(opts?.meta ?? {}),
            },
          }),
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
