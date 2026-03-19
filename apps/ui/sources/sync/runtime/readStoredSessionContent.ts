import type { ApiMessage } from '@/sync/api/types/apiTypes';
import type { DecryptedMessage } from '@/sync/domains/state/storageTypes';
import { RawRecordSchema, type RawRecord } from '@/sync/typesRaw';

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
    const rawContent = isStoredSessionPlainContent(content)
        ? content.v
        : isStoredSessionEncryptedContent(content) && decryptEncrypted
            ? await decryptEncrypted(content.c)
            : null;

    const parsed = RawRecordSchema.safeParse(rawContent);
    return parsed.success ? parsed.data : null;
}

export async function readStoredSessionMessage(params: Readonly<{
    message: ApiMessage | null | undefined;
    decryptMessage?: (message: ApiMessage) => Promise<DecryptedMessage | null>;
}>): Promise<DecryptedMessage | null> {
    const message = params.message;
    if (!message) {
        return null;
    }

    if (isStoredSessionPlainContent(message.content)) {
        const content = await readStoredSessionRawRecord({ content: message.content });
        return {
            id: message.id,
            seq: message.seq,
            localId: message.localId ?? null,
            content,
            createdAt: message.createdAt,
        };
    }

    if (!params.decryptMessage) {
        return null;
    }

    return await params.decryptMessage(message);
}