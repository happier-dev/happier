import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { computeContentPublicKeyFingerprint, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { sealSessionDataKeyBundleV0 } from '@happier-dev/protocol/crypto/sessionDataKeyBundleWebCrypto';

import { auth } from '@/app/auth/auth';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { createFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { machineUpdateHandler } from '@/app/api/socket/machineUpdateHandler';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '@/app/api/socket/machineSocketInstallationProof';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';

import { commitMachineRecipientKeyEnvelopesInTx, readMachineRecipientCensusInTx } from './machineAccess';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Machine recipient-envelope currentness', () => {
    const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error('A disposable PostgreSQL contract DATABASE_URL is required');
        vi.stubEnv('HANDY_MASTER_SECRET', 'machine-envelope-currentness-postgres-secret');
        vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        initDbPostgres();
        await db.$connect();
        await auth.init();
    });
    afterAll(async () => {
        await shutdownDbClient();
        if (previousRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
        else process.env.HAPPIER_DB_TX_MAX_RETRIES = previousRetries;
        vi.unstubAllEnvs();
    });

    it('never accepts an old content basis after a real metadata writer commits before the envelope tuple', async () => {
        // Same real signed bindings and encrypted carriers as the Machine
        // currentness SQLite integration; only transport interleaving is added.
        const ownerKeys = tweetnacl.box.keyPair();
        const recipientKeys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(ownerKeys.publicKey) } });
        const recipient = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(recipientKeys.publicKey) } });
        const dataKey = tweetnacl.randomBytes(32);
        const seal = (recipientPublicKey: Uint8Array) => encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey, randomBytes: tweetnacl.randomBytes }));
        const ownerEnvelope = seal(ownerKeys.publicKey);
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, installationId: randomUUID(), dataEncryptionKey: decodeBase64(ownerEnvelope),
            metadata: encodeBase64(await sealSessionDataKeyBundleV0({ host: 'old' }, dataKey)),
            daemonState: encodeBase64(await sealSessionDataKeyBundleV0({ status: 'offline' }, dataKey)),
        } });
        await db.machineGrant.create({ data: { principalKind: 'account', machineId: machine.id, accountId: recipient.id, accessLevel: 'view', createdByAccountId: owner.id } });
        const census = await inTx(tx => readMachineRecipientCensusInTx(tx, { actorAccountId: owner.id, machineId: machine.id }));
        if ('kind' in census) throw new Error(census.code);
        const input = {
            actorAccountId: owner.id, machineId: machine.id,
            expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!,
            expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!,
            expectedMetadataVersion: census.content.metadataVersion,
            expectedDaemonStateVersion: census.content.daemonStateVersion,
            recipientKeyEnvelopes: [{ recipientAccountId: recipient.id, encryptedDataKey: seal(recipientKeys.publicKey),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipientKeys.publicKey) }],
        };
        expect(await inTx(tx => commitMachineRecipientKeyEnvelopesInTx(tx, input))).toMatchObject({ appliedRecipientAccountIds: [recipient.id] });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const socket = Object.assign(createFakeSocket({ data: {
            clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId,
        } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        writeAccountStoredContentCompatibilityForSocket(socket as unknown as Socket,
            evaluateAccountStoredContentSocketCompatibility({ accountStoredContentCompatibility: { v: 1, protocolVersion: 4 } }));
        machineUpdateHandler(owner.id, socket as unknown as Socket, {
            operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } },
        });
        const atTuple = deferred();
        const releaseTuple = deferred();
        let envelopePid = 0;
        let metadataFinished = false;
        let metadataWrite: Promise<unknown> | undefined;
        const callback = vi.fn();
        // Wrap only the Prisma transport. Validation, mutation and publication
        // remain the real canonical owner, with a real existing tuple UPDATE.
        const envelopeOutcome = Promise.allSettled([inTx(async tx => {
            const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
            envelopePid = backend.pid;
            const intercepted = new Proxy(tx, { get(target, property, receiver) {
                if (property !== 'machineKeyEnvelope') return Reflect.get(target, property, receiver);
                return new Proxy(target.machineKeyEnvelope, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== 'upsert') return operation;
                    return async (...args: Parameters<typeof delegate.upsert>) => {
                        atTuple.resolve();
                        await releaseTuple.promise;
                        return Reflect.apply(operation, delegate, args);
                    };
                } });
            } });
            return commitMachineRecipientKeyEnvelopesInTx(intercepted, {
                ...input, recipientKeyEnvelopes: [{ ...input.recipientKeyEnvelopes[0], encryptedDataKey: seal(recipientKeys.publicKey) }],
            });
        })]);
        try {
            await Promise.race([atTuple.promise, envelopeOutcome.then(() => { throw new Error('Envelope owner did not reach the existing tuple'); })]);
            metadataWrite = Promise.resolve(getSocketHandler(socket, 'machine-update-metadata')({
                machineId: machine.id, metadata: encodeBase64(await sealSessionDataKeyBundleV0({ host: 'new' }, dataKey)),
                expectedVersion: machine.metadataVersion, expectedDataEncryptionKey: ownerEnvelope,
            }, callback)).finally(() => { metadataFinished = true; });
            let blocked: Array<{ pid: number; query: string }> = [];
            while (!metadataFinished && blocked.length === 0) {
                blocked = await db.$queryRawUnsafe<Array<{ pid: number; query: string }>>(
                    'SELECT pid, query FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))', envelopePid,
                );
            }
            const peerCommittedBeforeTuple = metadataFinished;
            if (peerCommittedBeforeTuple) {
                await metadataWrite;
                expect(callback).toHaveBeenCalledWith(expect.objectContaining({ result: 'success', version: 1 }));
                expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).metadataVersion).toBe(1);
            }
            releaseTuple.resolve();
            const [outcome] = await envelopeOutcome;
            if (outcome.status === 'rejected') throw outcome.reason;
            console.info('machine-envelope-currentness', { envelopePid, peerCommittedBeforeTuple, blocked, outcome: outcome.value, retries: 0 });
            if (peerCommittedBeforeTuple) expect(outcome.value).toEqual({ kind: 'refused', code: 'machine_key_changed' });
            else expect(outcome.value).toMatchObject({ appliedRecipientAccountIds: [recipient.id] });
            await metadataWrite;
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ result: 'success', version: 1 }));
            expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).metadataVersion).toBe(1);
        } finally {
            releaseTuple.resolve();
            await envelopeOutcome;
            await metadataWrite;
            await db.machine.deleteMany({ where: { id: machine.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
        }
    });
});
