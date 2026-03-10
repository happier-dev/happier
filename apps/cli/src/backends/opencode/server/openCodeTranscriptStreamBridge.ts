import { createStreamedTranscriptWriter, type StreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
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
  const writerByStreamKey = new Map<string, StreamedTranscriptWriter>();

  const getOrCreateWriter = (args: {
    streamKey: string;
    remoteSessionId: string;
    messageId: string;
    sidechainId: string | null;
  }): StreamedTranscriptWriter => {
    const existing = writerByStreamKey.get(args.streamKey);
    if (existing) return existing;

    const baseMeta = buildSidechainMeta(args);
    const writer = createStreamedTranscriptWriter({
      provider: params.provider,
      session: {
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
      },
      draftFlushIntervalMs: params.draftFlushIntervalMs,
    });

    writerByStreamKey.set(args.streamKey, writer);
    return writer;
  };

  return {
    appendAssistantDelta(args: {
      deltaText: string;
      streamKey: string;
      remoteSessionId: string;
      messageId: string;
      sidechainId: string | null;
    }) {
      getOrCreateWriter(args).appendAssistantDelta(args.deltaText, { sidechainId: args.sidechainId });
    },

    appendThinkingDelta(args: {
      deltaText: string;
      streamKey: string;
      remoteSessionId: string;
      messageId: string;
      sidechainId: string | null;
    }) {
      getOrCreateWriter(args).appendThinkingDelta(args.deltaText, { sidechainId: args.sidechainId });
    },

    async flushAll(args: { reason: FlushReason; interruptedReason?: string }) {
      await Promise.all(Array.from(writerByStreamKey.values(), (writer) => writer.flushAll(args)));
      writerByStreamKey.clear();
    },

    clear() {
      writerByStreamKey.clear();
    },
  };
}
