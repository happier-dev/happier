import { SessionDraftPrivatePayloadV2Schema, SessionDraftStoredContentEnvelopeV2Schema, createSessionDraftPrivatePayloadV2, canonicalSessionDraftAddressV2, type SessionDraftAddressV2, type SessionDraftDocumentV2, type SessionDraftStoredContentEnvelopeV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';

import type { SessionDraftRepositoryCipher } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { SessionDraftContextUnavailableError } from '@/sync/ops/sessionDrafts/sessionDraftCipherError';

import { openSessionStoredContent, sealSessionStoredContent, type SessionContentEncryption } from '@happier-dev/sync-client';

type SessionDraftCipherOptions = Readonly<{
    accountMode: 'plain' | 'e2ee';
    accountCryptoMaterial: AccountScopedCryptoMaterial | null;
    getSessionContext(sessionId: string):
        | Readonly<{ mode: 'plain' }>
        | Readonly<{ mode: 'e2ee'; encryption: SessionContentEncryption | null }>
        | null;
    randomBytes(length: number): Uint8Array;
}>;

/**
 * The payload schema already enforces address/document correspondence, including
 * a Run draft's own manual recipient. This adds the exact address identity so a
 * neighbouring row's plaintext can never be adopted under this address.
 */
function parseBoundPayload(address: SessionDraftAddressV2, value: unknown, encryptedEpoch?: 1 | 2): SessionDraftDocumentV2 | null {
    // A draft a 0.2 client wrote is a closed V1 payload, which this union
    // already admits; no predecessor bridge stands between it and its reader.
    const parsed = SessionDraftPrivatePayloadV2Schema.safeParse(value);
    if (!parsed.success) return null;
    const payload = parsed.data;
    if (encryptedEpoch !== undefined && payload.v !== encryptedEpoch) return null;
    if (canonicalSessionDraftAddressV2(payload.address) !== canonicalSessionDraftAddressV2(address)) return null;
    return payload.document;
}

/** New-Session drafts are Account-bound; every other kind binds one Session. */
function isAccountBoundDraftAddress(
    address: SessionDraftAddressV2,
): address is Extract<SessionDraftAddressV2, { kind: 'newSession' }> {
    return address.kind === 'newSession';
}

export function createSessionDraftCipher(options: SessionDraftCipherOptions): SessionDraftRepositoryCipher {
    return {
        seal: async (address, document): Promise<SessionDraftStoredContentEnvelopeV2> => {
            const payload = createSessionDraftPrivatePayloadV2(address, document);
            if (isAccountBoundDraftAddress(address)) {
                if (options.accountMode === 'e2ee' && !options.accountCryptoMaterial) {
                    throw new Error('Session draft Account encryption key is unavailable');
                }
                return options.accountMode === 'plain'
                    ? { t: 'plain', v: payload }
                    : {
                        t: 'encrypted',
                        ...(payload.v === 2 ? { v: 2 as const } : {}),
                        c: sealAccountScopedBlobCiphertext({
                            kind: 'account_session_draft_private_payload',
                            material: options.accountCryptoMaterial!,
                            payload,
                            randomBytes: options.randomBytes,
                        }),
                    };
            }
            const context = options.getSessionContext(address.sessionId);
            if (!context) throw new SessionDraftContextUnavailableError();
            const sealed = await sealSessionStoredContent(context, payload);
            if (sealed.status === 'locked') throw new SessionDraftContextUnavailableError();
            return SessionDraftStoredContentEnvelopeV2Schema.parse(sealed.content);
        },
        open: async (address, content): Promise<SessionDraftDocumentV2 | null> => {
            if (!SessionDraftStoredContentEnvelopeV2Schema.safeParse(content).success) return null;
            if (isAccountBoundDraftAddress(address)) {
                if (options.accountMode === 'plain') {
                    return content.t === 'plain' ? parseBoundPayload(address, content.v) : null;
                }
                if (content.t !== 'encrypted') return null;
                if (!options.accountCryptoMaterial) return null;
                const opened = openAccountScopedBlobCiphertext({
                    kind: 'account_session_draft_private_payload',
                    material: options.accountCryptoMaterial,
                    ciphertext: content.c,
                });
                return opened ? parseBoundPayload(address, opened.value, content.v ?? 1) : null;
            }
            const context = options.getSessionContext(address.sessionId);
            if (!context) throw new SessionDraftContextUnavailableError();
            // Drafts retain their existing unavailable-context exception contract.
            if (context.mode === 'e2ee' && !context.encryption) throw new SessionDraftContextUnavailableError();
            const opened = await openSessionStoredContent(context, content);
            return opened.status === 'ready' ? parseBoundPayload(address, opened.value) : null;
        },
    };
}
