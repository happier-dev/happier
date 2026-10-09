import { beforeAll, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { AES256Encryption } from './encryptor';
import type { MachineAccessRecipientCensusResponseV1, MachineRecipientKeyEnvelopeCommitInputV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { prepareCurrentMachineDataKeyEnvelopes } from './prepareCurrentMachineDataKeyEnvelopes';
import { Encryption } from './encryption';
import type { MachinePublishedRowV1 } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';

const key = new Uint8Array(32).fill(37);
const holder = nacl.box.keyPair();
const recipient = nacl.box.keyPair();
const signing = nacl.sign.keyPair();
const ownerEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: holder.publicKey, randomBytes: nacl.randomBytes }));
const fingerprint = computeContentPublicKeyFingerprint(recipient.publicKey);
const page: MachineAccessRecipientCensusResponseV1 = {
    machineId: 'machine', custodianAccountId: 'offline-custodian', encryptionMode: 'e2ee',
    machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(ownerEnvelope)), callerDataEncryptionKey: ownerEnvelope,
    nextCursor: null,
    content: { metadata: '', metadataVersion: 3, daemonState: null, daemonStateVersion: 4 },
    recipients: [{ recipientAccountId: 'later-team-member', contentKey: {
        status: 'available', accountSigningPublicKey: Array.from(signing.publicKey, byte => byte.toString(16).padStart(2, '0')).join(''),
        contentPublicKey: encodeBase64(recipient.publicKey), contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: recipient.publicKey })),
    }, contentPublicKeyFingerprint: fingerprint, encryptedDataKey: null, recipientContentPublicKeyFingerprint: null }],
};
beforeAll(async () => {
    page.content.metadata = encodeBase64((await new AES256Encryption(key).encrypt([{
        host: 'host', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier',
    }]))[0]!);
});

describe('Machine current key preparation', () => {
    it('converts historical owner content once, preserving raw private bytes even after a lost acknowledgement', async () => {
        const encryption = await Encryption.createFromContentKeyPair({ publicKey: holder.publicKey, machineKey: holder.secretKey });
        const rawPrivate = { status: 'running', privateWorkspace: { token: 'must-not-disclose' } };
        const historical = new AES256Encryption(holder.secretKey);
        let row: MachinePublishedRowV1 = { id: 'machine', dataEncryptionKey: null, metadataVersion: 3, daemonStateVersion: 4,
            metadata: encodeBase64((await historical.encrypt([{ host: 'host', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier' }]))[0]!),
            daemonState: encodeBase64((await historical.encrypt([rawPrivate]))[0]!), storageMode: 'e2ee' };
        let transmissions = 0;
        const prepared = await encryption.prepareMachineContentKey({ machineId: 'machine', custodianAccountId: 'owner', accountMode: 'e2ee',
            observe: async () => row,
            transition: async input => { transmissions++; row = { ...row, ...input.next, metadataVersion: 4, daemonStateVersion: 5 }; throw new Error('lost acknowledgement'); },
            isCurrent: () => true,
        });
        expect(transmissions).toBe(1);
        expect(prepared.encryptionKey).not.toEqual(holder.secretKey);
        expect(await encryption.readTransferableMachineDataKey(row.dataEncryptionKey!)).toEqual(prepared.encryptionKey);
        expect(await new AES256Encryption(prepared.encryptionKey!).decrypt([decodeBase64(row.daemonState!)])).toEqual([rawPrivate]);
        const patchPage = vi.fn();
        expect(await prepareCurrentMachineDataKeyEnvelopes({ serverId: 'home', machineId: 'machine', transport: {
            fetchPage: async () => ({ ...page, callerDataEncryptionKey: row.dataEncryptionKey!, machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(decodeBase64(row.dataEncryptionKey!)),
                content: { metadata: row.metadata!, metadataVersion: 4, daemonState: row.daemonState, daemonStateVersion: 5 } }), patchPage,
        }, resolveTransferableMachineDataKey: async () => prepared.encryptionKey, isHostScopeCurrent: () => true })).toEqual({ kind: 'pending_holder' });
        expect(patchPage).not.toHaveBeenCalled();
    });
    it('custodian material selection rejects Account borrowing and opens an independent current owner key', async () => {
        const encryption = await Encryption.createFromContentKeyPair({ publicKey: holder.publicKey, machineKey: holder.secretKey });
        const borrowedEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: holder.secretKey, recipientPublicKey: holder.publicKey, randomBytes: nacl.randomBytes }));
        expect(await encryption.readTransferableMachineDataKey(borrowedEnvelope)).toBeNull();
        expect(await encryption.readTransferableMachineDataKey(ownerEnvelope)).toEqual(key);
    });
    it('seals the current Manage holder key to a later member without a custodian RPC', async () => {
        let committed = false;
        const fetchPage = vi.fn(async () => ({ ...page, recipients: committed ? [] : page.recipients }));
        const patchPage = vi.fn(async (request: MachineRecipientKeyEnvelopeCommitInputV1) => {
            expect(request.expectedMachineOwnerEnvelopeFingerprint).toBe(page.machineOwnerEnvelopeFingerprint);
            expect(request.expectedCallerDataEncryptionKey).toBe(ownerEnvelope);
            expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(request.recipientKeyEnvelopes[0].encryptedDataKey), recipientSecretKeyOrSeed: recipient.secretKey })).toEqual(key);
            committed = true;
            return { appliedRecipientAccountIds: ['later-team-member'], skippedRecipientAccountIds: [] };
        });
        expect(await prepareCurrentMachineDataKeyEnvelopes({ serverId: 'home', machineId: 'machine', transport: { fetchPage, patchPage },
            resolveTransferableMachineDataKey: async current => openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(current.callerDataEncryptionKey!), recipientSecretKeyOrSeed: holder.secretKey }),
            isHostScopeCurrent: () => true,
        })).toEqual({ kind: 'prepared' });
        expect(committed).toBe(true);
    });

    it('settles Plain permission-only without opening fictional material', async () => {
        const resolveTransferableMachineDataKey = vi.fn(async () => null);
        const patchPage = vi.fn();
        expect(await prepareCurrentMachineDataKeyEnvelopes({ serverId: 'home', machineId: 'machine', transport: {
            fetchPage: async () => ({ ...page, encryptionMode: 'plain', callerDataEncryptionKey: null, recipients: [] }), patchPage,
        }, resolveTransferableMachineDataKey, isHostScopeCurrent: () => true })).toEqual({ kind: 'prepared' });
        expect(resolveTransferableMachineDataKey).not.toHaveBeenCalled();
        expect(patchPage).not.toHaveBeenCalled();
    });

    it('holds pending when the current key is not transferable and never patches', async () => {
        const patchPage = vi.fn();
        expect(await prepareCurrentMachineDataKeyEnvelopes({ serverId: 'home', machineId: 'machine', transport: { fetchPage: async () => page, patchPage },
            resolveTransferableMachineDataKey: async () => null, isHostScopeCurrent: () => true,
        })).toEqual({ kind: 'pending_holder' });
        expect(patchPage).not.toHaveBeenCalled();
    });

    it('refuses a Plain recipient of E2EE without sealing', async () => {
        const patchPage = vi.fn();
        expect(await prepareCurrentMachineDataKeyEnvelopes({ serverId: 'home', machineId: 'machine', transport: {
            fetchPage: async () => ({ ...page, recipients: [{ ...page.recipients[0]!, contentKey: { status: 'unavailable', reason: 'plain_account' } }] }), patchPage,
        }, resolveTransferableMachineDataKey: async () => key, isHostScopeCurrent: () => true })).toEqual({ kind: 'recipient_incompatible' });
        expect(patchPage).not.toHaveBeenCalled();
    });

    it('retires an opened key when owner basis changes before preparation', async () => {
        let current = true;
        const patchPage = vi.fn();
        expect(await prepareCurrentMachineDataKeyEnvelopes({ serverId: 'home', machineId: 'machine', transport: { fetchPage: async () => page, patchPage },
            resolveTransferableMachineDataKey: async () => { current = false; return key; }, isHostScopeCurrent: () => current,
        })).toEqual({ kind: 'unavailable', code: 'machine_key_changed' });
        expect(patchPage).not.toHaveBeenCalled();
    });

    it('does not disclose a key when any part of the whole blob retains private work', async () => {
        const privateState = encodeBase64((await new AES256Encryption(key).encrypt([
            { status: 'running', workspaceSync: { relationships: [{ id: 'private-relationship', targetPath: '/private/project' }] } },
        ]))[0]!);
        const patchPage = vi.fn();
        expect(await prepareCurrentMachineDataKeyEnvelopes({ serverId: 'home', machineId: 'machine', transport: {
            fetchPage: async () => ({ ...page, content: { ...page.content, daemonState: privateState } }), patchPage,
        }, resolveTransferableMachineDataKey: async () => key, isHostScopeCurrent: () => true })).toEqual({ kind: 'pending_holder' });
        expect(patchPage).not.toHaveBeenCalled();
    });
});
