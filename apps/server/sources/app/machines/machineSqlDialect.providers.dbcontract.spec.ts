import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { ManagedWakeTargetV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { lockMachinePublicationInTx, resolveMachineTargetAdmissionsInTx } from './machineAccess';
import { createCreatorFixture } from './managed/managedCreatorAccess.testkit';
import { readManagedWakeTargetBindingsInTx } from './managed/managedWakeBinding';
import { readManagedWakeSessionsInTx, readPendingManagedWakeTargetsInTx } from './managed/managedWakePlacement';
import { readManagedWakePublicationAccountIdsInTx } from './managed/managedWakePublicationAudience';

/** Observe SQL at the real database boundary without replacing internal decisions or queries. */
function observeRawSql(tx: Tx) {
    const statements: string[] = [];
    return { statements, tx: new Proxy(tx, { get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== '$queryRawUnsafe') return typeof value === 'function' ? value.bind(target) : value;
        return (...args: unknown[]) => {
            if (typeof args[0] === 'string') statements.push(args[0]);
            return Reflect.apply(value, target, args);
        };
    } }) };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Machine PostgreSQL-compatible SQL profiles', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run only through the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', `srv_${'a'.repeat(32)}`);
    });
    afterAll(async () => { vi.unstubAllEnvs(); await db.$disconnect(); });

    describe.each(['postgres', 'pglite'])('%s backend profile on real PostgreSQL', backend => {
        async function withProfile<T>(read: () => Promise<T>) {
            const previous = process.env.HAPPIER_DB_PROVIDER;
            try { process.env.HAPPIER_DB_PROVIDER = backend; return await read(); }
            finally {
                if (previous === undefined) delete process.env.HAPPIER_DB_PROVIDER;
                else process.env.HAPPIER_DB_PROVIDER = previous;
            }
        }

        it('keeps mixed-requester admission facts and recipient material in PostgreSQL set queries', async () => {
            const account = async () => {
                const keys = tweetnacl.box.keyPair();
                return { ...await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } }), keys };
            };
            const owner = await account();
            const recipient = await account();
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
                installationId: randomUUID(), metadata: 'encrypted-metadata', daemonState: 'encrypted-state',
                dataEncryptionKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
                    recipientPublicKey: owner.keys.publicKey, randomBytes: tweetnacl.randomBytes }) } });
            await db.machineGrant.create({ data: { principalKind: 'account', machineId: machine.id,
                accountId: recipient.id, accessLevel: 'view', createdByAccountId: owner.id } });
            await withProfile(() => inTx(async tx => {
                const observed = observeRawSql(tx);
                expect(await resolveMachineTargetAdmissionsInTx(observed.tx, [
                    { actorAccountId: owner.id, machineId: machine.id },
                    { actorAccountId: recipient.id, machineId: machine.id },
                ])).toMatchObject([{ kind: 'admitted', machineId: machine.id }, { kind: 'denied', code: 'recipient_key_pending' }]);
                // Each distinct bulk acquisition must use the PostgreSQL-compatible dialect,
                // rather than the portable per-model path selected by backend identity.
                expect.soft(observed.statements.filter(sql => sql.includes('LEFT JOIN "ManagedMachine" managed'))).toHaveLength(1);
                expect.soft(observed.statements.filter(sql => sql.includes('FROM "Account" WHERE "id" = ANY'))).toHaveLength(1);
                expect.soft(observed.statements.filter(sql => sql.includes('FROM "MachineKeyEnvelope" e'))).toHaveLength(1);
            }));
        });

        it('takes the Machine publication row lock', async () => {
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
            await withProfile(() => inTx(async tx => {
                const observed = observeRawSql(tx);
                await lockMachinePublicationInTx(observed.tx, machine.id);
                expect(observed.statements.filter(sql => sql.includes('FOR NO KEY UPDATE'))).toHaveLength(1);
            }));
        });

        it('projects a bound guest and its controller through PostgreSQL set queries', async () => {
            const { custodian, controller, row, launch } = await createCreatorFixture();
            const guest = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
                metadata: encodePlainMachineStoredContent({}), installationId: randomUUID(),
                dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
            await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: guest.id,
                allocation: 'bound', creationState: 'active', desired: 'stop',
                resource: { contributionRef: launch.provider, schemaVersion: 1, value: {} },
                observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' } } });
            await withProfile(() => inTx(async tx => {
                const observed = observeRawSql(tx);
                expect(await readManagedWakeTargetBindingsInTx(observed.tx, [{ actorAccountId: custodian.id, machineId: guest.id }]))
                    .toMatchObject([{ binding: { managedId: row.id, enrolledMachineId: guest.id }, controllerAccountId: custodian.id }]);
                expect.soft(observed.statements.filter(sql => sql.includes('FROM "ManagedMachine" WHERE "enrolledMachineId"'))).toHaveLength(1);
                expect.soft(observed.statements.filter(sql => sql.includes("jsonb_build_object('status'"))).toHaveLength(1);
            }));
        });

        it('reads retained wake Sessions and missing pending input through PostgreSQL set queries', async () => {
            const { homeId, custodian, row } = await createCreatorFixture();
            const session = await db.session.create({ data: { accountId: custodian.id, tag: randomUUID(), metadata: '{}' } });
            const requestedAt = new Date();
            const pendingRequestId = randomUUID();
            const target = ManagedWakeTargetV1Schema.parse({ homeId, managedId: row.id, enrolledMachineId: randomUUID(), expectedIntentRevision: 0, reason: 'admitted-work',
                origin: { kind: 'session-input', session: { homeId, sessionId: session.id }, pendingRequestId, requestedAt: requestedAt.getTime() } });
            await db.session.update({ where: { id: session.id }, data: { pendingActivationStatus: 'waiting',
                pendingActivationManagedTarget: target, pendingActivationRequestId: pendingRequestId, pendingActivationRequestedAt: requestedAt } });
            await withProfile(() => inTx(async tx => {
                const observed = observeRawSql(tx);
                const sessions = await readManagedWakeSessionsInTx(observed.tx, [session.id, session.id]);
                expect(sessions).toMatchObject([{ id: session.id, pendingActivationRequestId: pendingRequestId }]);
                expect(await readPendingManagedWakeTargetsInTx(observed.tx, sessions)).toEqual(new Map());
                expect.soft(observed.statements.filter(sql => sql.includes('FROM "Session" WHERE "id" = ANY'))).toHaveLength(1);
                expect.soft(observed.statements.filter(sql => sql.includes('FROM "SessionPendingMessage" p'))).toHaveLength(1);
            }));
        });

        it('publishes the Machine custodian audience through one PostgreSQL set query', async () => {
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
            await withProfile(() => inTx(async tx => {
                const observed = observeRawSql(tx);
                expect(await readManagedWakePublicationAccountIdsInTx(observed.tx, {
                    machineTargets: [{ accountId: owner.id, machineId: machine.id }], sessionIds: [],
                })).toEqual([owner.id]);
                expect(observed.statements.filter(sql => sql.includes('SELECT "accountId" FROM "Machine"'))).toHaveLength(1);
            }));
        });
    });
});
