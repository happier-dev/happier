import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER, signAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { decodeMachineStoredContent } from '@/storage/sessionMachineStoredContent';
import { createLegacyLayout0SessionInTx } from '@/app/session/create/createLegacyLayout0Session';
import { writeLegacySessionTupleInTx } from '@/app/session/metadata/writeLegacySessionTuple';
import { createMachineWithInstallationIdentityInTx } from '@/app/machines/machineMutations';
import { readMachineAdmissionFactsInTx } from '@/app/machines/machineAccess';
import { compareAndSwapMachineContentInTx } from '@/app/machines/compareAndSwapMachineContentInTx';

const ciphertext = privacyKit.encodeBase64(new Uint8Array(Array.from({ length: 96 }, (_, i) => i)));
const serialized = JSON.stringify({ t: 'encrypted', c: ciphertext });

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session and Machine opaque content byte storage', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID || !process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await shutdownDbClient(); });

    async function createAccount() {
        const signing = tweetnacl.sign.keyPair();
        const content = tweetnacl.box.keyPair();
        return await db.account.create({ data: {
            publicKey: Buffer.from(signing.publicKey).toString('hex'), encryptionMode: 'e2ee',
            contentPublicKey: new Uint8Array(content.publicKey),
            contentPublicKeySig: new Uint8Array(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: content.publicKey })),
        } });
    }

    it.each([ciphertext, serialized])('stores Session ciphertext bytes while creation and CAS preserve the exact text form', async value => {
        const account = await createAccount();
                const created = await inTx(tx => createLegacyLayout0SessionInTx(tx, {
            accountId: account.id, tag: randomUUID(), metadata: value, agentState: value,
            encryptionMode: 'e2ee', requestedStorageState: undefined, dataEncryptionKey: null,
        }));
        expect(created.metadata).toBe(value);
        expect(created.agentState).toBe(value);
        expect(created).not.toHaveProperty('metadataBytes');
        expect(created).not.toHaveProperty('agentStateBytes');
        const [physical] = await db.$queryRaw<Array<{ metadata: string; metadataBytes: Uint8Array; agentState: string | null; agentStateBytes: Uint8Array | null }>>`
            SELECT "metadata", "metadataBytes", "agentState", "agentStateBytes" FROM "Session" WHERE "id" = ${created.id}`;
        expect(physical!.metadataBytes).toEqual(privacyKit.decodeBase64(ciphertext));
        expect(physical!.agentStateBytes).toEqual(privacyKit.decodeBase64(ciphertext));
        expect(physical!.metadata).not.toBe(value);
        const retry = await inTx(tx => writeLegacySessionTupleInTx(tx, { sessionId: created.id,
            metadata: { ciphertext: value, expectedVersion: created.metadataVersion },
            agentState: { ciphertext: value, expectedVersion: created.agentStateVersion } }));
        expect(retry).toMatchObject({ ok: true, didWrite: false, metadata: { value }, agentState: { value } });
        const changed = await inTx(tx => writeLegacySessionTupleInTx(tx, { sessionId: created.id,
            metadata: { ciphertext: '{}', expectedVersion: created.metadataVersion },
            agentState: { ciphertext: null, expectedVersion: created.agentStateVersion } }));
        expect(changed).toMatchObject({ ok: true, metadata: { value: '{}' }, agentState: { value: null } });
        const cleared = await db.session.findUniqueOrThrow({ where: { id: created.id } });
        expect(cleared.metadataBytes).toBeNull();
        expect(cleared.agentStateBytes).toBeNull();
    });

    it('reads historical Session text and keeps accepted noncanonical text unchanged', async () => {
        const account = await createAccount();
                const legacy = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: ciphertext, agentState: serialized } });
        const read = await inTx(tx => writeLegacySessionTupleInTx(tx, { sessionId: legacy.id,
            metadata: { ciphertext, expectedVersion: legacy.metadataVersion } }));
        expect(read).toMatchObject({ ok: true, didWrite: false, metadata: { value: ciphertext }, agentState: { value: serialized } });
        for (const value of ['{}', 'YQ', 'YR==', '{ "t": "encrypted", "c": "YQ==" }']) {
            const created = await inTx(tx => createLegacyLayout0SessionInTx(tx, { accountId: account.id, tag: randomUUID(),
                metadata: value, agentState: value, encryptionMode: 'e2ee', requestedStorageState: undefined, dataEncryptionKey: null }));
            const persisted = await db.session.findUniqueOrThrow({ where: { id: created.id } });
            expect(persisted).toMatchObject({ metadata: value, metadataBytes: null, agentState: value, agentStateBytes: null });
        }
    });

    it('leaves canonical plain Machine content in its original text representation', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const metadata = encodePlainMachineStoredContent({ host: 'plain-machine' });
        const daemonState = encodePlainMachineStoredContent({ status: 'running' });
                const { machine } = await inTx(tx => createMachineWithInstallationIdentityInTx(tx, {
            accountId: account.id, machineId: randomUUID(), metadata, daemonState, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            installationIdentity: null, contentPublicKeyFingerprint: null, replacementReason: 'test',
        }));
        expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toMatchObject({ metadata, daemonState, metadataBytes: null, daemonStateBytes: null });
    });

    it('stores Machine registration and CAS ciphertext bytes and clears stale bytes on plain/null replacement', async () => {
        const account = await createAccount();
                const { machine } = await inTx(tx => createMachineWithInstallationIdentityInTx(tx, {
            accountId: account.id, machineId: randomUUID(), kind: 'ephemeral_session_runner', metadata: ciphertext,
            daemonState: serialized, dataEncryptionKey: null, installationIdentity: null, contentPublicKeyFingerprint: null, replacementReason: 'test',
        }));
        expect(machine).toMatchObject({ metadata: ciphertext, daemonState: serialized });
        expect(machine).not.toHaveProperty('metadataBytes');
        expect(machine).not.toHaveProperty('daemonStateBytes');
        // PostgreSQL Machine admission and managed-wake owners load this m.* shape.
        const [rawProjection] = await db.$queryRaw<Array<{ metadata: string; daemonState: string }>>`
            SELECT m.* FROM "Machine" m WHERE m."id" = ${machine.id}`.then(decodeMachineStoredContent);
        expect(rawProjection).toMatchObject({ metadata: ciphertext, daemonState: serialized });
        expect(rawProjection).not.toHaveProperty('metadataBytes');
        expect(rawProjection).not.toHaveProperty('daemonStateBytes');
        const stored = await db.machine.findUniqueOrThrow({ where: { id: machine.id } });
        expect(stored.metadataBytes).toEqual(privacyKit.decodeBase64(ciphertext));
        expect(stored.daemonStateBytes).toEqual(privacyKit.decodeBase64(ciphertext));
        expect(await inTx(tx => readMachineAdmissionFactsInTx(tx, { actorAccountId: account.id, machineId: machine.id })))
            .toMatchObject({ metadata: ciphertext, daemonState: serialized });
        const changed = await inTx(tx => compareAndSwapMachineContentInTx({ tx, accountId: account.id, machineId: machine.id,
            expected: { metadataVersion: machine.metadataVersion, daemonStateVersion: machine.daemonStateVersion, dataEncryptionKey: null },
            next: { metadata: '{}', daemonState: null, dataEncryptionKey: null } }));
        expect(changed).toBe(true);
        expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).toMatchObject({ metadata: '{}', metadataBytes: null, daemonState: null, daemonStateBytes: null });
    });
});
