import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { renderPrismaCompatibleSqliteDatabaseUrl } from '@happier-dev/cli-common/firstPartyRuntime/server';
import { createUsageSnapshot } from '@/app/api/routes/connect/providerAccountUsageTestkit';
import { createLightSqliteHarness } from './lightSqliteHarness';
import { seedSqliteUsageHistory, type SqliteUsageHistoryRow } from './seedSqliteUsageHistory';

const require = createRequire(import.meta.url);
// Generated SQLite is the real database boundary and shares the schema/client contract.
const { PrismaClient } = require('../../generated/sqlite-client/index.js') as typeof import('@prisma/client');

describe('SQLite retained usage fixtures', () => {
    it('batches at the SQLite bind boundary and preserves every retained fact', async () => {
        const harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-fixture-batches-' });
        const client = new PrismaClient({
            errorFormat: 'minimal',
            datasources: { db: { url: renderPrismaCompatibleSqliteDatabaseUrl({ dbPath: harness.dbPath, platform: process.platform }) } },
            log: [{ emit: 'event', level: 'query' }],
        });
        try {
            const options = await client.$queryRaw<Array<{ compile_options: string }>>`PRAGMA compile_options`;
            const limit = Number(options.find(row => row.compile_options.startsWith('MAX_VARIABLE_NUMBER='))?.compile_options.split('=')[1]);
            expect(limit).toBeGreaterThan(0);
            const rowsPerStatement = Math.floor(limit / 5);
            const account = await client.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
            const snapshot = createUsageSnapshot();
            await client.providerAccountUsageRecord.create({ data: {
                accountId: account.id, recordId: snapshot.recordId, providerId: snapshot.providerId,
                accountSubjectId: snapshot.recordKey.accountSubjectId, subjectKind: snapshot.recordKey.subjectKind,
                quotaScope: snapshot.recordKey.quotaScope, quotaScopeIdKey: '', recordKeyJson: snapshot.recordKey,
                payloadMode: 'plain_json_v1', status: 'ok',
            } });
            let inserts = 0;
            let bindings = 0;
            client.$on('query', event => {
                const query = event.query.trimStart();
                if (!query.startsWith('INSERT') || !query.includes('ProviderAccountUsageHistory')) return;
                inserts++;
                bindings = Math.max(bindings, (query.match(/\?/g) ?? []).length);
            });
            let total = 0;
            for (const count of [1_000, rowsPerStatement + 1]) {
                const rows: SqliteUsageHistoryRow[] = Array.from({ length: count }, (_, index) => ({
                    ...(index === 0 ? { id: `retained-${count}` } : {}),
                    accountId: account.id, recordId: snapshot.recordId,
                    observedAt: new Date(snapshot.fetchedAtMs - (total + index) * 12_000),
                    payload: { snapshot, index, note: 'quotes " and \\; null stays null', absent: null },
                }));
                inserts = 0;
                bindings = 0;
                expect(await seedSqliteUsageHistory(client, rows)).toBe(count);
                expect(inserts, `${count} retained rows must use SQLite-sized INSERT batches`).toBe(Math.ceil(count / rowsPerStatement));
                expect(bindings).toBeLessThanOrEqual(limit);
                total += count;
                expect(await client.providerAccountUsageHistory.count()).toBe(total);
                for (const index of [0, count - 1]) {
                    const row = rows[index]!;
                    const stored = await client.providerAccountUsageHistory.findFirstOrThrow({
                        where: { accountId: row.accountId, recordId: row.recordId, observedAt: row.observedAt },
                    });
                    expect(stored).toMatchObject({ accountId: row.accountId, recordId: row.recordId,
                        observedAt: row.observedAt, payload: row.payload, ...(row.id ? { id: row.id } : {}) });
                }
            }
            inserts = 0;
            expect(await seedSqliteUsageHistory(client, [])).toBe(0);
            expect(inserts).toBe(0);
        } finally {
            await client.$disconnect();
            await harness.close();
        }
    });
});
