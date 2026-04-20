import {
    prepareCodexTranscriptDispatch,
} from '@/api/session/outbound/providers/sessionTranscriptDispatch';
import {
    recordCodexToolTraceEventIfNeeded,
} from '@/api/session/toolTrace';
import { applyCodexPostSendReactions } from '@/api/session/client/reactions/providers/applyCodexPostSendReactions';
import type { PostSendReactionPort } from '@/api/session/client/reactions/providers/postSendReactionPort';
import type { SessionClientTranscriptSendPort } from '@/api/session/client/transcript/sendMessages';

export function sendCodexSessionClientMessage(
    port: SessionClientTranscriptSendPort,
    body: unknown,
    opts?: Readonly<{
        sessionId?: string;
        postSendReactionPort?: PostSendReactionPort;
    }>,
): Readonly<{
    normalizedBody: any;
    backendMode: string | null;
    externalKey: string | null;
}> {
    const { normalizedBody, content, localId, backendMode, externalKey } = prepareCodexTranscriptDispatch({
        body,
        metadata: port.getMetadataSnapshot(),
        toolCallCanonicalNameByProviderAndId: port.toolCallCanonicalNameByProviderAndId,
        debug: port.debug,
    });

    port.logSendWhileDisconnected('Codex message', { type: normalizedBody?.type });

    const payload = port.buildOutboundSessionMessagePayload(content);
    port.commitSessionMessageBestEffort({
        message: payload,
        localId,
        sidechainId: null,
        logErrorMessage: '[SOCKET] Failed to commit Codex message (non-fatal)',
    });

    if (opts?.sessionId) {
        recordCodexToolTraceEventIfNeeded({ sessionId: opts.sessionId, body: normalizedBody });
    }
    if (opts?.postSendReactionPort) {
        applyCodexPostSendReactions(opts.postSendReactionPort, {
            normalizedBody,
            backendMode,
            externalKey,
        });
    }

    return { normalizedBody, backendMode, externalKey };
}
