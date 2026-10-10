import { afterEach, describe, expect, it } from 'vitest';
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

installConnectedServicesCommonModuleMocks();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// Establish the real shared dependencies sequentially before the app runtime, after its transport boundaries.
await import('@/sync/domains/state/storageStore');
await import('@/sync/store/hooks');
await import('@/sync/ops/actions/defaultActionExecutor');
const runtime = await import('@/sync/syncEngine');
const { Encryption } = await import('./encryption');
const { AccountStorageCurrentnessUnavailableError, resolveAccountStorageContext } = await import('./accountStorageContext');
const { AccountEncryptionCurrentnessReadinessError } = await import('@/sync/api/account/apiAccountEncryptionMode');
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
