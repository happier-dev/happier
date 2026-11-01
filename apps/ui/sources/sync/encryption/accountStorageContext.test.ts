import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { installConnectedServicesCommonModuleMocks } from '@/components/settings/connectedServices/connectedServicesTestHelpers';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries,
    type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import type { AccountEncryptionCurrentnessErrorResponse } from '@happier-dev/protocol/account/encryptionMode';
import { encodeBase64 } from '@/encryption/base64';
import { HappyError } from '@/utils/errors/errors';
import type { ServerFetch } from '@/sync/http/client';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import type { AccountStorageCurrentnessUnavailableError as CurrentnessFailure } from './accountStorageContext';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { AbortController as ReactNativeAbortController } from 'abort-controller';

installConnectedServicesCommonModuleMocks();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// Establish the real shared dependencies sequentially before the app runtime, after its transport boundaries.
await import('@/sync/domains/state/storageStore');
await import('@/sync/store/hooks');
await import('@/sync/ops/actions/defaultActionExecutor');
const runtime = await import('@/sync/syncEngine');
const { Encryption } = await import('./encryption');
const { AccountStorageCurrentnessUnavailableError, classifyAccountStorageReadFailure, resolveAccountStorageContext } = await import('./accountStorageContext');
const { AccountEncryptionCurrentnessReadinessError, fetchAccountEncryptionCurrentness, invalidateAccountEncryptionModeCache } = await import('@/sync/api/account/apiAccountEncryptionMode');
afterEach(() => resetRuntimeFetch());

const owner = 'storage-currentness-owner';
const token = createAccountTokenForTests(owner, { currentAccount: true });
const secret = new Uint8Array(32).fill(11);
const credentials: AuthCredentials = { token, secret: encodeBase64(secret, 'base64url') };
const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint,
);
const currentness = (mode: 'plain' | 'e2ee' = 'e2ee', contentKeyFingerprint: string | null = fingerprint) => ({
    mode, version: 1, signingKeyFingerprint: mode === 'plain' ? null : 'signing-fingerprint', contentKeyFingerprint, updatedAt: 1,
});

async function withCurrentnessHome<T>(answer: HomeDomainAnswer, run: (request: ServerFetch) => Promise<T>, accountEncryptionMode: 'plain' | 'e2ee' = 'e2ee') {
    installHomeGovernanceBoundaries(home);
    setRuntimeFetch(home.request);
    const serverUrl = 'https://storage-currentness-owner.test';
    const serverId = await home.addHome({ name: 'Storage currentness', serverUrl, accountId: owner, currentAccount: true, accountEncryptionMode });
    home.answer(serverId, 'GET /v1/account/encryption/currentness', answer);
    try {
        return await run((path, init) => home.request(new URL(path, serverUrl), init));
    } finally { await home.reset(); }
}

async function captureCurrentnessFailure(operation: Promise<unknown>): Promise<CurrentnessFailure> {
    try {
        await operation;
        throw new Error('Expected currentness admission to fail');
    } catch (error) {
        expect(error).toBeInstanceOf(AccountStorageCurrentnessUnavailableError);
        if (!(error instanceof AccountStorageCurrentnessUnavailableError)) throw error;
        return error;
    }
}

describe('Account storage currentness failure fidelity', () => {
    it('classifies native schema errors as invalid stored content while preserving transport failures', () => {
        const malformed = z.object({ value: z.string() }).safeParse({ value: 1 });
        if (malformed.success) throw new Error('Expected malformed stored content');
        expect(malformed.error.issues).toMatchObject([{ code: 'invalid_type', path: ['value'] }]);
        expect(classifyAccountStorageReadFailure(malformed.error)).toBe('invalid-stored-content');
        expect(classifyAccountStorageReadFailure(new Error('ZodError'))).toBe('unreachable');
    });

    it('admits and cancels currentness with the actual React Native AbortSignal implementation', async () => {
        await withCurrentnessHome({ body: currentness('plain', null) }, async request => {
            const controller = new ReactNativeAbortController();
            // Native's legacy declaration omits newer DOM members; this is its real signal boundary.
            const signal = controller.signal as AbortSignal;
            expect(await fetchAccountEncryptionCurrentness({ token }, { request, signal })).toMatchObject({ mode: 'plain' });
            controller.abort();
            await expect(fetchAccountEncryptionCurrentness({ token }, { request, signal })).rejects.toMatchObject({ name: 'AbortError' });
            expect(home.requestsFor('/v1/account/encryption/currentness')).toHaveLength(1);
        }, 'plain');
    });
    it('keeps every exact cursor witness fresh across ambient and captured requests', async () => {
        const response = createDeferred<void>();
        const entered = createDeferred<void>();
        const initialReadsEntered = createDeferred<void>();
        let reads = 0;
        let version = 1;
        await withCurrentnessHome({ select: () => {
            entered.resolve();
            reads += 1;
            if (reads === 3) initialReadsEntered.resolve();
            return { body: { ...currentness('plain', null), version }, respondAfter: response.promise };
        } }, async request => {
            const first = fetchAccountEncryptionCurrentness({ token });
            await entered.promise;
            const second = fetchAccountEncryptionCurrentness({ token });
            const captured = fetchAccountEncryptionCurrentness({ token }, { request });
            await initialReadsEntered.promise;
            version = 2;
            invalidateAccountEncryptionModeCache();
            const updated = fetchAccountEncryptionCurrentness({ token });
            response.resolve();
            expect(await Promise.all([first, second, captured, updated])).toMatchObject([
                { version: 1 }, { version: 1 }, { version: 1 }, { version: 2 },
            ]);
            expect(home.requestsFor('/v1/account/encryption/currentness')).toHaveLength(4);
            version = 3;
            expect(await fetchAccountEncryptionCurrentness({ token })).toMatchObject({ version: 3 });
            expect(home.requestsFor('/v1/account/encryption/currentness')).toHaveLength(5);
        }, 'plain');
    });

    it('freshly admits each E2EE caller cipher independently', async () => {
        const response = createDeferred<void>();
        const cipher = await Encryption.create(secret);
        await withCurrentnessHome({ body: currentness(), respondAfter: response.promise }, async request => {
            const readable = resolveAccountStorageContext(credentials, { encryption: cipher, request });
            const locked = resolveAccountStorageContext(credentials, { encryption: null, request });
            const outcomes = Promise.allSettled([readable, locked]);
            response.resolve();
            expect(await outcomes).toEqual([
                { status: 'fulfilled', value: { mode: 'e2ee', encryption: cipher } },
                { status: 'rejected', reason: expect.objectContaining({ reason: 'encryption-material-unavailable' }) },
            ]);
            expect(home.requestsFor('/v1/account/encryption/currentness')).toHaveLength(2);
        });
    });

    it('never joins a fresh storage authority point to another pending witness', async () => {
        const response = createDeferred<void>();
        const entered = createDeferred<void>();
        let version = 1;
        let mode: 'plain' | 'e2ee' = 'plain';
        await withCurrentnessHome({ select: () => {
            entered.resolve();
            return { body: { ...currentness(mode, mode === 'plain' ? null : fingerprint), version }, respondAfter: response.promise };
        } }, async request => {
            const first = resolveAccountStorageContext({ token }, { encryption: null, request });
            await entered.promise;
            // The first HTTP witness is deliberately held across a committed
            // mode change. The later final authority point must not join it.
            version = 2;
            mode = 'e2ee';
            const second = resolveAccountStorageContext({ token }, { encryption: null, request, usage: 'fresh-authority' });
            const outcomes = Promise.allSettled([first, second]);
            const starts = home.requestsFor('/v1/account/encryption/currentness').length;
            response.resolve();
            expect(await outcomes).toEqual([
                { status: 'fulfilled', value: { mode: 'plain', encryption: null } },
                { status: 'rejected', reason: expect.objectContaining({ reason: 'encryption-material-unavailable' }) },
            ]);
            expect(starts).toBe(2);
            expect(await fetchAccountEncryptionCurrentness({ token }, { request })).toMatchObject({ version: 2, mode: 'e2ee' });
            expect(home.requestsFor('/v1/account/encryption/currentness')).toHaveLength(3);
        }, 'plain');
    });

    it('preserves independent fresh refusals and a subsequent same-transport recovery', async () => {
        const response = createDeferred<void>();
        let refused = true;
        await withCurrentnessHome({ select: () => ({ status: refused ? 403 : 200,
            body: refused ? { error: 'denied' } : currentness('plain', null), respondAfter: response.promise }) }, async request => {
            const first = fetchAccountEncryptionCurrentness({ token }, { request });
            const second = fetchAccountEncryptionCurrentness({ token }, { request });
            const outcomes = Promise.allSettled([first, second]);
            const starts = home.requestsFor('/v1/account/encryption/currentness').length;
            response.resolve();
            expect(await outcomes).toEqual([
                { status: 'rejected', reason: expect.objectContaining({ status: 403 }) },
                { status: 'rejected', reason: expect.objectContaining({ status: 403 }) },
            ]);
            expect(starts).toBe(2);
            refused = false;
            expect(await fetchAccountEncryptionCurrentness({ token }, { request })).toMatchObject({ mode: 'plain' });
            expect(home.requestsFor('/v1/account/encryption/currentness')).toHaveLength(3);
        }, 'plain');
    });

    it('keeps distinct credential material and captured transports independent', async () => {
        const response = createDeferred<void>();
        await withCurrentnessHome({ body: currentness('plain', null), respondAfter: response.promise }, async request => {
            const otherServerUrl = 'https://other-storage-currentness-owner.test';
            const otherHome = await home.addHome({ name: 'Other currentness', serverUrl: otherServerUrl, accountId: owner,
                accountEncryptionMode: 'plain', currentAccount: true });
            home.answer(otherHome, 'GET /v1/account/encryption/currentness', { body: { ...currentness('plain', null), version: 7 }, respondAfter: response.promise });
            const otherRequest: ServerFetch = (path, init) => home.request(new URL(path, otherServerUrl), init);
            const first = fetchAccountEncryptionCurrentness(credentials, { request });
            const changedMaterial = fetchAccountEncryptionCurrentness({ token, secret: encodeBase64(new Uint8Array(32).fill(12), 'base64url') }, { request });
            const other = fetchAccountEncryptionCurrentness(credentials, { request: otherRequest });
            response.resolve();
            expect(await Promise.all([first, changedMaterial, other])).toMatchObject([{ version: 1 }, { version: 1 }, { version: 7 }]);
            expect(home.requestsFor('/v1/account/encryption/currentness')).toHaveLength(3);
        }, 'plain');
    });

    it('isolates fresh witness cancellation even when peers use the same signal', async () => {
        const response = createDeferred<void>();
        await withCurrentnessHome({ body: currentness('plain', null), respondAfter: response.promise }, async request => {
            // The HTTP boundary completes or rejects each request under its own AbortSignal.
            const cancellableRequest: ServerFetch = async (path, init) => {
                const result = await request(path, init);
                init?.signal?.throwIfAborted();
                return result;
            };
            const cancelled = new AbortController();
            const retained = new AbortController();
            const first = fetchAccountEncryptionCurrentness({ token }, { request: cancellableRequest, signal: cancelled.signal });
            const second = fetchAccountEncryptionCurrentness({ token }, { request: cancellableRequest, signal: retained.signal });
            const third = fetchAccountEncryptionCurrentness({ token }, { request: cancellableRequest, signal: retained.signal });
            const outcomes = Promise.allSettled([first, second, third]);
            const starts = home.requestsFor('/v1/account/encryption/currentness').length;
            cancelled.abort();
            response.resolve();
            expect(await outcomes).toMatchObject([
                { status: 'rejected', reason: { name: 'AbortError' } },
                { status: 'fulfilled', value: { mode: 'plain' } },
                { status: 'fulfilled', value: { mode: 'plain' } },
            ]);
            expect(starts).toBe(3);
            await expect(fetchAccountEncryptionCurrentness({ token }, { request: cancellableRequest, signal: cancelled.signal }))
                .rejects.toMatchObject({ name: 'AbortError' });
            expect(home.requestsFor('/v1/account/encryption/currentness')).toHaveLength(3);
        }, 'plain');
    });

    it.each([{ status: 401, reason: 'unauthorized' }, { status: 403, reason: 'forbidden' }])(
        'preserves the actual HTTP $status refusal as $reason', async ({ status, reason }) => {
            await withCurrentnessHome({ status, body: { error: 'denied' } }, async request => {
                const error = await captureCurrentnessFailure(resolveAccountStorageContext({ token }, { encryption: null, request }));
                expect(error).toBeInstanceOf(AccountStorageCurrentnessUnavailableError);
                expect(error).toMatchObject({ code: 'account_storage_currentness_unavailable', reason });
                expect(error.cause).toBeInstanceOf(HappyError);
                expect(error.cause).toMatchObject({ status });
            });
        },
    );

    it('preserves scope retirement while wrapping a currentness read failure', async () => {
        const cause = new Error('action_account_scope_changed');
        await withCurrentnessHome({ select: () => { throw cause; } }, async request => {
            const error = await captureCurrentnessFailure(resolveAccountStorageContext({ token }, { encryption: null, request }));
            expect(error).toMatchObject({ reason: 'scope-retired', cause });
            expect(classifyAccountStorageReadFailure(error)).toBe('scope-retired');
        });
    });

    it('refuses an unsupported currentness operation instead of treating HTTP 404 as offline', async () => {
        await withCurrentnessHome({ status: 404, body: { error: 'not_found' } }, async request => {
            const error = await captureCurrentnessFailure(resolveAccountStorageContext({ token }, { encryption: null, request }));
            expect(error).toMatchObject({ code: 'account_storage_currentness_unavailable', reason: 'unsupported' });
            expect(error.cause).toBeInstanceOf(HappyError);
            expect(error.cause).toMatchObject({ status: 404, kind: 'config', code: 'account-encryption-currentness-unavailable' });
        });
    });

    it('preserves a real transport failure as unreachable without changing its cause', async () => {
        const cause = new TypeError('Network request failed');
        await withCurrentnessHome({ select: () => { throw cause; } }, async request => {
            const error = await captureCurrentnessFailure(resolveAccountStorageContext({ token }, { encryption: null, request }));
            expect(error).toMatchObject({ code: 'account_storage_currentness_unavailable', reason: 'unreachable' });
            expect(error.cause).toBe(cause);
        });
    });

    it('rejects a malformed successful currentness response as unavailable encryption material, not offline', async () => {
        await withCurrentnessHome({ body: { mode: 'e2ee', version: 1, updatedAt: 1 } }, async request => {
            const error = await captureCurrentnessFailure(resolveAccountStorageContext({ token }, { encryption: null, request }));
            expect(error).toMatchObject({ code: 'account_storage_currentness_unavailable', reason: 'encryption-material-unavailable' });
            expect(error.cause).toBeInstanceOf(HappyError);
            expect(error.cause).toMatchObject({ status: 200, kind: 'server', code: 'account-encryption-currentness-unavailable' });
        });
    });

    it('preserves an unavailable currentness readiness refusal as unavailable encryption material, not offline', async () => {
        const body = {
            error: 'migration-required',
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_inconsistent' },
        } satisfies AccountEncryptionCurrentnessErrorResponse;
        await withCurrentnessHome({ status: 400, body }, async request => {
            const error = await captureCurrentnessFailure(resolveAccountStorageContext({ token }, { encryption: null, request }));
            expect(error).toMatchObject({ code: 'account_storage_currentness_unavailable', reason: 'encryption-material-unavailable' });
            expect(error.cause).toBeInstanceOf(AccountEncryptionCurrentnessReadinessError);
            expect(error.cause).toMatchObject({ status: 400, code: 'account-encryption-currentness-unavailable',
                recipientEnvelopeReadiness: body.recipientEnvelopeReadiness });
        });
    });

    it.each(['cipher', 'fingerprint'] as const)('classifies explicit missing %s as unavailable encryption material', async missing => {
        const cipher = await Encryption.create(secret);
        await withCurrentnessHome({ body: currentness('e2ee', missing === 'fingerprint' ? null : fingerprint) }, async request => {
            await expect(resolveAccountStorageContext(credentials, { encryption: missing === 'cipher' ? null : cipher, request }))
                .rejects.toMatchObject({ code: 'account_storage_currentness_unavailable', reason: 'encryption-material-unavailable', cause: expect.any(Error) });
        });
    });

    it.each(['material', 'snapshot'] as const)('rejects malformed %s through the real crypto owner', async malformed => {
        const cipher = await Encryption.create(secret);
        const invalidCredentials: AuthCredentials = malformed === 'material'
            ? { token, secret: encodeBase64(new Uint8Array(31), 'base64url') }
            : { token, encryption: { machineKey: encodeBase64(secret, 'base64'), publicKey: encodeBase64(new Uint8Array(32), 'base64') } };
        await withCurrentnessHome({ body: currentness() }, async request => {
            await expect(resolveAccountStorageContext(invalidCredentials, { encryption: cipher, request }))
                .rejects.toMatchObject({ code: 'account_storage_currentness_unavailable', reason: 'encryption-material-unavailable', cause: expect.any(Error) });
        });
    });

    it('rejects a fingerprint mismatch instead of admitting the captured cipher', async () => {
        const cipher = await Encryption.create(secret);
        await withCurrentnessHome({ body: currentness('e2ee', 'another-account-content-fingerprint') }, async request => {
            await expect(resolveAccountStorageContext(credentials, { encryption: cipher, request }))
                .rejects.toMatchObject({ code: 'account_storage_currentness_unavailable', reason: 'encryption-material-unavailable', cause: expect.any(Error) });
        });
    });

    it('rejects the mounted cipher when its real singleton has no matching credential scope', async () => {
        const cipher = await Encryption.create(secret);
        await withCurrentnessHome({ body: currentness() }, async request => {
            // The native accessor reads this public module through require; mount the real app runtime in that same cell.
            const publicRuntime: typeof import('@/sync/sync') = require('../sync.ts');
            publicRuntime.registerSyncRuntime(runtime);
            const mounted = getSyncSingleton();
            expect(mounted === runtime.sync).toBe(true);
            if (!mounted) throw new Error('The real Sync runtime was not registered for the native accessor');
            const previous = mounted.encryption;
            mounted.encryption = cipher;
            try {
                expect(mounted.encryption).toBe(cipher);
                const mountedCredentials = mounted.getCredentials();
                expect(mountedCredentials === null
                    || resolveAuthCredentialsScopeKey(mountedCredentials) !== resolveAuthCredentialsScopeKey(credentials)).toBe(true);
                await expect(resolveAccountStorageContext(credentials, { request }))
                    .rejects.toMatchObject({ code: 'account_storage_currentness_unavailable', reason: 'scope-retired', cause: expect.any(Error) });
            } finally { mounted.encryption = previous; }
        });
    });

    it('admits matching real crypto and leaves genuinely keyless Plain storage keyless', async () => {
        const cipher = await Encryption.create(secret);
        await withCurrentnessHome({ body: currentness() }, async request => {
            expect(await resolveAccountStorageContext(credentials, { encryption: cipher, request })).toEqual({ mode: 'e2ee', encryption: cipher });
        });
        await withCurrentnessHome({ body: currentness('plain', null) }, async request => {
            expect(await resolveAccountStorageContext({ token }, { encryption: null, request })).toEqual({ mode: 'plain', encryption: null });
        }, 'plain');
    });

    it('keeps the compatible cause constructor while giving unclassified failures an explicit reason', () => {
        const cause = new Error('Existing caller');
        const error = new AccountStorageCurrentnessUnavailableError(cause);
        expect(error).toMatchObject({ code: 'account_storage_currentness_unavailable', reason: 'unreachable' });
        expect(error.cause).toBe(cause);
    });
});
