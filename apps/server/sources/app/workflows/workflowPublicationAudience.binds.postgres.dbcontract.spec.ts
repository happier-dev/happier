import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { AutomationTriggerIdSchema, deriveAutomationOccurrenceKeyV1, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inReadSnapshot } from '@/storage/inTx';
import { encodeAutomationRunCause } from '@/app/automations/automationRunCauseCodec';
import { encodeAutomationSessionLifecycleConfiguration } from '@/app/automations/automationSessionLifecycleConfigurationCodec';
import { readManagedWakePublicationAccountIdsInTx } from '@/app/machines/managed/managedWake';
import { readCurrentSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';
import { getSessionLifecycleAutomationPublicationAudienceInTx, getWorkflowPublicationAudienceInTx } from './workflowPublicationAudience';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Lifecycle publication inventory bind bounds (PostgreSQL)', () => {
    const queries: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'> | undefined;
    let originalTransaction: typeof db.$transaction;
    let fixture: Awaited<ReturnType<typeof createFixture>>;

    async function createFixture() {
        const owners = await Promise.all([0, 1].map(() => db.account.create({ data: { encryptionMode: 'plain' } })));
        const sessions = await Promise.all([0, 0, 1, 1].map(ownerIndex => db.session.create({ data: {
            accountId: owners[ownerIndex].id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } })));
        const machines = await Promise.all(owners.map(owner => db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'lifecycle-bind-fixture' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } })));
        for (const [ownerIndex, sessionIndex] of [[0, 0], [1, 3]]) {
            const session = sessions[sessionIndex];
            const machine = machines[ownerIndex];
            await db.accessKey.create({ data: { accountId: session.accountId, sessionId: session.id,
                machineId: machine.id, data: 'opaque-fixture-key' } });
            const target = await inReadSnapshot(tx => readCurrentSessionInputMachineTargetInTx(tx, {
                accountId: session.accountId, sessionId: session.id, machineId: machine.id,
            }));
            if (!target) throw new Error('Canonical fixture Machine placement was not admitted');
            await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: target } });
        }
        const automationIds = Array.from({ length: 1001 }, () => randomUUID());
        const ownerFor = (index: number) => owners[index === 1000 ? 1 : 0];
        const projectionFor = (index: number) => sessions[index === 0 ? 0 : index === 1000 ? 3 : 1];
        await db.automation.createMany({ data: automationIds.map((id, index) => ({
            id, accountId: ownerFor(index).id, name: id, enabled: true, templateCiphertext: '{}', templateVersion: 1,
            scopeSessionId: projectionFor(index).id,
        })) });
        await db.automationTrigger.createMany({ data: automationIds.map((automationId, index) => ({
            id: randomUUID(), automationId, kind: 'sessionLifecycle', enabled: true,
            ...encodeAutomationSessionLifecycleConfiguration({ kind: 'sessionLifecycle',
                sourceSessionId: sessions[index === 0 ? 0 : index === 1000 ? 2 : 1].id,
                events: ['parentTurnCompleted'], policy: { kind: 'everyMatch' } }),
        })) });
        await db.automationAssignment.createMany({ data: automationIds.map((automationId, index) => ({
            automationId, machineId: machines[index === 1000 ? 1 : 0].id, enabled: true,
        })) });
        await db.automationRun.createMany({ data: automationIds.map((automationId, index) => {
            const triggerId = AutomationTriggerIdSchema.parse(randomUUID());
            const evidence = { v: 1 as const, kind: 'sessionLifecycle' as const, event: 'parentTurnCompleted' as const,
                sourceSessionId: projectionFor(index).id, sourceTurnId: randomUUID(), occurredAt: Date.now() };
            return {
                id: randomUUID(), accountId: ownerFor(index).id, automationId, originKind: 'automation',
                state: 'succeeded', scheduledAt: new Date(), dueAt: new Date(),
                ...encodeAutomationRunCause({ kind: 'trigger', triggerKind: 'sessionLifecycle',
                    triggerId, triggerRevision: 0, occurredAt: evidence.occurredAt,
                    occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence }),
                    evidence: { event: evidence.event, sourceSessionId: evidence.sourceSessionId,
                        sourceTurnId: evidence.sourceTurnId, policy: { kind: 'everyMatch' } } }),
            };
        }) });
        return { owners, sessions, machines, automationIds };
    }

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', `srv_${'a'.repeat(32)}`);
        initDbPostgres();
        await db.$connect();
        fixture = await createFixture();
        originalTransaction = db.$transaction;
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => queries.push(event));
        await client.$connect();
        const traced = client;
        // Observe the actual persistent boundary; every domain reader and SQL result stays real.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
    });

    afterAll(async () => {
        if (originalTransaction) db.$transaction = originalTransaction;
        await client?.$disconnect();
        await shutdownDbClient();
        vi.unstubAllEnvs();
    });

    function assertBindBudget(name: string) {
        const binds = queries.map(query => (JSON.parse(query.params) as unknown[]).length);
        expect(binds.length).toBeGreaterThan(0);
        console.info('LIFECYCLE_AUDIENCE_SQL_BINDS', JSON.stringify({ name, statements: queries.length, maxBinds: Math.max(...binds) }));
        expect(Math.max(...binds)).toBeLessThanOrEqual(999);
    }

    it('keeps the complete lifecycle audience across source and Automation fanout chunks', async () => {
        const sourceIds = Array.from({ length: 35001 }, (_, index) => index === 0 ? fixture.sessions[0].id
            : index === 1000 ? fixture.sessions[1].id : index === 35000 ? fixture.sessions[2].id : `missing-${index}`);
        queries.length = 0;
        expect(await inReadSnapshot(tx => getSessionLifecycleAutomationPublicationAudienceInTx(tx, [fixture.sessions[0].id])))
            .toEqual({ accountIds: [fixture.owners[0].id], sessionIds: [fixture.sessions[0].id] });
        const inventoryIds = new Set([...fixture.automationIds, ...fixture.sessions.map(session => session.id), ...fixture.machines.map(machine => machine.id)]);
        console.info('LIFECYCLE_AUDIENCE_NATIVE_QUERY_SHAPES', JSON.stringify(queries.map(query => {
            const parameters = JSON.parse(query.params) as unknown[];
            return { table: /FROM\s+"public"\."([^"]+)"/.exec(query.query)?.[1] ?? query.query,
                binds: parameters.length, fixedBindings: parameters.filter(value => typeof value !== 'string' || !inventoryIds.has(value)).length };
        })));
        queries.length = 0;
        const audience = await inReadSnapshot(tx => getSessionLifecycleAutomationPublicationAudienceInTx(tx, sourceIds));
        expect(audience).toEqual({ accountIds: fixture.owners.map(owner => owner.id).sort(),
            sessionIds: fixture.sessions.map(session => session.id).sort() });
        assertBindBudget('lifecycle-source-and-automation-fanout');
    });

    it('does not read retained Run review origins for an Automation definition audience', async () => {
        const automationIds = [...fixture.automationIds.slice(0, -1),
            ...Array.from({ length: 34000 }, (_, index) => `missing-automation-${index}`), fixture.automationIds[1000]];
        queries.length = 0;
        const audience = await inReadSnapshot(tx => getWorkflowPublicationAudienceInTx(tx, {
            accountId: fixture.owners[0].id, automationIds,
        }));
        expect(audience.sessionIds).toEqual([fixture.sessions[0].id, fixture.sessions[1].id, fixture.sessions[3].id].sort());
        expect(queries.some(query => /FROM\s+"public"\."AutomationRun"/.test(query.query))).toBe(false);
        assertBindBudget('definition-without-retained-review');
    });

    it('unions portable Run selector batches without losing or duplicating actual review sources', async () => {
        const selected = await db.automationRun.findFirstOrThrow({ where: { automationId: fixture.automationIds[0] }, select: { id: true } });
        const other = await db.automationRun.findFirstOrThrow({ where: { automationId: fixture.automationIds[1] }, select: { id: true } });
        queries.length = 0;
        const audience = await inReadSnapshot(tx => getWorkflowPublicationAudienceInTx(tx, {
            accountId: fixture.owners[0].id,
            runIds: [selected.id, ...Array.from({ length: 35_000 }, (_, index) => `missing-run-${index}`)],
            runWhere: [{ id: selected.id }, { id: other.id }],
        }));
        expect(audience.runIds).toEqual([selected.id, other.id].sort());
        expect(audience.sessionIds).toEqual([fixture.sessions[0].id, fixture.sessions[1].id].sort());
        assertBindBudget('run-selector-union');
    });

    it('retains wake custodians across Session and Machine inventory chunks', async () => {
        const sessionIds = Array.from({ length: 35001 }, (_, index) => index === 0 ? fixture.sessions[0].id
            : index === 35000 ? fixture.sessions[3].id : `missing-session-${index}`);
        queries.length = 0;
        const sessionCustodians = await inReadSnapshot(tx => readManagedWakePublicationAccountIdsInTx(tx, {
            sessionIds, machineTargets: [],
        }));
        expect(sessionCustodians).toEqual(fixture.owners.map(owner => owner.id).sort());
        assertBindBudget('wake-session-placements');
        const machineTargets = Array.from({ length: 1001 }, (_, index) => ({
            accountId: fixture.owners[index === 1000 ? 1 : 0].id,
            machineId: index === 0 ? fixture.machines[0].id : index === 1000 ? fixture.machines[1].id : `missing-machine-${index}`,
        }));
        queries.length = 0;
        const accountIds = await inReadSnapshot(tx => readManagedWakePublicationAccountIdsInTx(tx, { sessionIds: [], machineTargets }));
        expect(accountIds).toEqual(fixture.owners.map(owner => owner.id).sort());
        assertBindBudget('wake-machine-custodians');
    });
});
