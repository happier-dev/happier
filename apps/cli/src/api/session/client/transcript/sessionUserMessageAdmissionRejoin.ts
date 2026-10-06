import type { ComposerAttachmentInputV1 } from '@happier-dev/protocol';
import { readAdmittedHappierStructuredInputV1FromMeta } from '@happier-dev/protocol/runtime/input/structuredInputV1';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { deterministicStringify } from '@/utils/deterministicJson';
import { openSessionMessageContent } from '@/session/transport/encryption/sessionEncryptionContext';
import {
    readPendingQueueV2MessageContentByLocalIdFromServer,
} from '../../pendingQueueV2Transport';
import {
    findTranscriptEncryptedMessageByLocalIdV2,
    type TranscriptLookupOutcome,
} from '../../transcriptMessageLookup';
import type { SessionMessageContent } from '../../../types';

export type PersistedSessionUserMessageAdmission = Readonly<{
    text: string;
    meta: Record<string, unknown>;
    composerAttachments: readonly ComposerAttachmentInputV1[];
}>;

type TranscriptQueryContext = Readonly<
    | { encryptionMode: 'plain' }
    | {
        encryptionMode: 'e2ee';
        encryptionKey: Uint8Array;
        encryptionVariant: 'legacy' | 'dataKey';
    }
>;

type RejoinDeps = Readonly<{
    readPending: typeof readPendingQueueV2MessageContentByLocalIdFromServer;
    findTranscript: (params: {
        token: string;
        serverUrl: string;
        sessionId: string;
        localId: string;
    }) => Promise<TranscriptLookupOutcome>;
}>;

const DEFAULT_DEPS: RejoinDeps = Object.freeze({
    readPending: readPendingQueueV2MessageContentByLocalIdFromServer,
    findTranscript: findTranscriptEncryptedMessageByLocalIdV2,
});

function parsePersistedUserMessage(
    content: SessionMessageContent,
    context: TranscriptQueryContext,
): PersistedSessionUserMessageAdmission {
    const decrypted = openSessionMessageContent({
        content,
        ...(context.encryptionMode === 'plain'
            ? { mode: 'plain', ctx: null } as const
            : { mode: 'e2ee', ctx: { encryptionKey: context.encryptionKey, encryptionVariant: context.encryptionVariant } } as const),
    });
    if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) {
        throw new Error('Malformed persisted Session user message');
    }
    const record = decrypted as Record<string, unknown>;
    const body = record.content;
    const meta = record.meta;
    if (record.role !== 'user'
        || !body
        || typeof body !== 'object'
        || Array.isArray(body)
        || (body as Record<string, unknown>).type !== 'text'
        || typeof (body as Record<string, unknown>).text !== 'string'
        || !meta
        || typeof meta !== 'object'
        || Array.isArray(meta)) {
        throw new Error('Malformed persisted Session user message');
    }
    const structured = readAdmittedHappierStructuredInputV1FromMeta(meta);
    if (structured.status === 'invalid') {
        throw new Error('Malformed persisted Session structured input');
    }
    return Object.freeze({
        text: (body as Record<string, unknown>).text as string,
        meta: meta as Record<string, unknown>,
        composerAttachments: Object.freeze([
            ...(structured.status === 'admitted'
                ? structured.structuredInput.composerAttachments ?? []
                : []),
        ]),
    });
}

/**
 * Rejoins the durable pending/transcript owner before any non-idempotent plugin
 * preparation is asked to run again.
 */
export async function findPersistedSessionUserMessageAdmission(
    input: Readonly<{
        token: string;
        sessionId: string;
        localId: string;
        queryContext: TranscriptQueryContext;
    }>,
    deps: RejoinDeps = DEFAULT_DEPS,
): Promise<PersistedSessionUserMessageAdmission | null> {
    const [pendingContent, transcript] = await Promise.all([
        deps.readPending({
            token: input.token,
            sessionId: input.sessionId,
            localId: input.localId,
        }),
        deps.findTranscript({
            token: input.token,
            serverUrl: resolveServerHttpBaseUrl(),
            sessionId: input.sessionId,
            localId: input.localId,
        }),
    ]);
    let transcriptContent: SessionMessageContent | null = null;
    if (transcript.type === 'found') {
        if (transcript.message.localId !== input.localId) {
            throw new Error('Persisted Session input identity mismatch');
        }
        transcriptContent = transcript.message.content;
    } else if (transcript.type !== 'not_found') {
        throw transcript.error;
    }
    if (pendingContent === null && transcriptContent === null) return null;

    const pending = pendingContent === null
        ? null
        : parsePersistedUserMessage(pendingContent, input.queryContext);
    const committed = transcriptContent === null
        ? null
        : parsePersistedUserMessage(transcriptContent, input.queryContext);
    if (pending && committed && deterministicStringify(pending) !== deterministicStringify(committed)) {
        throw new Error('Conflicting persisted Session input custody');
    }
    return pending ?? committed;
}
