import type { DaemonDatabase, DaemonDatabaseMigration, DaemonDatabaseRow, DaemonDatabaseValue } from '@happier-dev/plugin-sdk/storage';
import type { DatabaseCaptureQueryGetResultV1 } from '@happier-dev/database-protocol';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 as limits } from '@happier-dev/plugin-sdk/storage';
import { REQUEST_DATABASE_TIME_SQL_CTES } from '../analysis/requests.js';

export const captureMigrations: readonly DaemonDatabaseMigration[] = [{ version: 1, id: 'capture', async up(tx) {
 await tx.execute('CREATE TABLE captureSummaries (id TEXT NOT NULL, worktree TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL, shape TEXT, traceId TEXT, spanId TEXT, durationMs REAL, outcome TEXT, parentSpanId TEXT, spanKind INTEGER, serviceName TEXT, endpointMethod TEXT, endpointRoute TEXT, httpStatusCode INTEGER, statementKind TEXT, parameterIdentity TEXT, executionIdentity TEXT, callsite TEXT, transactionId TEXT, retryOf TEXT, connectionId TEXT, PRIMARY KEY(worktree,id))');
 await tx.execute('CREATE INDEX captureTime ON captureSummaries(worktree,at,id)');
 await tx.execute('CREATE INDEX captureTrace ON captureSummaries(worktree,traceId)');
 await tx.execute('CREATE INDEX captureShape ON captureSummaries(worktree,shape)');
 await tx.execute('CREATE TABLE captureDetails (id TEXT NOT NULL, worktree TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(worktree,id))');
} }, { version: 2, id: 'log-severity', async up(tx) {
 await tx.execute('ALTER TABLE captureSummaries ADD COLUMN severityNumber INTEGER');
} }];
const summaryFields = ['id','worktree','kind','source','at','shape','traceId','spanId','durationMs','outcome','parentSpanId','spanKind','serviceName','endpointMethod','endpointRoute','httpStatusCode','statementKind','parameterIdentity','executionIdentity','callsite','transactionId','retryOf','connectionId','severityNumber'] as const;
const changingFields = summaryFields.filter(field => field !== 'id' && field !== 'worktree');
const summarySql = `INSERT INTO captureSummaries(${summaryFields.join(',')}) VALUES(${summaryFields.map(() => '?').join(',')}) ON CONFLICT(worktree,id) DO UPDATE SET ${changingFields.map(field => `${field}=excluded.${field}`).join(',')} WHERE ${changingFields.map(field => `${field} IS NOT excluded.${field}`).join(' OR ')}`;
const detailSql = 'INSERT INTO captureDetails(id,worktree,at,body) VALUES(?,?,?,?) ON CONFLICT(worktree,id) DO UPDATE SET at=excluded.at,body=excluded.body WHERE body IS NOT excluded.body';
/** A detail is truncated visibly against the host's statement-input bound, never an invented telemetry cap. */
function detailBody(event: CaptureEvent): string {
 const budget = limits.maximumInputBytes - Buffer.byteLength(detailSql) - Buffer.byteLength(event.id) - Buffer.byteLength(event.worktree) - 8;
 const original = JSON.stringify(event.detail);
 const fits = (body: string) => Buffer.byteLength(body) <= budget
  && Buffer.byteLength(JSON.stringify([{ body }])) <= limits.maximumResultBytes;
 if (fits(original)) return original;
 const points = Array.from(original);
 let low = 0, high = points.length;
 while (low < high) {
  const middle = Math.ceil((low + high) / 2);
  if (fits(JSON.stringify({ truncated: true, preview: points.slice(0, middle).join('') }))) low = middle;
  else high = middle - 1;
 }
 const result = JSON.stringify({ truncated: true, preview: points.slice(0, low).join('') });
 return result;
}
export function createCaptureStore(db: DaemonDatabase, publish: (keys: readonly string[]) => void) {
 async function queryPage<T extends DaemonDatabaseRow>(statement: string, params: readonly DaemonDatabaseValue[], requested: number) {
  let pageSize = requested;
  while (true) {
   try { return { rows: await db.query<T>(statement, [...params, pageSize]), pageSize }; }
   catch (error) {
    if (pageSize <= 1 || error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'daemon_database_result_too_large') throw error;
    // The host owns the byte ceiling: shrink only after that actual boundary refuses a page.
    pageSize = Math.ceil(pageSize / 2);
   }
  }
 }
 return {
  async listPartitions(): Promise<readonly string[]> {
   const partitions: string[] = [];
   let after = '';
   while (true) {
    // Retention can remove summaries before the matching detail chunk. Include
    // both owned tables so an offline assignment withdrawal clears all history.
    const page = await db.query('SELECT worktree FROM (SELECT worktree FROM captureSummaries UNION SELECT worktree FROM captureDetails) WHERE worktree > ? ORDER BY worktree LIMIT ?', [after, limits.maximumResultRows]);
    for (const row of page) partitions.push(String(row.worktree));
    if (page.length < limits.maximumResultRows) return partitions;
    after = partitions[partitions.length - 1]!;
   }
  },
  async write(events: readonly CaptureEvent[]) {
   if (!events.length) return;
   const changed = new Set<string>();
   await db.transaction(async tx => {
    for (const event of events) {
     const result = await tx.execute(summarySql, summaryFields.map(field => event[field] ?? null));
     let detailsChanged = false;
     if (event.detail) {
      const detail = await tx.execute(detailSql, [event.id, event.worktree, event.at, detailBody(event)]);
      detailsChanged = detail.changes > 0;
     }
     if (result.changes || detailsChanged) changed.add(event.worktree);
    }
   });
   if (changed.size) publish([...changed]);
  },
  async list(input: CaptureListInput): Promise<readonly CaptureSummary[]> {
   const rows: CaptureSummary[] = [];
   let cursor = input.before;
   while (rows.length < input.limit) {
    const predicates = ['worktree = ?'];
    const params: (string | number)[] = [input.worktree];
    if (input.kind) { predicates.push('kind = ?'); params.push(input.kind); }
    if (input.traceId) { predicates.push('traceId = ?'); params.push(input.traceId); }
    if (input.spanKind !== undefined) { predicates.push('spanKind = ?'); params.push(input.spanKind); }
    if (input.serviceName !== undefined) { predicates.push('serviceName = ?'); params.push(input.serviceName); }
    if (input.severityNumber !== undefined) { predicates.push('severityNumber = ?'); params.push(input.severityNumber); }
    if (input.since !== undefined) { predicates.push('at >= ?'); params.push(input.since); }
    if (input.until !== undefined) { predicates.push('at < ?'); params.push(input.until); }
    if (cursor) { predicates.push('(at < ? OR (at = ? AND id < ?))'); params.push(cursor.at, cursor.at, cursor.id); }
    const { rows: page, pageSize } = await queryPage(`SELECT ${summaryFields.join(',')} FROM captureSummaries WHERE ${predicates.join(' AND ')} ORDER BY at DESC,id DESC LIMIT ?`, params, Math.min(input.limit - rows.length, limits.maximumResultRows));
    // The table is produced only by this store; SQLite scalar decoding is the genuine boundary.
    const summaries = page as unknown as readonly CaptureSummary[];
    rows.push(...summaries);
    if (page.length < pageSize) break;
    const last = summaries.at(-1);
    if (!last) break;
    cursor = { at: last.at, id: last.id };
   }
   return rows;
  },
  async endpoints(input: CaptureEndpointListInput): Promise<readonly CaptureEndpointSummary[]> {
   const result: CaptureEndpointSummary[] = [];
   let cursor = input.before;
   while (result.length < input.limit) {
    const predicates = ['worktree = (SELECT worktree FROM capturePartition)', "kind = 'span'", 'spanKind = 2', "endpointMethod IS NOT NULL AND endpointMethod <> ''", "endpointRoute IS NOT NULL AND endpointRoute <> ''"];
    const params: DaemonDatabaseValue[] = [input.worktree];
    if (input.since !== undefined) { predicates.push('at >= ?'); params.push(input.since); }
    if (input.until !== undefined) { predicates.push('at < ?'); params.push(input.until); }
    const after = cursor ? 'WHERE (serviceName,method,route) > (?,?,?)' : '';
    if (cursor) params.push(cursor.serviceName, cursor.method, cursor.route);
    // Select endpoint keys before attribution. Only traces belonging to this
    // page enter the analysis projection; all history stays at the SQL owner.
    const statement = `WITH RECURSIVE
capturePartition AS (SELECT ? AS worktree),
endpointCandidates AS (SELECT id,at,traceId,spanId,COALESCE(serviceName,'') AS serviceName,endpointMethod AS method,endpointRoute AS route,outcome,httpStatusCode,durationMs FROM captureSummaries WHERE ${predicates.join(' AND ')}),
endpointGroups AS (
 SELECT serviceName,method,route,COUNT(*) AS requestCount,
 SUM(CASE WHEN outcome = 'error' OR httpStatusCode >= 500 THEN 1 ELSE 0 END) AS errorCount,
 SUM(COALESCE(durationMs,0)) AS totalDurationMs FROM endpointCandidates GROUP BY serviceName,method,route
),
selectedEndpoints AS (SELECT * FROM endpointGroups ${after} ORDER BY serviceName,method,route LIMIT ?),
endpointRequestVersions AS (
 SELECT request.*,ROW_NUMBER() OVER (PARTITION BY traceId,spanId ORDER BY at,id) AS version
 FROM endpointCandidates request
 WHERE traceId IS NOT NULL AND traceId <> '' AND spanId IS NOT NULL AND spanId <> ''
),
endpointRequests AS (SELECT request.* FROM endpointRequestVersions request JOIN selectedEndpoints selected USING(serviceName,method,route) WHERE version = 1),
captureEvidence AS (
 SELECT id,kind,source,at,traceId,spanId,parentSpanId,spanKind,executionIdentity,durationMs FROM captureSummaries
 WHERE worktree = (SELECT worktree FROM capturePartition) AND traceId IN (SELECT traceId FROM endpointRequests)
),
${REQUEST_DATABASE_TIME_SQL_CTES},
endpointDatabaseTimes AS (
 SELECT request.serviceName,request.method,request.route,SUM(timing.databaseTimeMs) AS databaseTimeMs
 FROM endpointRequests request JOIN requestDatabaseTimes timing USING(traceId,spanId) GROUP BY request.serviceName,request.method,request.route
)
SELECT selected.*,COALESCE(timing.databaseTimeMs,0) AS databaseTimeMs FROM selectedEndpoints selected
LEFT JOIN endpointDatabaseTimes timing USING(serviceName,method,route) ORDER BY serviceName,method,route`;
    const requested = Math.min(input.limit - result.length, limits.maximumResultRows);
    const { rows, pageSize } = await queryPage<CaptureEndpointSummary>(statement, params, requested);
    result.push(...rows);
    if (rows.length < pageSize) break;
    cursor = rows.at(-1);
   }
   return result;
  },
  async detail(worktree: string, id: string): Promise<Extract<DatabaseCaptureQueryGetResultV1, { ok: true }>['detail']> {
   const rows = await db.query('SELECT body FROM captureDetails WHERE worktree = ? AND id = ?', [worktree, id]);
   return typeof rows[0]?.body === 'string' ? JSON.parse(rows[0].body) : null;
  },
  async clear(worktree: string) {
   let changed = 0;
   await db.transaction(async tx => {
    for (const table of ['captureDetails', 'captureSummaries']) {
     let count: number;
     do { const result = await tx.execute(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE worktree = ? LIMIT ?)`, [worktree, limits.maximumAffectedRows]); count = result.changes; changed += count; } while (count === limits.maximumAffectedRows);
    }
   });
   if (changed) publish([worktree]);
  },
 };
}
export type CaptureSummary = Readonly<{
 id: string; worktree: string; kind: 'query' | 'transaction' | 'span' | 'log' | 'coverage'; source: 'wire' | 'otlp' | 'capture'; at: number;
 shape?: string | null; traceId?: string | null; spanId?: string | null; durationMs?: number | null; outcome?: string | null;
 parentSpanId?: string | null; spanKind?: number | null; serviceName?: string | null; severityNumber?: number | null; endpointMethod?: string | null; endpointRoute?: string | null; httpStatusCode?: number | null;
 statementKind?: 'select' | 'control' | 'other' | 'unknown' | null; parameterIdentity?: string | null; executionIdentity?: string | null; callsite?: string | null; transactionId?: string | null; retryOf?: string | null; connectionId?: string | null;
}>;
/** Values here have already passed the canonical dialect's masking boundary. */
export type CaptureEvent = CaptureSummary & Readonly<{ detail?: Readonly<Record<string, unknown>> }>;
export type CaptureListInput = Readonly<{worktree: string; kind?: CaptureSummary['kind']; traceId?: string; spanKind?: number; serviceName?: string; severityNumber?: number; since?: number; until?: number; limit: number; before?: Readonly<{at:number; id:string}>}>;
export type CaptureEndpointCursor = Readonly<{ serviceName: string; method: string; route: string }>;
export type CaptureEndpointSummary = CaptureEndpointCursor & Readonly<{ requestCount: number; errorCount: number; totalDurationMs: number; databaseTimeMs: number }>;
export type CaptureEndpointListInput = Readonly<{ worktree: string; limit: number; before?: CaptureEndpointCursor; since?: number; until?: number }>;

export const captureDatabaseDefinition = {
 migrations: captureMigrations,
 incumbentQueryFixture: { id: 'capture-readable', async run(tx: import('@happier-dev/plugin-sdk/storage').DaemonDatabaseMigrationReadTransaction) {
  await tx.query('SELECT id,worktree,at FROM captureSummaries LIMIT 1');
  await tx.query('SELECT id,worktree,at FROM captureDetails LIMIT 1');
 } },
 retention: [{ table: 'captureSummaries', timeColumn: 'at', changeKeyColumn: 'worktree' }, { table: 'captureDetails', timeColumn: 'at', changeKeyColumn: 'worktree' }],
} as const;
