import { randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';

import {
    applyHomeRemoteAlertPreparedContextMutation,
    buildHomeRemoteAlertPreparedCredential,
    parseHomeRemoteAlertPreparedContextEnvelope,
    type HomeRemoteAlertPreparedContextV1,
} from './homeRemoteAlertPreparedContext';

function context(overrides: Partial<HomeRemoteAlertPreparedContextV1> = {}): HomeRemoteAlertPreparedContextV1 {
    return {
        v: 1,
        serverId: 'home-a',
        apiEndpoint: 'https://a.example.test',
        accountId: 'account-a',
        credential: { token: 'token-a', encryptionMode: 'plain' },
        settingsVersion: 4,
        accountEncryptionVersion: 2,
        registrationId: 'registration-a',
        pushToken: 'ExponentPushToken[a]',
        previewCeiling: 'include_preview',
        ...overrides,
    };
}

describe('native remote-alert exact-Home prepared context', () => {
    it('atomically replaces only the matching Home and Account generation', () => {
        const first = applyHomeRemoteAlertPreparedContextMutation(null, { kind: 'upsert', context: context() });
        const second = applyHomeRemoteAlertPreparedContextMutation(first, {
            kind: 'upsert',
            context: context({
                serverId: 'home-b',
                apiEndpoint: 'https://b.example.test',
                accountId: 'account-b',
                credential: { token: 'token-b', encryptionMode: 'e2ee', machineKey: 'machine-key-b' },
                settingsVersion: 9,
                registrationId: 'registration-b',
                pushToken: 'ExponentPushToken[b]',
                previewCeiling: 'status_only',
            }),
        });
        const replaced = applyHomeRemoteAlertPreparedContextMutation(second, {
            kind: 'upsert',
            context: context({ credential: { token: 'token-a-new', encryptionMode: 'plain' }, settingsVersion: 5 }),
        });

        expect(replaced?.homes).toHaveLength(2);
        expect(replaced?.homes.find((row) => row.serverId === 'home-a')).toMatchObject({
            settingsVersion: 5,
            credential: { token: 'token-a-new', encryptionMode: 'plain' },
        });
        expect(replaced?.homes.find((row) => row.serverId === 'home-b')).toMatchObject({
            accountId: 'account-b',
            credential: { token: 'token-b', encryptionMode: 'e2ee', machineKey: 'machine-key-b' },
        });
    });

    it('removes revoked generations and never accepts malformed or cross-mode key material', () => {
        const prepared = applyHomeRemoteAlertPreparedContextMutation(null, { kind: 'upsert', context: context() });
        expect(applyHomeRemoteAlertPreparedContextMutation(prepared, {
            kind: 'remove', serverId: 'home-a', accountId: 'account-a', registrationId: 'stale-registration',
        })).toEqual(prepared);
        expect(applyHomeRemoteAlertPreparedContextMutation(prepared, {
            kind: 'remove', serverId: 'home-a', accountId: 'account-a', registrationId: 'registration-a',
        })).toBeNull();

        expect(parseHomeRemoteAlertPreparedContextEnvelope(JSON.stringify({
            v: 1,
            homes: [context({ credential: { token: 'token', encryptionMode: 'plain', machineKey: 'leak' } as never })],
        }))).toBeNull();
        expect(parseHomeRemoteAlertPreparedContextEnvelope('{not-json')).toBeNull();
    });

    it('revokes every Account prepared for a Home when its canonical credential changes', () => {
        const first = applyHomeRemoteAlertPreparedContextMutation(null, { kind: 'upsert', context: context() });
        const second = applyHomeRemoteAlertPreparedContextMutation(first, {
            kind: 'upsert',
            context: context({ accountId: 'account-b', registrationId: 'registration-b' }),
        });

        expect(applyHomeRemoteAlertPreparedContextMutation(second, {
            kind: 'remove_home', serverId: 'home-a',
        })).toBeNull();
    });

    it('admits encrypted custody only with exact mode-bound key material', () => {
        expect(parseHomeRemoteAlertPreparedContextEnvelope(JSON.stringify({
            v: 1,
            homes: [context({ credential: { token: 'token', encryptionMode: 'e2ee', machineKey: 'machine-key' } })],
        }))?.homes[0]?.credential).toEqual({
            token: 'token', encryptionMode: 'e2ee', machineKey: 'machine-key',
        });
        expect(parseHomeRemoteAlertPreparedContextEnvelope(JSON.stringify({
            v: 1,
            homes: [context({ credential: { token: 'token', encryptionMode: 'legacy_e2ee', machineKey: 'legacy-seed' } })],
        }))?.homes[0]?.credential).toEqual({
            token: 'token', encryptionMode: 'legacy_e2ee', machineKey: 'legacy-seed',
        });
    });

    it('hands native the Account content key that opens Session data keys for both credential forms', () => {
        const bytes = (length: number) => new Uint8Array(randomBytes(length));
        const recoverySecret = bytes(32);
        const dataKeyPair = tweetnacl.box.keyPair();
        const cases = [
            { credentials: { token: 'token', secret: encodeBase64(recoverySecret, 'base64url') },
                contentPublicKey: tweetnacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(recoverySecret)).publicKey },
            { credentials: { token: 'token', encryption: {
                publicKey: encodeBase64(dataKeyPair.publicKey), machineKey: encodeBase64(dataKeyPair.secretKey) } },
                contentPublicKey: dataKeyPair.publicKey },
        ];
        for (const { credentials, contentPublicKey } of cases) {
            const sessionDataKey = bytes(32);
            // The Home seals the viewer's Session data key to the Account content public key.
            const envelope = sealEncryptedDataKeyEnvelopeV1({ dataKey: sessionDataKey, recipientPublicKey: contentPublicKey, randomBytes: bytes });
            const credential = buildHomeRemoteAlertPreparedCredential(credentials, 'e2ee');
            if (!credential || credential.encryptionMode === 'plain') throw new Error('expected encrypted credential');
            // Native opens with the canonical envelope codec from standard base64.
            expect(openEncryptedDataKeyEnvelopeV1({ envelope, recipientSecretKeyOrSeed: decodeBase64(credential.machineKey, 'base64') }))
                .toEqual(sessionDataKey);
        }
    });
});
