import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { ManagedControllerReportV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { db, initDbPostgres } from '@/storage/db';
import { admitManagedAcquire } from './managedAcquire';
import { reportManagedAcquire, submitManagedAcquire } from './managedMutations';
import { measurePostgresCreate, seedBundledManagedAvailability } from './managedProjectionVolume.testkit';

beforeAll(async () => {
    if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
        || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
        throw new Error('Use only the disposable PostgreSQL DB-contract harness');
    }
    process.env.HAPPIER_SERVER_IDENTITY_ID = `srv_${'a'.repeat(32)}`;
    initDbPostgres();
    await db.$connect();
});
afterAll(async () => { await db.$disconnect(); });

it('retains a repeated bound status report with stable SQL work on PostgreSQL', async () => {
    const homeId = process.env.HAPPIER_SERVER_IDENTITY_ID!;
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const controller = { machineId: randomUUID(), installationId: randomUUID() };
    await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: '{}',
        installationId: controller.installationId, pluginMaterializationRevision: 1n } });
    const manifest = await seedBundledManagedAvailability(account.id, homeId, controller, ['machine-lima.json']);
    const descriptor = manifest.contributes?.machineProvisioners?.find(entry => entry.id === 'lima');
    if (!descriptor) throw new Error('Lima declaration missing');
    const launch = { provider: { pluginId: manifest.id, localId: descriptor.id }, schemaVersion: descriptor.schemaVersion,
        name: 'Report cost guest', choices: { store: '/tmp/report-guests', image: 'fixture:image', arch: 'x86_64',
            vmType: 'qemu', cpus: 1, memoryGiB: 4, diskGiB: 15, mounts: [] } };
    const requestId = randomUUID();
    const admitted = await admitManagedAcquire({ custodianAccountId: account.id, requesterAccountId: account.id,
        requestEnvelopeDigest: 'report-cost-envelope', input: { requestId, continuationPresent: false,
            input: { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, selection: {
                kind: 'one-off', homeId, controller, launch, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } } });
    const correlation = { homeId, managedId: admitted.machine.id, controller, requestId, expectedIntentRevision: 0 };
    await submitManagedAcquire(correlation);
    const resource = { contributionRef: launch.provider, schemaVersion: launch.schemaVersion,
        value: createPluginJsonSchemaZodValueAdapter(descriptor.resourceSchema).parse({ instance: 'happier-report-cost',
            store: '/tmp/report-guests', image: 'fixture:image', arch: 'x86_64', vmType: 'qemu', cpus: 1,
            memoryBytes: 4294967296, diskBytes: 16106127360, mounts: [] }) };
    await reportManagedAcquire(ManagedControllerReportV1Schema.parse({ ...correlation, result: { kind: 'bound', resource } }));
    const report = ManagedControllerReportV1Schema.parse({ ...correlation, result: { kind: 'bound', resource },
        bootstrapInstalled: true, observation: { observedAt: Date.now(), availability: 'present', power: 'running' } });
    const first = await measurePostgresCreate(() => reportManagedAcquire(report));
    const repeated = await measurePostgresCreate(() => reportManagedAcquire(report));
    expect(first.value.machine).toMatchObject({ resource, bootstrapInstalled: true, observation: report.observation });
    expect(repeated.value.machine).toEqual(first.value.machine);
    const dataStatements = (statements: string[]) => statements.filter(sql => /^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/u.test(sql));
    expect(dataStatements(repeated.statements)).toHaveLength(dataStatements(first.statements).length);
});
