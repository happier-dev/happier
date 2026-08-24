import {
    SessionDraftPrivatePayloadV1Schema,
    canonicalSessionDraftAddressV1,
    openAccountScopedBlobCiphertext,
    sealAccountScopedBlobCiphertext,
    type AccountScopedCryptoMaterial,
    type SessionDraftAddressV1,
    type SessionDraftDocumentV1,
    type SessionDraftStoredContentEnvelopeV1,
} from '@happier-dev/protocol';

import type { SessionDraftRepositoryCipher } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

type SessionContentEncryption = Readonly<{
    encryptRaw(payload: unknown): Promise<string>;
    decryptRaw(ciphertext: string): Promise<unknown | null>;
}>;

type SessionDraftCipherOptions = Readonly<{
    accountMode: 'plain' | 'e2ee';
    accountCryptoMaterial: AccountScopedCryptoMaterial;
    getSessionContext(sessionId: string):
        | Readonly<{ mode: 'plain' }>
        | Readonly<{ mode: 'e2ee'; encryption: SessionContentEncryption | null }>
        | null;
    randomBytes(length: number): Uint8Array;
}>;

function parseBoundPayload(address: SessionDraftAddressV1, value: unknown): SessionDraftDocumentV1 | null {
    const parsed = SessionDraftPrivatePayloadV1Schema.safeParse(value);
    if (!parsed.success) return null;
    if (canonicalSessionDraftAddressV1(parsed.data.address) !== canonicalSessionDraftAddressV1(address)) return null;
    if (parsed.data.document.target.kind !== address.kind) return null;
    return parsed.data.document;
}

export function createSessionDraftCipher(options: SessionDraftCipherOptions): SessionDraftRepositoryCipher {
    return {
        seal: async (address, document): Promise<SessionDraftStoredContentEnvelopeV1> => {
            const payload = SessionDraftPrivatePayloadV1Schema.parse({ v: 1, address, document });
            if (address.kind === 'newSession') {
                return options.accountMode === 'plain'
                    ? { t: 'plain', v: payload }
                    : {
                        t: 'encrypted',
                        c: sealAccountScopedBlobCiphertext({
                            kind: 'account_session_draft_private_payload',
                            material: options.accountCryptoMaterial,
                            payload,
                            randomBytes: options.randomBytes,
                        }),
                    };
            }
            const context = options.getSessionContext(address.sessionId);
            if (!context) throw new Error('Session draft encryption context is unavailable');
            if (context.mode === 'plain') return { t: 'plain', v: payload };
            if (!context.encryption) throw new Error('Session draft encryption key is unavailable');
            return { t: 'encrypted', c: await context.encryption.encryptRaw(payload) };
        },
        open: async (address, content): Promise<SessionDraftDocumentV1 | null> => {
            if (address.kind === 'newSession') {
                if (options.accountMode === 'plain') {
                    return content.t === 'plain' ? parseBoundPayload(address, content.v) : null;
                }
                if (content.t !== 'encrypted') return null;
                const opened = openAccountScopedBlobCiphertext({
                    kind: 'account_session_draft_private_payload',
                    material: options.accountCryptoMaterial,
                    ciphertext: content.c,
                });
                return opened ? parseBoundPayload(address, opened.value) : null;
            }
            const context = options.getSessionContext(address.sessionId);
            if (!context) return null;
            if (context.mode === 'plain') return content.t === 'plain' ? parseBoundPayload(address, content.v) : null;
            if (content.t !== 'encrypted' || !context.encryption) return null;
            return parseBoundPayload(address, await context.encryption.decryptRaw(content.c));
        },
    };
}
