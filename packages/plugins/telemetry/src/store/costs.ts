import type { DaemonDatabaseMigration, DaemonDatabaseRow, DaemonDatabaseValue } from '@happier-dev/plugin-sdk/storage';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 as limits } from '@happier-dev/plugin-sdk/storage';
import { DATABASE_CAPTURE_COST_TOKEN_FIELDS_V1, type DatabaseCaptureCostOperandV1,
    type DatabaseCaptureCostsReadInputV1 } from '@happier-dev/database-protocol';

/** Numeric GenAI operands share span identity, partition and retention; no cost ledger or price snapshot. */
export const costMigration: DaemonDatabaseMigration = { version: 5, id: 'gen-ai-operands', async up(tx) {
    await tx.execute('ALTER TABLE captureSummaries ADD COLUMN serviceVersion TEXT');
    await tx.execute('ALTER TABLE captureSummaries ADD COLUMN genAi TEXT');
} };
export type CostOperandsInput = Omit<DatabaseCaptureCostsReadInputV1, 'source'> & Readonly<{ worktree: string }>;

export function createCostStore(queryPage: <T extends DaemonDatabaseRow>(statement: string, params: readonly DaemonDatabaseValue[], requested: number)
    => Promise<{ rows: readonly T[]; pageSize: number }>) {
    return {
        async costOperands(input: CostOperandsInput): Promise<DatabaseCaptureCostOperandV1[]> {
            const filters = ['worktree=?', 'at>=?', 'at<?', 'genAi IS NOT NULL'];
            const params: DaemonDatabaseValue[] = [input.worktree, input.since, input.until];
            for (const [field, value] of [['serviceName', input.serviceName], ['serviceVersion', input.serviceVersion]] as const) {
                if (value !== undefined) { filters.push(`${field}=?`); params.push(value); }
            }
            const bucketMs = input.granularity === 'hour' ? 3_600_000 : input.granularity === 'day' ? 86_400_000 : null;
            const bucket = bucketMs === null ? String(input.since) : `CAST(at/${bucketMs} AS INTEGER)*${bucketMs}`;
            const metadata = ['provider', 'modelId', 'requestedModel', 'operation'] as const;
            const field = (path: string) => `json_extract(genAi,'$.${path}')`;
            const categoriesKnown = "json_type(genAi,'$.tokenCategories')='object'";
            const group = `json_array(bucketStartMs,${metadata.map(key => field(key)).join(',')},${field('reportedCost.currency')},${categoriesKnown},${DATABASE_CAPTURE_COST_TOKEN_FIELDS_V1.map(key => `json_type(genAi,'$.tokens.${key}')`).join(',')})`;
            const summedTokens = (path: string) => `json_object(${DATABASE_CAPTURE_COST_TOKEN_FIELDS_V1.map(key => `'${key}',SUM(${field(`${path}.${key}`)})`).join(',')})`;
            const projection = `json_object('bucketStartMs',bucketStartMs,${metadata.map(key => `'${key}',${field(key)}`).join(',')},
                'callCount',COUNT(*),'tokens',${summedTokens('tokens')},
                'tokenCategories',CASE WHEN ${categoriesKnown} THEN ${summedTokens('tokenCategories')} ELSE NULL END,
                'reportedCost',CASE WHEN ${field('reportedCost.currency')} IS NULL THEN NULL ELSE json_object('currency',${field('reportedCost.currency')},'amount',SUM(${field('reportedCost.amount')})) END,
                'firstSeenMs',MIN(at),'lastSeenMs',MAX(at))`;
            const items: DatabaseCaptureCostOperandV1[] = [];
            let after = '';
            while (true) {
                const { rows, pageSize } = await queryPage(`WITH selected AS (SELECT at,genAi,${bucket} AS bucketStartMs FROM captureSummaries WHERE ${filters.join(' AND ')}),
                    operands AS (SELECT ${group} AS groupKey,${projection} AS body FROM selected GROUP BY groupKey)
                    SELECT groupKey,body FROM operands WHERE groupKey>? ORDER BY groupKey LIMIT ?`, [...params, after], limits.maximumResultRows);
                for (const row of rows) items.push(JSON.parse(String(row.body)) as DatabaseCaptureCostOperandV1);
                if (rows.length < pageSize) return items;
                after = String(rows.at(-1)!.groupKey);
            }
        },
    };
}
