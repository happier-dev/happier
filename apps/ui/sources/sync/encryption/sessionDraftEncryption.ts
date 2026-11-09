import { SessionDraftPrivatePayloadV2StoredSchema, SessionDraftStoredContentEnvelopeV2Schema, SessionDraftStoredContentEnvelopeV2StoredSchema, createSessionDraftPrivatePayloadV2, canonicalSessionDraftAddressV2, isAccountOwnedDraftAddressV2, type SessionDraftAddressV2, type SessionDraftDocumentV2, type SessionDraftStoredContentEnvelopeV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { createAccountScopedBlobOpener, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';

import type { SessionDraftRepositoryCipher } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { SessionDraftContextUnavailableError } from '@/sync/ops/sessionDrafts/sessionDraftCipherError';

import { openSessionStoredContent, sealSessionStoredContent, type SessionContentEncryption } from '@happier-dev/sync-client';

export type SessionDraftContext =
    | Readonly<{ mode: 'plain' }>
    | Readonly<{ mode: 'e2ee'; encryption: SessionContentEncryption | null }>
    | null;

type SessionDraftCipherOptions = Readonly<{
    accountMode: 'plain' | 'e2ee';
    accountCryptoMaterial: AccountScopedCryptoMaterial | null;
    getSessionContext(sessionId: string): SessionDraftContext | Promise<SessionDraftContext>;
    withSessionContexts?<T>(sessionIds: readonly string[], operation: (contexts: ReadonlyMap<string, SessionDraftContext>) => Promise<T>): Promise<T>;
    randomBytes(length: number): Uint8Array;
}>;

/**
 * The payload schema already enforces address/document correspondence, including
 * a Run draft's own manual recipient. This adds the exact address identity so a
 * neighbouring row's plaintext can never be adopted under this address.
 */
function parseBoundPayload(address: SessionDraftAddressV2, value: unknown, encryptedEpoch?: 1 | 2): SessionDraftDocumentV2 | null {
    // The stored projection admits 0.2's V1 payload and drops retired fields
    // while retaining the canonical address/document correspondence checks.
    const parsed = SessionDraftPrivatePayloadV2StoredSchema.safeParse(value);
    if (!parsed.success) return null;
    const payload = parsed.data;
    if (encryptedEpoch !== undefined && payload.v !== encryptedEpoch) return null;
    if (canonicalSessionDraftAddressV2(payload.address) !== canonicalSessionDraftAddressV2(address)) return null;
    return payload.document;
}

export function createSessionDraftCipher(
    options: SessionDraftCipherOptions,
    // One opener per material for this cipher and its context-scoped copies: a hydration page
    // opens many Account drafts, and the derived key is a pure function of the material.
    openAccountDraft = options.accountCryptoMaterial ? createAccountScopedBlobOpener({
        kind: 'account_session_draft_private_payload',
        material: options.accountCryptoMaterial,
    }) : null,
): SessionDraftRepositoryCipher {
    return {
        ...(options.withSessionContexts ? {
            withSessionContexts: <T>(sessionIds: readonly string[], operation: (cipher: SessionDraftRepositoryCipher) => Promise<T>) =>
                options.withSessionContexts!(sessionIds, contexts => operation(createSessionDraftCipher({
                    ...options,
                    withSessionContexts: undefined,
                    getSessionContext: sessionId => contexts.get(sessionId) ?? null,
                }, openAccountDraft))),
        } : {}),
        seal: async (address, document): Promise<SessionDraftStoredContentEnvelopeV2> => {
            const payload = createSessionDraftPrivatePayloadV2(address, document);
            if (isAccountOwnedDraftAddressV2(address)) {
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
            const context = await options.getSessionContext(address.sessionId);
            if (!context) throw new SessionDraftContextUnavailableError();
            const sealed = await sealSessionStoredContent(context, payload);
            if (sealed.status === 'locked') throw new SessionDraftContextUnavailableError();
            return SessionDraftStoredContentEnvelopeV2Schema.parse(sealed.content);
        },
        open: async (address, content): Promise<SessionDraftDocumentV2 | null> => {
            const parsed = SessionDraftStoredContentEnvelopeV2StoredSchema.safeParse(content);
            if (!parsed.success) return null;
            content = parsed.data;
            if (isAccountOwnedDraftAddressV2(address)) {
                if (options.accountMode === 'plain') {
                    return content.t === 'plain' ? parseBoundPayload(address, content.v) : null;
                }
                if (content.t !== 'encrypted') return null;
                if (!openAccountDraft) return null;
                const opened = openAccountDraft(content.c);
                return opened ? parseBoundPayload(address, opened.value, content.v ?? 1) : null;
            }
            const context = await options.getSessionContext(address.sessionId);
            if (!context) throw new SessionDraftContextUnavailableError();
            // Drafts retain their existing unavailable-context exception contract.
            if (context.mode === 'e2ee' && !context.encryption) throw new SessionDraftContextUnavailableError();
            const opened = await openSessionStoredContent(context, content);
            return opened.status === 'ready' ? parseBoundPayload(address, opened.value) : null;
        },
    };
}
