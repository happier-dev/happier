import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { readManagedWakePublicationAccountIdsInTx } from './managedWake';
import { measurePostgresCreate } from './managedProjectionVolume.testkit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { readCurrentSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';
import { acquireWorkflowPublicationLocksInTx } from '@/app/workflows/acquireWorkflowPublicationLocksInTx';
import { markAccountChanged } from '@/app/changes/markAccountChanged';

beforeAll(async () => {
    if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
        || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
        throw new Error('Use only the disposable PostgreSQL DB-contract harness');
    }
    vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', `srv_${'a'.repeat(32)}`);
    initDbPostgres();
    await db.$connect();
});

it('excludes archived, stale and malformed Session placements without widening the publication audience', async () => {
    const sessions = [];
    const owners = [];
    for (let index = 0; index < 4; index++) {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        owners.push(owner);
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'wake-census-eligibility' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id,
            sessionId: session.id, data: 'opaque-fixture-key' } });
        const target = await inReadSnapshot(tx => readCurrentSessionInputMachineTargetInTx(tx, {
            accountId: owner.id, sessionId: session.id, machineId: machine.id,
        }));
        if (!target) throw new Error('Canonical fixture Machine placement was not admitted');
        await db.session.update({ where: { id: session.id }, data: {
            runtimeMachineTarget: index === 3 ? { machineId: machine.id }
                : index === 2 ? { ...target, installationId: randomUUID() } : target,
            ...(index === 1 ? { archivedAt: new Date() } : {}),
        } });
        sessions.push(session);
    }
    expect(await inReadSnapshot(tx => readManagedWakePublicationAccountIdsInTx(tx, {
        sessionIds: sessions.map(session => session.id), machineTargets: [],
    }))).toEqual([owners[0].id]);
});

it('includes a foreign guest controller custodian only for the eligible actor and current binding', async () => {
    const [custodian, requester] = await Promise.all([0, 1].map(() => db.account.create({ data: { encryptionMode: 'plain' } })));
    const machine = (accountId: string) => db.machine.create({ data: {
        id: randomUUID(), accountId, installationId: randomUUID(),
        metadata: encodePlainMachineStoredContent({ host: 'wake-census-foreign-guest' }),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
    } });
    const controller = await machine(custodian.id);
    const guest = await machine(requester.id);
    const row = await db.managedMachine.create({ data: {
        homeId: `srv_${'a'.repeat(32)}`, custodianAccountId: custodian.id,
        controllerMachineId: controller.id, controllerInstallationId: controller.installationId,
        admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
        launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Retained', choices: {} },
        resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
        enrolledMachineId: guest.id, desired: 'stop', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
        observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
    } });
    const audience = (actorAccountId: string) => inReadSnapshot(tx => readManagedWakePublicationAccountIdsInTx(tx, {
        sessionIds: [], machineTargets: [{ accountId: actorAccountId, machineId: guest.id }],
    }));
    expect(await audience(custodian.id)).toEqual([custodian.id, requester.id].sort());
    expect(await audience(requester.id)).toEqual([requester.id]);
    await db.managedMachine.update({ where: { id: row.id }, data: { desired: 'delete' } });
    expect(await audience(custodian.id)).toEqual([requester.id]);
    await db.managedMachine.update({ where: { id: row.id }, data: { desired: 'stop' } });
    await db.machine.update({ where: { id: controller.id }, data: { revokedAt: new Date() } });
    expect(await audience(custodian.id)).toEqual([requester.id]);
});
afterAll(async () => {
    await shutdownDbClient();
    vi.unstubAllEnvs();
});

it.each(['targets', 'sessions'] as const)('reads the exact wake custodian set with SQL work independent of %s count', async kind => {
    const accounts = await Promise.all([0, 1].map(() => db.account.create({ data: { encryptionMode: 'plain' } })));
    const machines = Array.from({ length: 32 }, (_, index) => ({
        id: randomUUID(), accountId: accounts[index % accounts.length].id,
        metadata: encodePlainMachineStoredContent({ host: 'wake-census-cost' }),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: randomUUID(),
    }));
    await db.machine.createMany({ data: machines });
    const sessionIds: string[] = [];
    if (kind === 'sessions') for (const machine of machines) {
        const session = await db.session.create({ data: {
            accountId: machine.accountId, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } });
        await db.accessKey.create({ data: { accountId: session.accountId, sessionId: session.id,
            machineId: machine.id, data: 'opaque-fixture-key' } });
        const target = await inReadSnapshot(tx => readCurrentSessionInputMachineTargetInTx(tx, {
            accountId: session.accountId, sessionId: session.id, machineId: machine.id,
        }));
        if (!target) throw new Error('Canonical fixture Machine placement was not admitted');
        await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: target } });
        sessionIds.push(session.id);
    }
    const scopeFor = (selected: typeof machines) => ({
            accountId: accounts[0].id,
            sessionIds: kind === 'sessions' ? sessionIds.slice(0, selected.length) : [],
            machineTargets: kind === 'targets' ? selected.map(machine => ({ accountId: machine.accountId, machineId: machine.id })) : [],
    });
    const measure = (selected: typeof machines) => measurePostgresCreate(() => inTx(async tx => {
        await acquireWorkflowPublicationLocksInTx(tx, scopeFor(selected));
        return markAccountChanged(tx, { accountId: accounts[0].id, kind: 'account', entityId: accounts[0].id });
    }));
    const one = await measure(machines.slice(0, 1));
    const many = await measure(machines);
    expect(one.value.resolveCursor()).toBeGreaterThan(0);
    expect(many.value.resolveCursor()).toBeGreaterThan(one.value.resolveCursor());
    expect(await inReadSnapshot(tx => readManagedWakePublicationAccountIdsInTx(tx, scopeFor(machines.slice(0, 1)))))
        .toEqual([accounts[0].id]);
    expect(await inReadSnapshot(tx => readManagedWakePublicationAccountIdsInTx(tx, scopeFor(machines))))
        .toEqual(accounts.map(account => account.id).sort());
    const reads = (statements: string[]) => statements.filter(sql => /^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/u.test(sql));
    console.info('MANAGED_WAKE_CENSUS_SQL', JSON.stringify({ kind, size: [1, machines.length], reads: [reads(one.statements).length, reads(many.statements).length] }));
    expect(reads(many.statements)).toHaveLength(reads(one.statements).length);
});
