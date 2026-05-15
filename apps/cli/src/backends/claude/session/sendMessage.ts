import { randomUUID } from 'node:crypto';

import type { Usage } from '@/api/types';
import {
    prepareClaudeTranscriptDispatch,
} from '@/api/session/outbound/providers/sessionTranscriptDispatch';
import { resolveClaudeSessionMessageRole } from '@/api/session/messageRole';
import {
    isToolTraceEnabled,
    recordClaudeToolTraceEvents,
} from '@/api/session/toolTrace';
import { applyClaudePostSendReactions } from '@/api/session/client/reactions/providers/applyClaudePostSendReactions';
import type { PostSendReactionPort } from '@/api/session/client/reactions/providers/postSendReactionPort';
import type { SessionClientTranscriptSendPort } from '@/api/session/client/transcript/sendMessages';
import { extractAssistantTextSnapshotFromSessionContent } from '@/api/session/turns/extractAssistantTextSnapshot';

type ClaudeSessionSendResult = Readonly<{
    usage?: Readonly<{ usage: Usage; model?: string }>;
    summary?: Readonly<{ text: string; updatedAt: number }>;
}>;

export function sendClaudeSessionClientMessage(
    port: SessionClientTranscriptSendPort,
    body: import('../contracts/rawJsonLines').RawJSONLines,
    meta?: Record<string, unknown>,
    opts?: Readonly<{
        sessionId?: string;
        postSendReactionPort?: PostSendReactionPort;
    }>,
): ClaudeSessionSendResult {
    if (opts?.sessionId && isToolTraceEnabled()) {
        recordClaudeToolTraceEvents({ sessionId: opts.sessionId, body });
    }
    port.outboundShapeLogger.log('claude:raw-jsonl', body);
    const { content, sidechainId, usage, summary } = prepareClaudeTranscriptDispatch({ body, meta });

    port.outboundShapeLogger.log('claude:session-content', content);
    port.debugLargeJson('[SOCKET] Sending message through socket:', content);
    port.logSendWhileDisconnected('Claude session message', { type: body.type });

    const payload = port.buildOutboundSessionMessagePayload(content);
    port.commitSessionMessageBestEffort({
        message: payload,
        localId: randomUUID(),
        sidechainId,
        messageRole: resolveClaudeSessionMessageRole(body),
        logErrorMessage: '[SOCKET] Failed to commit Claude session message (non-fatal)',
    });
    const extracted = extractAssistantTextSnapshotFromSessionContent(content);
    if (extracted) {
        port.turnAssistantTextSnapshotStore?.observe({
            text: extracted.text,
            provider: extracted.provider,
            sidechainId: extracted.sidechainId,
            source: 'provider-dispatch',
        });
    }

    if (opts?.postSendReactionPort) {
        applyClaudePostSendReactions(opts.postSendReactionPort, { usage, summary });
    }

    return { usage, summary };
}
