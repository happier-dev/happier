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
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { encryptLegacy } from '../../../../../cli/src/api/encryption';
import { prepareMachineDataKeyEnvelopesForScope } from './machineDataKeyEnvelopesApi';
import { executeMachineAccessHttpAction } from './machineAccessApi';

describe('captured Machine recipient preparation transport', () => {
    it.each(['dataKey', 'legacy', 'mixed-legacy', 'malformed-present'] as const)('prepares %s custody under the resource Home and preserves edited content', async variant => {
        const secret = new Uint8Array(32).fill(27);
        const owner = variant === 'dataKey' ? nacl.box.keyPair() : nacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(secret));
        const recipient = nacl.box.keyPair();
        const signing = nacl.sign.keyPair();
        // Observed ../0.2 f2dd8f01185784676b639cec5cf8a5ed79973301 legacy factory:
        // recovery-secret ciphertext, encryptionVariant='legacy', dataEncryptionKey=null.
        let ownerEnvelope: string | null = variant === 'dataKey' ? encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: owner.secretKey, recipientPublicKey: owner.publicKey, randomBytes: nacl.randomBytes }))
            : variant === 'malformed-present' ? encodeBase64(new Uint8Array([0, 1, 2])) : null;
        const editedMetadata = { host: 'host', platform: 'linux', happyCliVersion: '0.2', homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier', displayName: 'Edited workstation', username: 'alice' };
        const editedState = { status: 'running', pid: 42, httpPort: 4321 };
        let metadata = encodeBase64(variant === 'dataKey' ? (await new AES256Encryption(owner.secretKey).encrypt([editedMetadata]))[0]! : encryptLegacy(editedMetadata, secret));
        let daemonState = encodeBase64(variant === 'dataKey' ? (await new AES256Encryption(owner.secretKey).encrypt([editedState]))[0]! : encryptLegacy(editedState, secret));
        let revision = 3;
        let delivered: Uint8Array | null = null;
        const fingerprint = computeContentPublicKeyFingerprint(recipient.publicKey);
        const row = () => ({ id: 'machine', dataEncryptionKey: ownerEnvelope, metadata, metadataVersion: revision, daemonState, daemonStateVersion: revision,
            keyBasis: { dataEncryptionKey: ownerEnvelope, metadataVersion: revision, daemonStateVersion: revision },
            access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' } });
        const home = await serveAccountHomes({ homes: [
            { key: 'resource', serverUrl: 'https://machine-custodian.test', accountId: 'alice', accountMode: 'e2ee',
                credentials: variant === 'dataKey' ? { token: 'replaced-by-fixture-subject', encryption: { publicKey: encodeBase64(owner.publicKey), machineKey: encodeBase64(owner.secretKey) } }
                    : { token: 'replaced-by-fixture-subject', secret: encodeBase64(secret) } },
            { key: 'focused', serverUrl: 'https://machine-focused-custodian.test', accountId: 'cara' },
        ], route: async request => {
            if (request.home !== 'resource') return undefined;
            if (request.path === '/v1/machines/machine/access' && request.method === 'PUT') return Response.json({
                kind: 'saved', grant: { machineId: 'machine', principal: { kind: 'team', teamId: 'mixed-team' }, level: 'view' },
                readiness: 'refused', canPrepareKeys: true,
            });
            if (request.path === '/v1/machines/machine') return Response.json({ machine: row() });
            if (request.path.endsWith('/content-key/transition')) {
                const input = MachineContentKeyTransitionInputV1Schema.parse(request.body);
                expect(input.expected).toEqual(row().keyBasis);
                ownerEnvelope = input.next.dataEncryptionKey;
                metadata = input.next.metadata;
                daemonState = input.next.daemonState!;
                revision++;
                return Response.json({ kind: 'committed', machine: row() });
            }
            if (request.path.endsWith('/data-key-envelopes') && request.method === 'PATCH') {
                const input = MachineRecipientKeyEnvelopeCommitInputV1Schema.parse({ machineId: 'machine',
                    ...MachineRecipientKeyEnvelopeCommitInputV1Schema.omit({ machineId: true }).parse(request.body) });
                expect(input.expectedCallerDataEncryptionKey).toBe(ownerEnvelope);
                expect(input.expectedMachineOwnerEnvelopeFingerprint).toBe(computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(ownerEnvelope!)));
                expect(input.expectedMetadataVersion).toBe(revision);
                delivered = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(input.recipientKeyEnvelopes[0]!.encryptedDataKey), recipientSecretKeyOrSeed: recipient.secretKey });
                return Response.json({ appliedRecipientAccountIds: ['bob'], skippedRecipientAccountIds: [] });
            }
            if (request.path.endsWith('/data-key-envelopes') && (!ownerEnvelope || variant === 'malformed-present')) return Response.json({ kind: 'refused', code: 'encryption_material_unavailable' }, { status: 409 });
            if (request.path.endsWith('/data-key-envelopes')) return Response.json({ machineId: 'machine', custodianAccountId: 'alice', encryptionMode: 'e2ee',
                machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(ownerEnvelope!)), callerDataEncryptionKey: ownerEnvelope, nextCursor: null,
                content: { metadata, metadataVersion: revision, daemonState, daemonStateVersion: revision }, recipients: [...(delivered ? [] : [{ recipientAccountId: 'bob',
                    contentKey: { status: 'available', accountSigningPublicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey: encodeBase64(recipient.publicKey),
                        contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: recipient.publicKey })) },
                    contentPublicKeyFingerprint: fingerprint, encryptedDataKey: null, recipientContentPublicKeyFingerprint: null }]),
                    ...(variant === 'mixed-legacy' ? [{ recipientAccountId: 'plain-member', contentKey: { status: 'unavailable', reason: 'plain_account' },
                        contentPublicKeyFingerprint: null, encryptedDataKey: null, recipientContentPublicKeyFingerprint: null }] : [])] });
            return undefined;
        } });
        try {
            if (variant === 'malformed-present') {
                expect(await prepareMachineDataKeyEnvelopesForScope({ scope: { serverId: home.homes.resource!.id, accountId: 'alice' }, machineId: 'machine' })).toMatchObject({ kind: 'unavailable' });
                expect(home.requests.some(request => request.method === 'POST' || request.method === 'PATCH')).toBe(false);
                expect(delivered).toBeNull();
                return;
            }
            const scope = { serverId: home.homes.resource!.id, accountId: 'alice' };
            if (variant === 'mixed-legacy') {
                expect(await executeMachineAccessHttpAction({ scope, actionId: 'machines.access.grant.set',
                    input: { serverId: scope.serverId, machineId: 'machine', principal: { kind: 'team', teamId: 'mixed-team' }, level: 'view' },
                })).toMatchObject({ kind: 'saved', readiness: 'refused', canPrepareKeys: true });
            } else {
                expect(await prepareMachineDataKeyEnvelopesForScope({ scope, machineId: 'machine' })).toEqual({ kind: 'prepared' });
            }
            const currentKey = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(ownerEnvelope!), recipientSecretKeyOrSeed: owner.secretKey });
            expect(delivered).toEqual(currentKey);
            expect(delivered).not.toBeNull();
            expect(delivered).not.toEqual(owner.secretKey);
            expect(delivered).not.toEqual(secret);
            expect((await new AES256Encryption(currentKey!).decrypt([decodeBase64(metadata)]))[0]).toEqual(editedMetadata);
            expect((await new AES256Encryption(currentKey!).decrypt([decodeBase64(daemonState)]))[0]).toEqual(editedState);
            const physical = home.requests.filter(request => request.path.startsWith('/v1/machines/'));
            expect(physical.every(request => request.home === 'resource' && request.accountId === 'alice')).toBe(true);
            expect(physical.filter(request => request.method === 'POST')).toHaveLength(1);
        } finally { home.dispose(); }
    });
});
