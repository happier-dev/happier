import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, getDbProviderFromEnv, initDbPostgres } from '../sources/storage/db';
import { initEncrypt } from '../sources/modules/encrypt';
import {
    listQualifiedConnectedAccountsInTx,
    mutateQualifiedConnectedServiceCredential,
} from '../sources/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository';
import { createQualifiedConnectedAccountServiceDigest } from '../sources/app/api/routes/connect/qualifiedConnectedAccounts/identity';

// Research measurement in the existing disposable Postgres DB-contract harness.
// This fixture contains synthetic credentials only; output contains aggregates.
describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')(
    'qualified Connected Account list projection measurement', () => {
    let previousMasterSecret: string | undefined;
    beforeAll(async () => {
        previousMasterSecret = process.env.HANDY_MASTER_SECRET;
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable Postgres DB-contract harness');
        }
        process.env.HANDY_MASTER_SECRET ??= 'perf-c199-synthetic-fixture';
        await initEncrypt();
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => {
        try { await db.$disconnect(); }
        finally {
            if (previousMasterSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
            else process.env.HANDY_MASTER_SECRET = previousMasterSecret;
        }
    });

    it('compares full rows, required ORM columns, and SQL presence-only columns', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const service = { pluginId: 'fixture.perf-c199', localId: 'projection' };
        const digest = createQualifiedConnectedAccountServiceDigest(service);
        try {
            // 32 profiles, a 4 KiB opaque credential, and a 1 KiB configuration.
            // These are explicit workload assumptions, not measured production sizes.
            for (let index = 0; index < 32; index++) {
                const result = await mutateQualifiedConnectedServiceCredential({
                    accountId: account.id,
                    ref: { service, accountId: `profile-${index.toString().padStart(2, '0')}` },
                    authenticationModeId: 'api-key',
                    expectedCredentialRevision: null,
                    content: { t: 'plain', v: { token: randomBytes(3072).toString('base64') } },
                    metadata: { displayName: `Profile ${index}`, scopes: ['account.read'] },
                    initialConfiguration: {
                        expectedConfigurationRevision: null,
                        replacementContentEnvelope: { t: 'plain', v: { value: randomBytes(768).toString('base64') } },
                    },
                });
                expect(result.status).toBe('written');
            }
            const select = {
                id: true, servicePluginId: true, serviceLocalId: true,
                qualifiedServiceDigest: true, connectedAccountId: true,
                qualifiedIdentityDigest: true, authenticationModeId: true,
                configurationRevision: true, configurationContent: true,
                metadata: true, expiresAt: true, lastUsedAt: true,
            } as const;
            const modes = ['full', 'orm', 'presence'] as const;
            const measurements = Object.fromEntries(modes.map(mode => [mode, {
                queryMs: [] as number[], projectionCpuMicros: [] as number[], logicalBytes: 0,
            }]));
            const baseline = await listQualifiedConnectedAccountsInTx(db, { accountId: account.id, service });
            for (let round = 0; round < 22; round++) {
                // Alternate ordering; first two rounds warm all three query paths.
                for (const mode of round % 2 ? [...modes].reverse() : modes) {
                    let queryMs = 0;
                    let projectionStarted = process.cpuUsage();
                    // Instrument only the database boundary. The real canonical
                    // identity/metadata admission and profile projection run intact.
                    async function readRows(rawArgs: unknown[]) {
                        const started = performance.now();
                        // Reflect.apply is the Prisma raw-call boundary. Full and
                        // ORM comparisons use the same real database and predicates.
                        const rows: Array<Record<string, unknown>> = mode === 'presence'
                            ? await Reflect.apply(db.$queryRaw, db, rawArgs)
                            : await db.serviceAccountToken.findMany({
                                where: { accountId: account.id, qualifiedServiceDigest: digest },
                                orderBy: [{ connectedAccountId: 'asc' }, { id: 'asc' }],
                                ...(mode === 'orm' ? { select } : {}),
                            });
                        queryMs = performance.now() - started;
                        if (round === 2) {
                            measurements[mode].logicalBytes = rows.reduce((total, row) => total + Object.values(row).reduce<number>(
                                (bytes, value) => bytes + (value instanceof Uint8Array ? value.byteLength
                                    : Buffer.byteLength(JSON.stringify(value) ?? 'null')),
                                0,
                            ), 0);
                        }
                        const admittedRows = mode === 'presence' ? rows : rows.map(row => ({
                            ...row,
                            configurationContentPresent: row.configurationContent === null ? 0 : 1,
                        }));
                        projectionStarted = process.cpuUsage();
                        return admittedRows;
                    }
                    const storage = new Proxy(db, { get(target, property, receiver) {
                        if (property === '$queryRaw') return (...args: unknown[]) => readRows(args);
                        return Reflect.get(target, property, receiver);
                    } });
                    const result = await listQualifiedConnectedAccountsInTx(storage, { accountId: account.id, service });
                    const projectionCpu = process.cpuUsage(projectionStarted);
                    expect(result).toEqual(baseline);
                    if (round >= 2) {
                        measurements[mode].queryMs.push(queryMs);
                        measurements[mode].projectionCpuMicros.push(projectionCpu.user + projectionCpu.system);
                    }
                }
            }
            const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
            console.info('PERF_C199_MEASUREMENT', JSON.stringify(Object.fromEntries(modes.map(mode => [mode, {
                rows: baseline.length,
                logicalBytes: measurements[mode].logicalBytes,
                medianQueryMs: median(measurements[mode].queryMs),
                medianProjectionCpuMicros: median(measurements[mode].projectionCpuMicros),
                measuredRounds: measurements[mode].queryMs.length,
            }]))));
        } finally {
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
