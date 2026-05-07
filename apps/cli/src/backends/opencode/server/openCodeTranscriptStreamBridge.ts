import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import {
  createOpenCodeTranscriptStreamSession,
  type OpenCodeTranscriptStreamSessionSource,
} from './createOpenCodeTranscriptStreamSession';

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
  session: OpenCodeTranscriptStreamSessionSource;
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
    checkpointIntervalMs: params.checkpointIntervalMs,
    checkpointMinChars: params.checkpointMinChars,
    createSessionForStream: (args) => {
      const baseMeta = buildSidechainMeta(args);
      return createOpenCodeTranscriptStreamSession({
        session: params.session,
        baseMeta,
      });
    },
  });
}
