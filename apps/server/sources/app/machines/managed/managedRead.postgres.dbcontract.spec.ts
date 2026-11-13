import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { db, initDbPostgres } from '@/storage/db';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { createCreatorFixture } from './managedCreatorAccess.testkit';
import { listManagedMachines, readManagedResourceDependenciesInTx } from './managedRead';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { readManagedWakeTargets } from './managedWake';
import { enqueuePendingMessageByAuthenticatedMachine } from '@/app/session/pending/pendingMessageService';
import { ManagedWakeTargetV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';

/** Observe materialized storage rows without replacing queries or internal decisions. */
async function measureManagedRows<T>(read: () => Promise<T>) {
    let rows = 0;
    let machineRows = 0;
    let candidateQueries = 0;
    let largestIdSet = 0;
    let managedQueries = 0;
    let sessionPointReads = 0;
    const observeIdSets = (input: unknown): void => {
        if (!input || typeof input !== 'object') return;
        for (const [key, value] of Object.entries(input)) {
            if (key === 'in' && Array.isArray(value)) largestIdSet = Math.max(largestIdSet, value.length);
            else observeIdSets(value);
        }
    };
    const original = db.$transaction;
    const observe = (tx: Tx): Tx => new Proxy(tx, {
        get(owner, key, receiver) {
            const value: unknown = Reflect.get(owner, key, receiver);
            if (!['managedMachine', 'machine', 'session', 'automationRun', 'machineGrant', 'teamMembership', 'teamGroupMembership', 'machineGrant', 'machineGrant'].includes(String(key))
                || !value || typeof value !== 'object') return typeof value === 'function' ? value.bind(owner) : value;
            return new Proxy(value, {
                get(model, method, modelReceiver) {
                    const call: unknown = Reflect.get(model, method, modelReceiver);
                    if (typeof call !== 'function') return call;
                    if (method !== 'findMany' && !(key === 'session' && method === 'findUnique')) return call.bind(model);
                    return async (...args: unknown[]) => {
                        args.forEach(observeIdSets);
                        if (key === 'managedMachine') managedQueries += 1;
                        if (key === 'session' && method === 'findUnique') sessionPointReads += 1;
                        const result: unknown = await Reflect.apply(call, model, args);
                        if (Array.isArray(result)) {
                            if (key === 'managedMachine') rows += result.length;
                            else if (key === 'machine') machineRows += result.length;
                            else candidateQueries += 1;
                        }
                        return result;
                    };
                },
            });
        },
    });
    db.$transaction = new Proxy(original, {
        apply(target, receiver, args) {
            const callback: unknown = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [(tx: Tx) => callback(observe(tx)), ...args.slice(1)]);
        },
    });
    try { return { value: await read(), rows, machineRows, candidateQueries, largestIdSet, managedQueries, sessionPointReads }; }
    finally { db.$transaction = original; }
}

describe('managed query selection on disposable PostgreSQL', () => {
    beforeAll(async () => {
        if (!/^[a-f0-9]{64}$/.test(process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID ?? '')
            || !/^\d+$/.test(process.env.VITEST_POOL_ID ?? '')
            || !process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        process.env.HAPPIER_SERVER_IDENTITY_ID = `srv_${'a'.repeat(32)}`;
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); vi.unstubAllEnvs(); });

    it('reads all controller candidates beyond the PostgreSQL bind boundary without losing creator access or list order', async () => {
        const { homeId, custodian, creator, row, create } = await createCreatorFixture();
        // Prisma 6.19.2's PostgreSQL transport has 32,766 binds; portableQueryChunks
        // owns the stricter supported-provider boundary (portableQueryChunks.ts:1).
        const ids = Array.from({ length: 32_768 }, () => randomUUID()).sort();
        for (const chunk of portableQueryChunks({ values: ids, bindingsPerValue: 3 })) {
            await db.machine.createMany({ data: chunk.map(id => ({ id, accountId: custodian.id, metadata: '{}' })) });
        }
        const first = await create();
        const last = await create();
        await db.managedMachine.update({ where: { id: first.id }, data: { controllerMachineId: ids[0], createdAt: new Date(1) } });
        await db.managedMachine.update({ where: { id: last.id }, data: { controllerMachineId: ids.at(-1)!, createdAt: new Date(2) } });
        const owned = await measureManagedRows(() => listManagedMachines({ actorAccountId: custodian.id, input: { homeId } }));
        expect(owned.value.machines.map(machine => machine.id)).toEqual([first.id, last.id, row.id]);
        expect(owned.rows).toBe(3);
        expect(owned.largestIdSet).toBeLessThanOrEqual(999);
        const created = await measureManagedRows(() => listManagedMachines({ actorAccountId: creator.id, input: { homeId } }));
        expect(created.value.machines.map(machine => machine.id)).toEqual([row.id]);
        expect(created.rows).toBe(1);
        console.info('managed-controller-bind-counts', JSON.stringify({ candidates: ids.length + 1,
            queries: owned.managedQueries, rows: owned.rows, maxIds: owned.largestIdSet,
            creatorRows: created.rows }));
    });

    it('bounds reconnect recipient and guest binds and ignores unrelated pending Sessions while retaining assigned work', async () => {
        const { homeId, custodian, controller, row, launch } = await createCreatorFixture();
        const peers = Array.from({ length: 1_000 }, () => randomUUID());
        await db.account.createMany({ data: peers.map(id => ({ id, encryptionMode: 'plain' })) });
        for (const ids of portableQueryChunks({ values: peers, bindingsPerValue: 4 })) {
            await db.machineGrant.createMany({ data: ids.map(accountId => ({ principalKind: 'account', accountId, machineId: controller.id,
                accessLevel: 'view', createdByAccountId: custodian.id })) });
        }
        const guest = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)),
            installationId: randomUUID() } });
        const resource = { contributionRef: launch.provider, schemaVersion: 1, value: {} };
        await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: guest.id,
            allocation: 'bound', resource, wakeOnAcceptedMessage: true,
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' },
            observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' } } });
        const extra = Array.from({ length: 1_000 }, () => ({ homeId, custodianAccountId: custodian.id,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId!,
            admittedActionRequestId: randomUUID(), admittedInput: {}, launch, allocation: 'bound', resource,
            enrolledMachineId: randomUUID(), retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true }));
        for (const chunk of portableQueryChunks({ values: extra, bindingsPerValue: 3 })) {
            await db.machine.createMany({ data: chunk.map(row => ({ id: row.enrolledMachineId,
                accountId: custodian.id, metadata: '{}' })) });
        }
        for (const chunk of portableQueryChunks({ values: extra, bindingsPerValue: 12 })) {
            await db.managedMachine.createMany({ data: [...chunk] });
        }
        for (const ids of portableQueryChunks({ values: [custodian.id, ...peers], bindingsPerValue: 5 })) {
            await db.session.createMany({ data: ids.map(accountId => ({ accountId, tag: randomUUID(), metadata: '{}',
                pendingActivationStatus: 'waiting', pendingActivationRequestId: randomUUID() })) });
        }
        const automation = await db.automation.create({ data: { accountId: custodian.id,
            name: 'Reconnect queued assignment', templateCiphertext: '{}' } });
        const run = await db.automationRun.create({ data: { accountId: custodian.id, state: 'queued',
            originKind: 'automation', automationId: automation.id, causeKind: 'manual', causeOccurredAt: new Date(),
            scheduledAt: new Date(), dueAt: new Date(), assignments: { create: [{ machineId: guest.id }] } } });
        const result = await measureManagedRows(() => readManagedWakeTargets({ actorAccountId: custodian.id,
            request: { homeId, controller: { machineId: controller.id, installationId: controller.installationId! } } }));
        expect(result.value.targets).toMatchObject([{ managedId: row.id,
            origin: { kind: 'workflow-assignment', runId: run.id, assignment: { machineId: guest.id } } }]);
        expect(result.value.targets).toHaveLength(1);
        // managedWake.ts: readPendingManagedWakeTargetInTx rejects missing
        // stored custody; unrelated waiting Sessions must never be fetched.
        expect(result.sessionPointReads).toBe(0);
        expect(result.largestIdSet).toBeLessThanOrEqual(999);
        console.info('managed-reconnect-counts', JSON.stringify({ recipients: peers.length + 1, guests: extra.length + 1,
            unrelatedSessions: peers.length + 1, sessionPointReads: result.sessionPointReads,
            maxIds: result.largestIdSet, targets: result.value.targets.length }));

        await db.machine.update({ where: { id: guest.id }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        const session = await db.session.create({ data: { accountId: custodian.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: custodian.id, machineId: guest.id, sessionId: session.id, data: 'fixture' } });
        const enqueue = await enqueuePendingMessageByAuthenticatedMachine({ accountId: custodian.id, sourceMachineId: controller.id,
            targetMachineId: guest.id, sessionId: session.id, localId: randomUUID(),
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Wake' } } },
            requestedAction: { v: 1, kind: 'send_now' } });
        expect(enqueue, JSON.stringify(enqueue)).toMatchObject({ status: 'accepted' });
        const retained = ManagedWakeTargetV1Schema.parse((await db.session.findUniqueOrThrow({ where: { id: session.id } })).pendingActivationManagedTarget);
        const destination = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            metadata: '{}', installationId: randomUUID() } });
        // The SQLite admission journey covers Move; this query fixture starts from its committed row.
        await db.managedMachine.update({ where: { id: row.id }, data: { controllerMachineId: destination.id,
            controllerInstallationId: destination.installationId!, intentRevision: { increment: 1 } } });
        const moved = await measureManagedRows(() => readManagedWakeTargets({ actorAccountId: custodian.id,
            request: { homeId, controller: { machineId: destination.id, installationId: destination.installationId! } } }));
        expect(moved.value.targets).toEqual(expect.arrayContaining([{ ...retained, expectedIntentRevision: 1,
            controller: { machineId: destination.id, installationId: destination.installationId! } }]));
        expect(moved.value.targets).toHaveLength(2);
        expect(moved.sessionPointReads).toBe(2);
        expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).pendingActivationManagedTarget).toEqual(retained);
    });

    it('selects only one preset history and one enrolled association while enforcing creator access', async () => {
        const { homeId, custodian, creator, stranger, controller, row, launch } = await createCreatorFixture();
        const guest = await db.machine.create({ data: { id: randomUUID(), accountId: creator.id, metadata: '{}' } });
        await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: guest.id } });
        const base = { homeId, custodianAccountId: custodian.id, controllerMachineId: controller.id,
            controllerInstallationId: controller.installationId!, admittedInput: { enrollmentAccountId: creator.id }, launch,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const archived = await db.managedMachine.create({ data: { ...base, admittedActionRequestId: randomUUID(),
            presetId: row.presetId, presetRevision: 1, archivedAt: new Date() } });
        await db.managedMachine.createMany({ data: Array.from({ length: 128 }, () => ({ ...base,
            admittedActionRequestId: randomUUID(), presetId: randomUUID(), presetRevision: 1 })) });
        const history = await measureManagedRows(async () => Promise.all([false, true].map(archived =>
            listManagedMachines({ actorAccountId: creator.id, input: { homeId, presetId: row.presetId!, archived } }))));
        expect(history.value.flatMap(result => result.machines.map(machine => machine.id))).toEqual([row.id, archived.id]);
        expect(history.rows).toBe(2);
        const association = await measureManagedRows(() => listManagedMachines({ actorAccountId: creator.id,
            input: { homeId, enrolledMachineId: guest.id } }));
        expect(association.value.machines.map(machine => machine.id)).toEqual([row.id]);
        expect(association.rows).toBe(1);
        expect((await listManagedMachines({ actorAccountId: stranger.id, input: { homeId, enrolledMachineId: guest.id } })).machines).toEqual([]);
        expect((await listManagedMachines({ actorAccountId: creator.id, input: { homeId, presetId: 'other', enrolledMachineId: guest.id } })).machines).toEqual([]);
    });

    it('excludes unrelated allocations from Account dependency reads while preserving both ownership directions and setup references', async () => {
        const { homeId, custodian, stranger, controller, launch, row } = await createCreatorFixture();
        const base = { homeId, custodianAccountId: stranger.id, controllerMachineId: randomUUID(),
            controllerInstallationId: randomUUID(), admittedInput: {}, launch, allocation: 'may-exist',
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const owned = await db.managedMachine.create({ data: { ...base, admittedActionRequestId: randomUUID(), custodianAccountId: custodian.id } });
        const controlled = await db.managedMachine.create({ data: { ...base, admittedActionRequestId: randomUUID(), controllerMachineId: controller.id } });
        const resourceId = randomUUID();
        await db.savedSecretResource.create({ data: { id: resourceId, ownerAccountId: custodian.id,
            displayName: 'Setup fixture', kind: 'token', encryptionMode: 'plain',
            storedContent: JSON.stringify({ t: 'plain', v: { v: 1, name: 'Setup fixture', kind: 'token', value: 'fixture' } }) } });
        const bootstrap = await db.managedMachine.create({ data: { ...base, admittedActionRequestId: randomUUID(),
            bootstrapCredentialRef: { kind: 'shared_resource', resourceId } } });
        const setup = await db.managedMachine.create({ data: { ...base, admittedActionRequestId: randomUUID(), archivedAt: new Date(),
            presetId: row.presetId, presetRevision: row.presetRevision,
            machineSetup: { state: 'pending', setup: { secretRefs: { v: 1,
                bindings: { SETUP: { ref: `happier:shared-secret:v1:${resourceId}`, revision: 1 } } } } } } });
        const unrelated = Array.from({ length: 128 }, () => ({ ...base, id: randomUUID(), admittedActionRequestId: randomUUID() }));
        await db.managedMachine.createMany({ data: unrelated });
        for (const ids of portableQueryChunks({ values: Array.from({ length: 1_000 }, () => randomUUID()), bindingsPerValue: 3 })) {
            await db.machine.createMany({ data: ids.map(id => ({ id, accountId: custodian.id, metadata: '{}' })) });
        }
        const read = () => inReadSnapshot(tx => readManagedResourceDependenciesInTx(tx, { kind: 'account', accountId: custodian.id }));
        const initial = await measureManagedRows(read);
        expect(initial.value.map(dependency => dependency.managedId).sort()).toEqual([owned.id, controlled.id, bootstrap.id, setup.id].sort());
        expect(initial.rows).toBe(4);
        expect(initial.largestIdSet).toBeLessThanOrEqual(999);
        const changed = unrelated[64]!;
        await db.managedMachine.update({ where: { id: changed.id }, data: { custodianAccountId: custodian.id } });
        const updated = await measureManagedRows(read);
        expect(updated.value.map(dependency => dependency.managedId).sort()).toEqual([...initial.value.map(dependency => dependency.managedId), changed.id].sort());
        expect(updated.rows).toBe(5);
        // The same immutable references protect direct resource retirement too,
        // including archived setup, but confirmed absence releases custody.
        expect((await inReadSnapshot(tx => readManagedResourceDependenciesInTx(tx, { kind: 'saved-secret', resourceId })))
            .map(dependency => dependency.managedId).sort()).toEqual([bootstrap.id, setup.id].sort());
        await db.managedMachine.updateMany({ where: { id: { in: [bootstrap.id, setup.id] } }, data: { allocation: 'confirmed-absent' } });
        expect((await read()).map(dependency => dependency.managedId).sort()).toEqual([owned.id, controlled.id, changed.id].sort());
        expect(await inReadSnapshot(tx => readManagedResourceDependenciesInTx(tx, { kind: 'saved-secret', resourceId }))).toEqual([]);
    });

    it('reads an exact enrolled association before fleet discovery and preserves fresh Team and retained creator authority', async () => {
        const { homeId, custodian, creator, stranger, controller, row } = await createCreatorFixture();
        const guest = await db.machine.create({ data: { id: randomUUID(), accountId: creator.id, metadata: '{}' } });
        await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: guest.id } });
        await db.machine.createMany({ data: Array.from({ length: 128 }, () => ({ id: randomUUID(), accountId: custodian.id, metadata: '{}' })) });
        const read = (actorAccountId: string, enrolledMachineId = guest.id, archived = false) => measureManagedRows(() =>
            listManagedMachines({ actorAccountId, input: { homeId, enrolledMachineId, archived } }));
        const own = await read(custodian.id);
        expect(own.value.machines.map(machine => machine.id)).toEqual([row.id]);
        expect(own.machineRows).toBeLessThanOrEqual(3);
        expect(own.candidateQueries).toBe(0);
        const unmanaged = await read(custodian.id, randomUUID());
        expect(unmanaged.value.machines).toEqual([]);
        expect(unmanaged.machineRows).toBe(0);
        expect(unmanaged.candidateQueries).toBe(0);
        const team = await db.team.create({ data: { name: 'Exact association authority' } });
        await db.teamMembership.createMany({ data: [{ teamId: team.id, accountId: custodian.id, role: 'admin' },
            { teamId: team.id, accountId: creator.id, role: 'admin' },
            { teamId: team.id, accountId: stranger.id, role: 'member' }] });
        // Controller Use cannot grant visibility to its native resources; the
        // enrolled guest's Team grant is the viewer's read authority.
        await db.machineGrant.create({ data: { principalKind: 'team', machineId: guest.id, teamId: team.id, accessLevel: 'view', createdByAccountId: creator.id } });
        expect((await read(stranger.id)).value.machines.map(machine => machine.id)).toEqual([row.id]);
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: stranger.id } }, data: { status: 'suspended' } });
        expect((await read(stranger.id)).value.machines).toEqual([]);
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: stranger.id } }, data: { status: 'active' } });
        expect((await read(stranger.id)).value.machines.map(machine => machine.id)).toEqual([row.id]);
        await db.machine.update({ where: { id: controller.id }, data: { revokedAt: new Date() } });
        await db.managedMachine.update({ where: { id: row.id }, data: { archivedAt: new Date() } });
        for (const actor of [custodian.id, creator.id]) {
            expect((await read(actor, guest.id, true)).value.machines.map(machine => machine.id)).toEqual([row.id]);
        }
    });
});
