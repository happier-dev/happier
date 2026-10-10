import { isMessageStructuredPresentationV1Candidate } from '@happier-dev/protocol/sessions/messages/messageStructuredPresentationV1';
import { resolveStoredContentKindForSessionEncryptionMode, type SessionEncryptionMode } from '@happier-dev/protocol/encryption/storagePolicyDecisions';
import type { SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { parseSessionMessageDeliveryResolutionV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';


import type { DecryptedMessage } from '@/sync/domains/state/storageTypes';
import { RawRecordSchema, type RawRecord } from "@happier-dev/session-core/raw";

type StoredSessionEncryptedContent = Readonly<{
    t: 'encrypted';
    c: string;
}>;

type StoredSessionPlainContent = Readonly<{
    t: 'plain';
    v: unknown;
}>;

function isStoredSessionEncryptedContent(value: unknown): value is StoredSessionEncryptedContent {
    return Boolean(
        value
        && typeof value === 'object'
        && (value as StoredSessionEncryptedContent).t === 'encrypted'
        && typeof (value as StoredSessionEncryptedContent).c === 'string',
    );
}

function isStoredSessionPlainContent(value: unknown): value is StoredSessionPlainContent {
    return Boolean(
        value
        && typeof value === 'object'
        && (value as StoredSessionPlainContent).t === 'plain'
        && 'v' in (value as StoredSessionPlainContent),
    );
}

export async function readStoredSessionRawRecord(params: Readonly<{
    content: unknown;
    decryptEncrypted?: (ciphertext: string) => Promise<unknown> | unknown;
}>): Promise<RawRecord | null> {
    const { content, decryptEncrypted } = params;

    const decodedContent = typeof content === 'string'
        ? (() => {
            try {
                return JSON.parse(content);
            } catch {
                return content;
            }
        })()
        : content;

    const rawContent = isStoredSessionPlainContent(decodedContent)
        ? decodedContent.v
        : isStoredSessionEncryptedContent(decodedContent) && decryptEncrypted
            ? await decryptEncrypted(decodedContent.c)
            : null;

    // The reserved structured-presentation discriminator is Message-owned in
    // Protocol; the transport reader consumes it rather than re-deriving it,
    // so a change to the persisted profile reservation cannot diverge here.
    const candidate = rawContent ?? decodedContent;
    if (isMessageStructuredPresentationV1Candidate(candidate)) {
        return null;
    }

    const parsed = RawRecordSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
}

export async function readStoredSessionMessage(params: Readonly<{
    message: SessionMessageV1 | null | undefined;
    sessionEncryptionMode: SessionEncryptionMode;
    decryptMessage?: (message: SessionMessageV1) => Promise<DecryptedMessage | null>;
}>): Promise<DecryptedMessage | null> {
    const message = params.message;
    if (!message) {
        return null;
    }
    // This is the typed wire boundary, so consume Protocol's mode decision
    // without reparsing each socket event or inferring mode from key presence.
    if (message.content?.t !== resolveStoredContentKindForSessionEncryptionMode(params.sessionEncryptionMode)) {
        return null;
    }

    if (isStoredSessionPlainContent(message.content)) {
        const content = await readStoredSessionRawRecord({ content: message.content });
        const resolution = parseSessionMessageDeliveryResolutionV1(message.deliveryResolution);
        const acceptedDelivery = resolution?.kind === 'provider_accepted' && resolution.content.t === 'plain'
            ? resolution.content.v : undefined;
        return {
            id: message.id,
            seq: message.seq,
            localId: message.localId ?? null,
            messageRole: message.messageRole ?? null,
            content,
            createdAt: message.createdAt,
            ...(content !== null && acceptedDelivery ? { acceptedDelivery } : {}),
        };
    }

    if (!params.decryptMessage) {
        return null;
    }

    const decrypted = await params.decryptMessage(message);
    if (!decrypted) {
        return null;
    }

    return {
        ...decrypted,
        content: await readStoredSessionRawRecord({ content: decrypted.content }),
        messageRole: decrypted.messageRole ?? message.messageRole ?? null,
    };
}
