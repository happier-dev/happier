import { afterEach, describe, expect, it } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { ACCOUNT_MODE_DOWNGRADE_UNVERIFIED } from '@happier-dev/sync-client';
import { installConnectedServicesCommonModuleMocks } from '@/components/settings/connectedServices/connectedServicesTestHelpers';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries,
    type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { encodeBase64 } from '@/encryption/base64';
import type { ServerFetch } from '@/sync/http/client';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

installConnectedServicesCommonModuleMocks();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// Establish the real shared dependencies sequentially before the app runtime, after its transport boundaries.
await import('@/sync/domains/state/storageStore');
await import('@/sync/store/hooks');
await import('@/sync/ops/actions/defaultActionExecutor');
const { Encryption } = await import('./encryption');
const { resolveAccountStorageContext } = await import('./accountStorageContext');
const { fetchAccountEncryptionMode } = await import('@/sync/api/account/apiAccountEncryptionMode');
afterEach(() => resetRuntimeFetch());

const owner = 'mode-downgrade-pin-owner';
const token = createAccountTokenForTests(owner, { currentAccount: true });
const secret = new Uint8Array(32).fill(11);
const credentials: AuthCredentials = { token, secret: encodeBase64(secret, 'base64url') };
const historical: AuthCredentials = { ...credentials, custody: 'historical' };
const keyless: AuthCredentials = { token };
const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint,
);
const currentness = (mode: 'plain' | 'e2ee' = 'e2ee', contentKeyFingerprint: string | null = fingerprint) => ({
    mode, version: 1, signingKeyFingerprint: mode === 'plain' ? null : 'signing-fingerprint', contentKeyFingerprint, updatedAt: 1,
});

async function withCurrentnessHome<T>(answer: HomeDomainAnswer, run: (request: ServerFetch, serverId: string) => Promise<T>, accountEncryptionMode: 'plain' | 'e2ee' = 'e2ee') {
    installHomeGovernanceBoundaries(home);
    setRuntimeFetch(home.request);
    const serverUrl = 'https://mode-downgrade-pin-owner.test';
    const serverId = await home.addHome({ name: 'Mode downgrade pin', serverUrl, accountId: owner, currentAccount: true, accountEncryptionMode });
    home.answer(serverId, 'GET /v1/account/encryption/currentness', answer);
    try {
        return await run((path, init) => home.request(new URL(path, serverUrl), init), serverId);
    } finally { await home.reset(); }
}


const { readAccountSettingsWriteMaterial } = await import('@/sync/engine/settings/accountSettingsWriteMaterial');
const { encodeAccountStoredJsonContent } = await import('./accountStoredJsonContent');

type Outcome = Readonly<{ admitted: string; wire?: string } | { refused: string }>;
const refusal = (error: unknown) => {
    const failure = error as { reason?: string; code?: string; cause?: { code?: string } };
    return { refused: `${failure.reason ?? failure.code}:${failure.cause?.code ?? failure.code}` };
};

async function storageOutcome(held: AuthCredentials, cipher: unknown | null): Promise<Outcome> {
    return await withCurrentnessHome({ body: currentness('plain', null) }, async request => {
        const value = await resolveAccountStorageContext(held, { encryption: cipher as never, request, usage: 'fresh-authority' })
            .catch(error => refusal(error));
        if ('refused' in value) return value;
        const wire = value.mode === 'plain'
            ? JSON.parse(Buffer.from(await encodeAccountStoredJsonContent({ mode: 'plain', value: { probe: true }, encryption: null }), 'base64').toString('utf8')).t
            : 'e2ee';
        return { admitted: value.mode, wire };
    }, 'plain');
}

// Boundary: only the Home HTTP transport is answered by the harness; the
// mode owner, shared decision, storage context and envelope encoder are real.
describe('Account mode downgrade pin (SEC-MODEPIN fix A′)', () => {
    it('refuses a Home-reported plain while this device holds active Account E2EE material', async () => {
        const cipher = await Encryption.create(secret);
        expect(await storageOutcome(credentials, cipher)).toEqual({
            refused: `encryption-material-unavailable:${ACCOUNT_MODE_DOWNGRADE_UNVERIFIED}`,
        });
        const settings = await withCurrentnessHome({ body: currentness('plain', null) }, async request =>
            await readAccountSettingsWriteMaterial({ credentials, encryption: cipher, request })
                .then(value => ({ admitted: value.identity.mode }), error => refusal(error)));
        expect(settings).toEqual({ refused: `${ACCOUNT_MODE_DOWNGRADE_UNVERIFIED}:${ACCOUNT_MODE_DOWNGRADE_UNVERIFIED}` });
        await withCurrentnessHome({ body: currentness('plain', null) }, async (request, serverId) => {
            home.answer(serverId, 'GET /v1/account/encryption', { body: { mode: 'plain', updatedAt: 2 } });
            await expect(fetchAccountEncryptionMode(credentials, { request, usage: 'fresh-authority' }))
                .rejects.toMatchObject({ code: ACCOUNT_MODE_DOWNGRADE_UNVERIFIED, canTryAgain: false });
        });
    });

    it('admits plain for this device\'s historical custody and keeps the material', async () => {
        const cipher = await Encryption.create(secret);
        expect(await storageOutcome(historical, cipher)).toEqual({ admitted: 'plain', wire: 'plain' });
    });

    it('admits plain for a genuinely keyless device', async () => {
        expect(await storageOutcome(keyless, null)).toEqual({ admitted: 'plain', wire: 'plain' });
    });
});
