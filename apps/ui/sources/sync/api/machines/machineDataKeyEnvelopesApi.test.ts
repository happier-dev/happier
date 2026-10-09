import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { encodeBase64, decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealEncryptedDataKeyEnvelopeV1, openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { MachineContentKeyTransitionInputV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { MachineRecipientKeyEnvelopeCommitInputV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { AES256Encryption } from '@/sync/encryption/encryptor';
import { prepareMachineDataKeyEnvelopesForScope } from './machineDataKeyEnvelopesApi';

describe('captured Machine recipient preparation transport', () => {
    it('converts historical custody and seals a real recipient under the resource Home, not the focused Home', async () => {
        const owner = nacl.box.keyPair();
        const recipient = nacl.box.keyPair();
        const signing = nacl.sign.keyPair();
        let ownerEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: owner.secretKey, recipientPublicKey: owner.publicKey, randomBytes: nacl.randomBytes }));
        let metadata = encodeBase64((await new AES256Encryption(owner.secretKey).encrypt([{
            host: 'host', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier',
        }]))[0]!);
        let revision = 3;
        let delivered: Uint8Array | null = null;
        const fingerprint = computeContentPublicKeyFingerprint(recipient.publicKey);
        const row = () => ({ id: 'machine', dataEncryptionKey: ownerEnvelope, metadata, metadataVersion: revision, daemonState: null, daemonStateVersion: revision,
            keyBasis: { dataEncryptionKey: ownerEnvelope, metadataVersion: revision, daemonStateVersion: revision },
            access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' } });
        const home = await serveAccountHomes({ homes: [
            { key: 'resource', serverUrl: 'https://machine-custodian.test', accountId: 'alice', accountMode: 'e2ee',
                credentials: { token: 'replaced-by-fixture-subject', encryption: { publicKey: encodeBase64(owner.publicKey), machineKey: encodeBase64(owner.secretKey) } } },
            { key: 'focused', serverUrl: 'https://machine-focused-custodian.test', accountId: 'cara' },
        ], route: async request => {
            if (request.home !== 'resource') return undefined;
            if (request.path === '/v1/machines/machine') return Response.json({ machine: row() });
            if (request.path.endsWith('/content-key/transition')) {
                const input = MachineContentKeyTransitionInputV1Schema.parse(request.body);
                expect(input.expected).toEqual(row().keyBasis);
                ownerEnvelope = input.next.dataEncryptionKey;
                metadata = input.next.metadata;
                revision++;
                return Response.json({ kind: 'committed', machine: row() });
            }
            if (request.path.endsWith('/data-key-envelopes') && request.method === 'PATCH') {
                const input = MachineRecipientKeyEnvelopeCommitInputV1Schema.parse({ machineId: 'machine',
                    ...MachineRecipientKeyEnvelopeCommitInputV1Schema.omit({ machineId: true }).parse(request.body) });
                expect(input.expectedCallerDataEncryptionKey).toBe(ownerEnvelope);
                expect(input.expectedMachineOwnerEnvelopeFingerprint).toBe(computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(ownerEnvelope)));
                expect(input.expectedMetadataVersion).toBe(revision);
                delivered = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(input.recipientKeyEnvelopes[0]!.encryptedDataKey), recipientSecretKeyOrSeed: recipient.secretKey });
                return Response.json({ appliedRecipientAccountIds: ['bob'], skippedRecipientAccountIds: [] });
            }
            if (request.path.endsWith('/data-key-envelopes')) return Response.json({ machineId: 'machine', custodianAccountId: 'alice', encryptionMode: 'e2ee',
                machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(ownerEnvelope)), callerDataEncryptionKey: ownerEnvelope, nextCursor: null,
                content: { metadata, metadataVersion: revision, daemonState: null, daemonStateVersion: revision }, recipients: delivered ? [] : [{ recipientAccountId: 'bob',
                    contentKey: { status: 'available', accountSigningPublicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey: encodeBase64(recipient.publicKey),
                        contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: recipient.publicKey })) },
                    contentPublicKeyFingerprint: fingerprint, encryptedDataKey: null, recipientContentPublicKeyFingerprint: null }] });
            return undefined;
        } });
        try {
            expect(await prepareMachineDataKeyEnvelopesForScope({ scope: { serverId: home.homes.resource!.id, accountId: 'alice' }, machineId: 'machine' })).toEqual({ kind: 'prepared' });
            const currentKey = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(ownerEnvelope), recipientSecretKeyOrSeed: owner.secretKey });
            expect(delivered).toEqual(currentKey);
            expect(delivered).not.toBeNull();
            expect(delivered).not.toEqual(owner.secretKey);
            const physical = home.requests.filter(request => request.path.startsWith('/v1/machines/'));
            expect(physical.every(request => request.home === 'resource' && request.accountId === 'alice')).toBe(true);
            expect(physical.filter(request => request.method === 'POST')).toHaveLength(1);
        } finally { home.dispose(); }
    });
});
