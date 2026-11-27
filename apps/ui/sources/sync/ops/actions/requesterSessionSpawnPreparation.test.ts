import { describe, expect, it } from 'vitest';

import { buildRequesterSessionCreationContext, readRequesterSessionSpawnDisposition, resolveRequesterSessionSpawnDisposition } from './requesterSessionSpawnPreparation';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import tweetnacl from 'tweetnacl';

describe('requester Session spawn credential disposition', () => {
    it('hands another Machine the Account content key that opens Bob\'s content, never his recovery secret', async () => {
        const secret = tweetnacl.randomBytes(32);
        const credentials = { token: 'bob-token', secret: encodeBase64(secret, 'base64url') };
        expect(buildRequesterSessionCreationContext('plain', credentials)).toEqual({
            v: 1, disposition: 'ordinary_requester', credentials: { token: 'bob-token' },
        });
        const sent = buildRequesterSessionCreationContext('e2ee', credentials).credentials;
        const wire = JSON.stringify(sent);
        expect('secret' in sent).toBe(false);
        // Boolean assertion: a failure must not print key material.
        for (const encoding of ['base64', 'base64url'] as const) expect(wire.includes(encodeBase64(secret, encoding))).toBe(false);
        // The guest's own sign-in owner derives this content key pair from the same secret.
        const bob = await Encryption.create(secret);
        expect(sent.encryption?.publicKey).toBe(encodeBase64(bob.contentDataKey, 'base64'));
        const sessionKey = tweetnacl.randomBytes(32);
        const envelope = sealEncryptedDataKeyEnvelopeV1({ dataKey: sessionKey, recipientPublicKey: bob.contentDataKey,
            randomBytes: tweetnacl.randomBytes });
        expect(openEncryptedDataKeyEnvelopeV1({ envelope,
            recipientSecretKeyOrSeed: decodeBase64(sent.encryption!.machineKey, 'base64') })).toEqual(sessionKey);
    });

    it('sends a content-key-only device\'s credentials unchanged', () => {
        const encryption = { publicKey: encodeBase64(new Uint8Array(32).fill(8), 'base64'),
            machineKey: encodeBase64(new Uint8Array(32).fill(7), 'base64') };
        expect(buildRequesterSessionCreationContext('e2ee', { token: 'bob-token', encryption })).toEqual({
            v: 1, disposition: 'ordinary_requester', credentials: { token: 'bob-token', encryption },
        });
    });
    it('uses ready published custody for an owned Machine without reopening the grant list', async () => {
        await expect(readRequesterSessionSpawnDisposition({
            accountId: 'alice', machineId: 'machine',
            publishedAccess: { custodian: { accountId: 'alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
            readAccess: async () => { throw new Error('Addressed access unavailable'); },
        })).resolves.toEqual({ kind: 'own' });
    });

    it('uses current addressed access for cold Homes and never treats pending, refused or substituted access as custodian execution', () => {
        const custodian = { accountId: 'alice', displayName: 'Alice' };
        const access = { machineId: 'machine', custodian,
            access: { custodian, role: 'use', resourceMode: 'plain', accessState: 'ready' },
            canManage: false, grants: [], ownDirectGrant: true, ownAccessSources: [] };
        expect(resolveRequesterSessionSpawnDisposition({ accountId: 'bob', machineId: 'machine', access })).toMatchObject({ kind: 'requester' });
        expect(resolveRequesterSessionSpawnDisposition({ accountId: 'alice', machineId: 'machine', access })).toEqual({ kind: 'own' });
        for (const unavailable of [
            { kind: 'refused', code: 'access_denied' },
            { ...access, machineId: 'substituted-machine' },
            { ...access, access: { ...access.access, accessState: 'key_pending' } },
        ]) expect(resolveRequesterSessionSpawnDisposition({ accountId: 'bob', machineId: 'machine', access: unavailable })).toMatchObject({ kind: 'refused' });
    });
});
