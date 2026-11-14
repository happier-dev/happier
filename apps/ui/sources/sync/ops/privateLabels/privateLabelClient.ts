import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import tweetnacl from 'tweetnacl';

import {
    openPrivateLabelV1,
    sealPrivateLabelV1,
    type PrivateLabelBindingV1,
    type PrivateLabelReadV1,
    type PrivateLabelReadPolicyV1,
    type PrivateLabelStoredV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';
import {
    PrivateLabelRecipientCensusRequestV1Schema,
    PrivateLabelRecipientCensusResponseV1Schema,
    type PrivateLabelRecipientCensusOwnerV1,
} from '@happier-dev/protocol/crypto/privateLabelRecipientCensusV1';
import { prepareSavedSecretResourceRecipientEnvelopesV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';

import { getRandomBytes } from '@/platform/cryptoRandom';
import { classifyAccountStorageReadFailure } from '@/sync/encryption/accountStorageReadFailure';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

const PRIVATE_LABEL_RECIPIENT_CENSUS_PATH = '/v1/account/private-labels/recipient-census';

/** A label reader must not turn withdrawn Account custody into an unavailable label. */
export function isPrivateLabelLifecycleFailureV1(error: unknown, signal?: AbortSignal): boolean {
    const reason = classifyAccountStorageReadFailure(error, signal);
    return reason === 'cancelled' || reason === 'scope-retired';
}

function rethrowLifecycleFailure(error: unknown, signal: AbortSignal | undefined): void {
    if (isPrivateLabelLifecycleFailureV1(error, signal)) throw error;
}

function assertContextCurrent(context: Pick<PrivateLabelAccountContextV1, 'isCurrent'>, signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException('The label operation was cancelled.', 'AbortError');
    }
    // A context owns its currentness decision. Convert its negative result to
    // the established lifecycle refusal so callers never render it as a
    // label-local decrypt failure; a context that already throws keeps that cause.
    if (!context.isCurrent()) {
        throw Object.assign(new Error('The Account context is no longer current.'), {
            code: 'action_account_scope_changed' as const,
        });
    }
}

export type PrivateLabelSealInputV1 = Readonly<{
    owner: PrivateLabelRecipientCensusOwnerV1;
    binding: PrivateLabelBindingV1;
    value: string;
    signal?: AbortSignal;
}>;

export type PrivateLabelOpenInputV1 = Readonly<{
    binding: PrivateLabelBindingV1;
    /** Established owner policy; never infer this from a binding or viewer Account mode. */
    readPolicy: PrivateLabelReadPolicyV1;
    /** Responses must be recipient-projected; stored Plain values remain openable locally for immediate previews. */
    label: PrivateLabelReadV1 | PrivateLabelStoredV1 | null | undefined;
    signal?: AbortSignal;
}>;

/**
 * A captured Account transport plus its key opener. This lets Account Directory
 * use the same label cipher owner without borrowing the active Home scope.
 */
export type PrivateLabelAccountContextResponseV1 = Readonly<{
    ok: boolean;
    body: unknown;
}>;

export type PrivateLabelAccountContextV1 = Readonly<{
    accountId: string;
    isCurrent: () => boolean;
    /** Captured Account mode is the authority for a new label; a census only names its audience. */
    resolveContentEncryptionMode: (signal?: AbortSignal) => Promise<'plain' | 'e2ee' | null>;
    request: (path: string, init: RequestInit, signal?: AbortSignal) => Promise<PrivateLabelAccountContextResponseV1 | null>;
    decryptEncryptionKey?: (encryptedDataKey: string, signal?: AbortSignal) => Promise<Uint8Array | null>;
}>;

/**
 * The bounded Action owns this context's credential watch, cached Account
 * material, and disposal. A label collection borrows it without recapturing
 * an ambient Home for every row.
 */
export type PrivateLabelActionAccountContextV1 = Pick<LazyActionAccountContext,
    'accountId' | 'assertCurrent' | 'request' | 'resolveAccountEncryption' | 'serverId'>;

/**
 * The only UI owner for label sealing/opening: it asks the Home for the exact current
 * Saved Secret-compatible audience and leaves envelope admission to the server mutation.
 */
export function createPrivateLabelClientForAccountContext(context: PrivateLabelAccountContextV1) {
    async function requestRecipientCensus(owner: PrivateLabelRecipientCensusOwnerV1, signal?: AbortSignal) {
        assertContextCurrent(context, signal);
        const request = PrivateLabelRecipientCensusRequestV1Schema.safeParse({ owner });
        if (!request.success || !context.accountId.trim()) return null;
        // Preserve a captured transport's typed refusal. A caller needs its original
        // status/code to distinguish a rejected census from an unavailable label.
        const response = await context.request(PRIVATE_LABEL_RECIPIENT_CENSUS_PATH, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.data), signal,
        }, signal);
        assertContextCurrent(context, signal);
        if (!response) return null;
        const census = PrivateLabelRecipientCensusResponseV1Schema.safeParse(response.body);
        return response.ok && census.success ? census.data : null;
    }

    async function seal(input: PrivateLabelSealInputV1): Promise<PrivateLabelStoredV1 | null> {
        assertContextCurrent(context, input.signal);
        const census = await requestRecipientCensus(input.owner, input.signal);
        if (!census) return null;
        let contentEncryptionMode: 'plain' | 'e2ee' | null;
        try {
            contentEncryptionMode = await context.resolveContentEncryptionMode(input.signal);
        } catch (error) {
            rethrowLifecycleFailure(error, input.signal);
            return null;
        }
        assertContextCurrent(context, input.signal);
        if (!contentEncryptionMode) return null;
        // The authenticated captured Account decides encryption mode. The census is
        // an audience read and must agree before any label content is created.
        if (!census || census.contentEncryptionMode !== contentEncryptionMode) return null;
        try {
            assertContextCurrent(context, input.signal);
            if (contentEncryptionMode === 'plain') {
                return sealPrivateLabelV1({ mode: 'plain', binding: input.binding, value: input.value });
            }
            const dataKey = getRandomBytes(tweetnacl.secretbox.keyLength);
            const prepared = prepareSavedSecretResourceRecipientEnvelopesV1({
                recipients: census.recipients,
                resourceDataKey: dataKey,
                randomBytes: getRandomBytes,
            });
            // A fresh DEK needs every exact census recipient. `prepared` belongs to a
            // different persisted resource and cannot be borrowed for this label.
            if (prepared.length !== census.recipients.length) return null;
            return sealPrivateLabelV1({
                mode: 'e2ee', binding: input.binding, value: input.value, dataKey,
                recipients: prepared.map((recipient) => ({
                    accountId: recipient.recipientAccountId,
                    envelope: {
                        encryptedDataKey: recipient.encryptedDataKey,
                        recipientContentPublicKeyFingerprint: recipient.recipientContentPublicKeyFingerprint,
                    },
                })),
                randomBytes: getRandomBytes,
            });
        } catch (error) {
            rethrowLifecycleFailure(error, input.signal);
            return null;
        }
    }

    async function open(input: PrivateLabelOpenInputV1): Promise<string | null> {
        assertContextCurrent(context, input.signal);
        if (!input.label) return null;
        if (input.label.content.t === 'plain') {
            return openPrivateLabelV1({ binding: input.binding, label: input.label, readPolicy: input.readPolicy });
        }
        const projection = 'recipientEnvelope' in input.label ? input.label : null;
        if (!projection?.recipientEnvelope || !context.decryptEncryptionKey) return null;
        try {
            const dataKey = await context.decryptEncryptionKey(projection.recipientEnvelope.encryptedDataKey, input.signal);
            assertContextCurrent(context, input.signal);
            return dataKey ? openPrivateLabelV1({ binding: input.binding, label: projection, readPolicy: input.readPolicy, dataKey }) : null;
        } catch (error) {
            rethrowLifecycleFailure(error, input.signal);
            return null;
        }
    }

    return { seal, open };
}

/**
 * Bind a label client to an Action's already-captured Account. The caller owns
 * the Action lifetime and must dispose it after the enclosing operation.
 */
export function createPrivateLabelClientForActionAccountContext(account: PrivateLabelActionAccountContextV1) {
    return createPrivateLabelClientForAccountContext({
        accountId: account.accountId,
        isCurrent: () => {
            account.assertCurrent();
            return true;
        },
        resolveContentEncryptionMode: async (signal) => {
            const { accountMode, encryption } = await account.resolveAccountEncryption(signal);
            // Keep the same current-key proof as the ordinary Home adapter:
            // an E2EE mode alone cannot authorize a writer.
            if (accountMode === 'e2ee' && !encryption) return null;
            account.assertCurrent();
            return accountMode;
        },
        request: async (path, init) => {
            const response = await account.request(path, init, { retry: 'none' });
            const body = await response.json().catch(() => null);
            account.assertCurrent();
            return { ok: response.ok, body };
        },
        decryptEncryptionKey: async (encryptedDataKey, signal) => {
            const { encryption } = await account.resolveAccountEncryption(signal);
            const dataKey = encryption
                ? await encryption.decryptEncryptionKey(encryptedDataKey, {
                    serverId: account.serverId,
                    accountId: account.accountId,
                    signal,
                })
                : null;
            account.assertCurrent();
            return dataKey;
        },
    });
}

/** The ordinary Home adapter is one account context; Directory supplies its own captured context. */
export function createPrivateLabelClient(scope: ServerAccountScope) {
    return createPrivateLabelClientForAccountContext({
        accountId: scope.accountId,
        isCurrent: () => true,
        resolveContentEncryptionMode: async (signal) => {
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            const account = await captureLazyActionAccountContext(scope.serverId, signal);
            try {
                if (account.accountId !== scope.accountId) return null;
                const { accountMode, encryption } = await account.resolveAccountEncryption(signal);
                // A captured E2EE identity must prove the normal key guard too;
                // mode alone never authorizes a ciphertext writer.
                if (accountMode === 'e2ee' && !encryption) return null;
                account.assertCurrent();
                return accountMode;
            } catch (error) {
                rethrowLifecycleFailure(error, signal);
                return null;
            } finally {
                account.dispose();
            }
        },
        request: async (path, init, signal) => {
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            const account = await captureLazyActionAccountContext(scope.serverId, signal);
            try {
                if (account.accountId !== scope.accountId) return null;
                const response = await account.request(path, init, { retry: 'none' });
                const body = await response.json().catch(() => null);
                account.assertCurrent();
                return { ok: response.ok, body };
            } catch (error) {
                rethrowLifecycleFailure(error, signal);
                return null;
            } finally {
                account.dispose();
            }
        },
        decryptEncryptionKey: async (encryptedDataKey, signal) => {
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            const account = await captureLazyActionAccountContext(scope.serverId, signal);
            try {
                if (account.accountId !== scope.accountId) return null;
                const { encryption } = await account.resolveAccountEncryption(signal);
                const dataKey = encryption
                    ? await encryption.decryptEncryptionKey(encryptedDataKey, {
                        serverId: scope.serverId, accountId: scope.accountId, signal,
                    })
                    : null;
                account.assertCurrent();
                return dataKey;
            } catch (error) {
                rethrowLifecycleFailure(error, signal);
                return null;
            } finally {
                account.dispose();
            }
        },
    });
}


/** Semantic Action consumers borrow the enclosing Action's Account; no ambient recapture. */
export function createPrivateLabelActionOpener(
    account: PrivateLabelActionAccountContextV1,
): NonNullable<ActionExecutorDeps['privateLabelOpen']> {
    const labels = createPrivateLabelClientForActionAccountContext(account);
    return async (request, context) => await labels.open({ ...request,
        ...((request.signal ?? context.signal) ? { signal: request.signal ?? context.signal } : {}),
    });
}
