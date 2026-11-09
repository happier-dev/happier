import { afterEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';

import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { encodeBase64 } from '@/encryption/base64';
import { resolveAccountScopedCryptoMaterialFromCredentials, resolveCurrentAccountScopedCryptoMaterialSnapshot } from './resolveAccountScopedCryptoMaterialFromCredentials';

installTokenStorageWebPlatformMocks();

const secret = new Uint8Array(32).fill(11);
const legacyCredentials: AuthCredentials = { token: 'test-token', secret: encodeBase64(secret, 'base64url') };
const legacySnapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
const machineKey = new Uint8Array(32).fill(12);
const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
const dataKeyCredentials: AuthCredentials = { token: 'test-token', encryption: {
    machineKey: encodeBase64(machineKey, 'base64'), publicKey: encodeBase64(publicKey, 'base64'),
} };
const dataKeySnapshot = createAccountScopedCryptoMaterialSnapshotV1({
    accountEncryptionMode: 'e2ee', material: { type: 'dataKey', machineKey }, dataKeyPublicKey: publicKey,
});

describe('current Account material admission', () => {
    it.each([
        { name: 'legacy', credentials: legacyCredentials, snapshot: legacySnapshot },
        { name: 'dataKey', credentials: dataKeyCredentials, snapshot: dataKeySnapshot },
    ])('admits real matching $name material and refuses a different or absent Account identity', ({ credentials, snapshot }) => {
        const contentKeyFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint);
        expect(resolveCurrentAccountScopedCryptoMaterialSnapshot({ credentials, accountCurrentness: { mode: 'e2ee', contentKeyFingerprint } })).toEqual(snapshot);
        // The raw resolver remains available for callers that already own sealing authority.
        expect(resolveAccountScopedCryptoMaterialFromCredentials(credentials)).toEqual(snapshot.material);
        const otherSnapshot = snapshot === legacySnapshot ? dataKeySnapshot : legacySnapshot;
        const otherFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(otherSnapshot.contentPublicKeyFingerprint);
        expect(resolveCurrentAccountScopedCryptoMaterialSnapshot({ credentials, accountCurrentness: { mode: 'e2ee', contentKeyFingerprint: otherFingerprint } })).toBeNull();
        expect(resolveCurrentAccountScopedCryptoMaterialSnapshot({ credentials, accountCurrentness: { mode: 'e2ee', contentKeyFingerprint: null } })).toBeNull();
        expect(resolveCurrentAccountScopedCryptoMaterialSnapshot({ credentials, accountCurrentness: { mode: 'plain', contentKeyFingerprint: null } })).toBeNull();
        expect(resolveCurrentAccountScopedCryptoMaterialSnapshot({ credentials, accountCurrentness: { mode: 'plain', contentKeyFingerprint } })).toBeNull();
    });

    it('refuses invalid or unavailable credential material and a mismatched data-key pair even when its private-key fingerprint matches', () => {
        const contentKeyFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(dataKeySnapshot.contentPublicKeyFingerprint);
        const mismatchedPair: AuthCredentials = { token: 'test-token', encryption: {
            machineKey: encodeBase64(machineKey, 'base64'),
            publicKey: encodeBase64(tweetnacl.box.keyPair.fromSecretKey(secret).publicKey, 'base64'),
        } };
        const malformed: AuthCredentials = { token: 'test-token', secret: encodeBase64(new Uint8Array(31), 'base64url') };
        for (const credentials of [mismatchedPair, malformed, { token: 'test-token' }]) {
            expect(resolveCurrentAccountScopedCryptoMaterialSnapshot({ credentials, accountCurrentness: { mode: 'e2ee', contentKeyFingerprint } })).toBeNull();
        }
    });
});

describe('Account key pair derivation', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('derives one key pair per credential key lifetime, never answers another Account from it, and drops it when the Account leaves', async () => {
        const browserStorage = installLocalStorageMock();
        try {
            // The scalar multiplication is the derivation's whole cost; count it at the library boundary.
            const derivations = vi.spyOn(tweetnacl.box.keyPair, 'fromSecretKey');
            const fingerprintOf = (snapshot: typeof legacySnapshot) => convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint);
            const accountSecret = new Uint8Array(32).fill(31);
            const accountCredentials: AuthCredentials = { token: 'account-token', secret: encodeBase64(accountSecret, 'base64url') };
            const accountSnapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: accountSecret } });
            const accountCurrentness = { mode: 'e2ee' as const, contentKeyFingerprint: fingerprintOf(accountSnapshot) };
            derivations.mockClear();
            // Workload: one Collection-operation burst; each operation reads equal credentials afresh from its authority.
            for (let operation = 0; operation < 20; operation += 1) {
                expect(resolveCurrentAccountScopedCryptoMaterialSnapshot({
                    credentials: { ...accountCredentials }, accountCurrentness, serverId: 'server-cache',
                })).toEqual(accountSnapshot);
            }
            expect(derivations).toHaveBeenCalledTimes(1);

            // Another Account (other key bytes) gets its own pair, never the retained one.
            const otherSecret = new Uint8Array(32).fill(21);
            const otherCredentials: AuthCredentials = { token: 'other-token', secret: encodeBase64(otherSecret, 'base64url') };
            const otherSnapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: otherSecret } });
            derivations.mockClear();
            expect(resolveCurrentAccountScopedCryptoMaterialSnapshot({ credentials: otherCredentials, accountCurrentness, serverId: 'server-cache' })).toBeNull();
            const other = resolveCurrentAccountScopedCryptoMaterialSnapshot({
                credentials: otherCredentials, serverId: 'server-cache', accountCurrentness: { mode: 'e2ee', contentKeyFingerprint: fingerprintOf(otherSnapshot) },
            });
            expect(other).toEqual(otherSnapshot);
            expect(other?.material).not.toEqual(accountSnapshot.material);
            expect(derivations).toHaveBeenCalledTimes(1);

            // An Account departure through the real credential fan-out drops every retained pair.
            const homeUrl = 'https://material-home.test';
            expect(await TokenStorage.setCredentialsForServerUrl(homeUrl, { serverId: 'server-a' }, { token: 'home-token' })).toBe(true);
            expect(await TokenStorage.removeCredentialsForServerUrl(homeUrl, { serverId: 'server-a' })).toBe(true);
            derivations.mockClear();
            expect(resolveCurrentAccountScopedCryptoMaterialSnapshot({ credentials: accountCredentials, accountCurrentness, serverId: 'server-cache' })).toEqual(accountSnapshot);
            expect(derivations).toHaveBeenCalledTimes(1);
        } finally {
            browserStorage.restore();
        }
    });

    it('never retains a pair derived after its Home signed out, and a re-key replaces the old pair', async () => {
        const browserStorage = installLocalStorageMock();
        try {
            const derivations = vi.spyOn(tweetnacl.box.keyPair, 'fromSecretKey');
            const homeUrl = 'https://material-fence.test';
            const home = { serverId: 'server-fence' };
            const keyed = (fill: number): AuthCredentials => ({ token: 'fence-token', secret: encodeBase64(new Uint8Array(32).fill(fill), 'base64url') });
            const fingerprint = (credentials: AuthCredentials) => convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
                    material: resolveAccountScopedCryptoMaterialFromCredentials(credentials) }).contentPublicKeyFingerprint);
            const captured = keyed(41);
            const before = keyed(42);
            const after = keyed(43);
            const fingerprints = new Map([captured, before, after].map(credentials => [credentials, fingerprint(credentials)]));
            const read = (credentials: AuthCredentials) => resolveCurrentAccountScopedCryptoMaterialSnapshot({ credentials, serverId: home.serverId,
                accountCurrentness: { mode: 'e2ee', contentKeyFingerprint: fingerprints.get(credentials)! } });

            // (1) A read captured these credentials, then the Home signed out while it awaited.
            expect(await TokenStorage.setCredentialsForServerUrl(homeUrl, home, captured)).toBe(true);
            expect(await TokenStorage.removeCredentialsForServerUrl(homeUrl, home)).toBe(true);
            derivations.mockClear();
            expect(read(captured)).not.toBeNull();
            expect(read(captured)).not.toBeNull();
            // Nothing was retained: each late read derives on its own.
            expect(derivations).toHaveBeenCalledTimes(2);

            // (2) Same-Account re-key: the new pair serves, the old one is never retained again.
            expect(await TokenStorage.setCredentialsForServerUrl(homeUrl, home, before)).toBe(true);
            derivations.mockClear();
            read(before);
            read(before);
            expect(derivations).toHaveBeenCalledTimes(1);
            expect(await TokenStorage.setCredentialsForServerUrl(homeUrl, home, after)).toBe(true);
            derivations.mockClear();
            expect(read(after)?.material).toEqual({ type: 'legacy', secret: new Uint8Array(32).fill(43) });
            read(after);
            expect(derivations).toHaveBeenCalledTimes(1);
            derivations.mockClear();
            read(before);
            read(before);
            expect(derivations).toHaveBeenCalledTimes(2);
        } finally {
            browserStorage.restore();
        }
    });
});
