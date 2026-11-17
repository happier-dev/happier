import type { DaemonDatabase, DaemonDatabaseMigration, DaemonDatabaseRow, DaemonDatabaseValue } from '@happier-dev/plugin-sdk/storage';
import type { DatabaseCaptureQueryGetResultV1 } from '@happier-dev/database-protocol';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 as limits } from '@happier-dev/plugin-sdk/storage';
import { createMetricStore, metricMigration, metricRetention, writeMetricPoint } from './metrics.js';
import { costMigration, createCostStore } from './costs.js';
import { worktreeMigration, createCaptureWorktrees } from './worktrees.js';
import type { DatabaseCaptureCostMetadataV1 } from '@happier-dev/database-protocol';
import type { NormalizedMetricPoint } from '../otlp/types.js';
import { REQUEST_DATABASE_TIME_SQL_CTES } from '../analysis/requests.js';

export const captureMigrations: readonly DaemonDatabaseMigration[] = [{ version: 1, id: 'capture', async up(tx) {
 await tx.execute('CREATE TABLE captureSummaries (id TEXT NOT NULL, worktree TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL, shape TEXT, traceId TEXT, spanId TEXT, durationMs REAL, outcome TEXT, parentSpanId TEXT, spanKind INTEGER, serviceName TEXT, endpointMethod TEXT, endpointRoute TEXT, httpStatusCode INTEGER, statementKind TEXT, parameterIdentity TEXT, executionIdentity TEXT, callsite TEXT, transactionId TEXT, retryOf TEXT, connectionId TEXT, PRIMARY KEY(worktree,id))');
 await tx.execute('CREATE INDEX captureTime ON captureSummaries(worktree,at,id)');
 await tx.execute('CREATE INDEX captureTrace ON captureSummaries(worktree,traceId)');
 await tx.execute('CREATE INDEX captureShape ON captureSummaries(worktree,shape)');
 await tx.execute('CREATE TABLE captureDetails (id TEXT NOT NULL, worktree TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(worktree,id))');
} }, { version: 2, id: 'log-severity', async up(tx) {
 await tx.execute('ALTER TABLE captureSummaries ADD COLUMN severityNumber INTEGER');
} }, { version: 3, id: 'exceptions', async up(tx) {
 // Raw occurrences stay on this collector; the Account issue record holds no stack.
 await tx.execute('CREATE TABLE captureExceptions (id TEXT NOT NULL, worktree TEXT NOT NULL, at INTEGER NOT NULL, fingerprint TEXT NOT NULL, origin TEXT NOT NULL, serviceName TEXT, serviceVersion TEXT, type TEXT, message TEXT, topFrame TEXT, traceId TEXT, spanId TEXT, escaped INTEGER, PRIMARY KEY(worktree,id))');
 await tx.execute('CREATE INDEX captureExceptionGroup ON captureExceptions(worktree,fingerprint,at)');
} }, metricMigration, costMigration, worktreeMigration];
const summaryFields = ['id','worktree','kind','source','at','shape','traceId','spanId','durationMs','outcome','parentSpanId','spanKind','serviceName','endpointMethod','endpointRoute','httpStatusCode','statementKind','parameterIdentity','executionIdentity','callsite','transactionId','retryOf','connectionId','severityNumber'] as const;
const summaryWriteFields = [...summaryFields, 'serviceVersion', 'genAi'] as const;
const changingFields = summaryWriteFields.filter(field => field !== 'id' && field !== 'worktree');
// Disabling future numeric capture does not erase an already retained call on an exporter retry.
const summaryUpdateValue = (field: typeof changingFields[number]) => field === 'genAi'
 ? 'COALESCE(excluded.genAi,captureSummaries.genAi)' : `excluded.${field}`;
const summarySql = `INSERT INTO captureSummaries(${summaryWriteFields.join(',')}) VALUES(${summaryWriteFields.map(() => '?').join(',')}) ON CONFLICT(worktree,id) DO UPDATE SET ${changingFields.map(field => `${field}=${summaryUpdateValue(field)}`).join(',')} WHERE ${changingFields.map(field => `${field} IS NOT ${summaryUpdateValue(field)}`).join(' OR ')}`;
const detailSql = 'INSERT INTO captureDetails(id,worktree,at,body) VALUES(?,?,?,?) ON CONFLICT(worktree,id) DO UPDATE SET at=excluded.at,body=excluded.body WHERE body IS NOT excluded.body';
const exceptionFields = ['id','worktree','at','fingerprint','origin','serviceName','serviceVersion','type','message','topFrame','traceId','spanId','escaped'] as const;
/** An exporter retry repeats the same occurrence identity and changes nothing. */
const exceptionSql = `INSERT INTO captureExceptions(${exceptionFields.join(',')}) VALUES(${exceptionFields.map(() => '?').join(',')}) ON CONFLICT(worktree,id) DO NOTHING`;
/** A detail is truncated visibly against the host's statement-input bound, never an invented telemetry cap. */
function detailBody(event: Pick<CaptureSummaryEvent, 'id' | 'worktree' | 'detail'>): string {
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
 const metricStore = createMetricStore(queryPage);
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
  ...metricStore,
  ...createCaptureWorktrees(db, queryPage),
  ...createCostStore(queryPage),
  async listPartitions(): Promise<readonly string[]> {
   const partitions: string[] = [];
   let after = '';
   while (true) {
    // Retention can remove summaries before the matching detail chunk. Include
    // every owned table so an offline assignment withdrawal clears all history.
    const { rows: page, pageSize } = await queryPage('SELECT worktree FROM (SELECT worktree FROM captureSummaries UNION SELECT worktree FROM captureDetails UNION SELECT worktree FROM captureExceptions UNION SELECT worktree FROM metricPoints UNION SELECT worktree FROM metricBuckets) WHERE worktree > ? ORDER BY worktree LIMIT ?', [after], limits.maximumResultRows);
    for (const row of page) partitions.push(String(row.worktree));
    if (page.length < pageSize) return partitions;
    after = partitions[partitions.length - 1]!;
   }
  },
  async write(events: readonly CaptureEvent[]) {
   if (!events.length) return;
   const changed = new Set<string>();
   await db.transaction(async tx => {
    for (const event of events) {
     if (event.kind === 'metric') {
      if (await writeMetricPoint(tx, event.worktree, event.metric)) changed.add(event.worktree);
      continue;
     }
     if (event.kind === 'exception') {
      const inserted = await tx.execute(exceptionSql, exceptionFields.map(field => field === 'escaped'
       ? (event.escaped === undefined ? null : Number(event.escaped)) : event[field] ?? null));
      // The stack lives once, in the same detail table and retention as every other capture detail.
      if (inserted.changes) { await tx.execute(detailSql, [event.id, event.worktree, event.at, detailBody(event)]); changed.add(event.worktree); }
      continue;
     }
     const result = await tx.execute(summarySql, summaryWriteFields.map(field => field === 'genAi'
      ? event.genAi ? JSON.stringify(event.genAi) : null : event[field] ?? null));
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
  /** Affected groups only: a caller names the fingerprints it needs, or reads the newest page. */
  async exceptionGroups(input: CaptureExceptionGroupsInput): Promise<readonly CaptureExceptionGroup[]> {
   const scoped = input.fingerprints === undefined ? '' : ` AND fingerprint IN (${input.fingerprints.map(() => '?').join(',')})`;
   if (input.fingerprints?.length === 0) return [];
   const params: DaemonDatabaseValue[] = [input.worktree, ...(input.fingerprints ?? [])];
   const after = input.after ? 'WHERE groups.lastAt < ? OR (groups.lastAt = ? AND groups.fingerprint > ?) ' : '';
   if (input.after) params.push(input.after.lastAt, input.after.lastAt, input.after.fingerprint);
   const statement = `WITH scoped AS (SELECT * FROM captureExceptions WHERE worktree = ?${scoped}),
groups AS (SELECT fingerprint,COUNT(*) AS count,MIN(at) AS firstAt,MAX(at) AS lastAt FROM scoped GROUP BY fingerprint),
latest AS (SELECT fingerprint,id AS lastId,serviceName,serviceVersion AS lastServiceVersion,type,message,topFrame,ROW_NUMBER() OVER (PARTITION BY fingerprint ORDER BY at DESC,id DESC) AS position FROM scoped)
SELECT groups.fingerprint,groups.count,groups.firstAt,groups.lastAt,latest.lastId,latest.serviceName,latest.lastServiceVersion,latest.type,latest.message,latest.topFrame
FROM groups JOIN latest ON latest.fingerprint = groups.fingerprint AND latest.position = 1 ${after}ORDER BY groups.lastAt DESC,groups.fingerprint LIMIT ?`;
   const { rows } = await queryPage(statement, params, Math.min(input.limit, limits.maximumResultRows));
   return rows as unknown as readonly CaptureExceptionGroup[];
  },
  /** Distinct emitted releases for one group, for the writer's recurrence decision. */
  async exceptionVersions(worktree: string, fingerprint: string): Promise<readonly (string | null)[]> {
   const rows = await db.query('SELECT DISTINCT serviceVersion FROM captureExceptions WHERE worktree = ? AND fingerprint = ? LIMIT ?', [worktree, fingerprint, limits.maximumResultRows]);
   return rows.map(row => typeof row.serviceVersion === 'string' ? row.serviceVersion : null);
  },
  /** The first occurrence after a resolution from a release not seen before it (unknown release counts). */
  async exceptionRecurrence(worktree: string, fingerprint: string, afterAt: number, priorVersions: readonly string[]): Promise<Readonly<{ at: number; serviceVersion: string | null }> | null> {
   const excluded = priorVersions.length ? ` AND (serviceVersion IS NULL OR serviceVersion NOT IN (${priorVersions.map(() => '?').join(',')}))` : '';
   const rows = await db.query('SELECT at,serviceVersion FROM captureExceptions WHERE worktree = ? AND fingerprint = ? AND at > ?' + excluded + ' ORDER BY at,id LIMIT 1',
    [worktree, fingerprint, afterAt, ...priorVersions]);
   const row = rows[0];
   return row ? { at: Number(row.at), serviceVersion: typeof row.serviceVersion === 'string' ? row.serviceVersion : null } : null;
  },
  async exceptionOccurrences(input: CaptureExceptionOccurrencesInput): Promise<readonly CaptureExceptionOccurrence[]> {
   const predicates = ['worktree = ?', 'fingerprint = ?'];
   const params: DaemonDatabaseValue[] = [input.worktree, input.fingerprint];
   if (input.before) { predicates.push('(at < ? OR (at = ? AND id < ?))'); params.push(input.before.at, input.before.at, input.before.id); }
   const { rows } = await queryPage(`SELECT ${exceptionFields.join(',')} FROM captureExceptions WHERE ${predicates.join(' AND ')} ORDER BY at DESC,id DESC LIMIT ?`, params, Math.min(input.limit, limits.maximumResultRows));
   // SQLite scalar decoding is the genuine boundary; escaped is stored as 0/1/NULL.
   return rows.map(row => {
    const { escaped, ...rest } = row as unknown as Omit<CaptureExceptionOccurrence, 'escaped'> & { escaped: number | null };
    return { ...rest, ...(escaped === null ? {} : { escaped: escaped === 1 }) } as CaptureExceptionOccurrence;
   });
  },
  async detail(worktree: string, id: string): Promise<Extract<DatabaseCaptureQueryGetResultV1, { ok: true }>['detail']> {
   const rows = await db.query('SELECT body FROM captureDetails WHERE worktree = ? AND id = ?', [worktree, id]);
   return typeof rows[0]?.body === 'string' ? JSON.parse(rows[0].body) : null;
  },
  async clear(worktree: string) {
   let changed = 0;
   await db.transaction(async tx => {
    for (const table of [...metricRetention.map(({ table }) => table), 'captureDetails', 'captureSummaries', 'captureExceptions']) {
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
export type CaptureSummaryEvent = CaptureSummary & Readonly<{ detail?: Readonly<Record<string, unknown>>;
 serviceVersion?: string; genAi?: DatabaseCaptureCostMetadataV1 }>;
/** One redacted exception occurrence; identity is span/event position or the emitter's log uid. */
export type CaptureExceptionOccurrence = Readonly<{
 id: string; worktree: string; at: number; fingerprint: string; origin: 'span' | 'log';
 serviceName?: string | null; serviceVersion?: string | null; type?: string | null; message?: string | null; topFrame?: string | null;
 traceId?: string | null; spanId?: string | null; escaped?: boolean;
}>;
export type CaptureExceptionEvent = CaptureExceptionOccurrence & Readonly<{ kind: 'exception'; detail: Readonly<Record<string, unknown>> }>;
export type CaptureMetricEvent = Readonly<{id:string;worktree:string;kind:'metric';source:'otlp';at:number;metric:NormalizedMetricPoint}>;
export type CaptureEvent = CaptureSummaryEvent | CaptureExceptionEvent | CaptureMetricEvent;
export type CaptureExceptionGroup = Readonly<{
 fingerprint: string; count: number; firstAt: number; lastAt: number; lastId: string;
 serviceName: string | null; lastServiceVersion: string | null; type: string | null; message: string | null; topFrame: string | null;
}>;
export type CaptureExceptionGroupsInput = Readonly<{ worktree: string; limit: number; fingerprints?: readonly string[];
 after?: Readonly<{ lastAt: number; fingerprint: string }> }>;
export type CaptureExceptionOccurrencesInput = Readonly<{ worktree: string; fingerprint: string; limit: number; before?: Readonly<{ at: number; id: string }> }>;
export type CaptureListInput = Readonly<{worktree: string; kind?: CaptureSummary['kind']; traceId?: string; spanKind?: number; serviceName?: string; severityNumber?: number; since?: number; until?: number; limit: number; before?: Readonly<{at:number; id:string}>}>;
export type CaptureEndpointCursor = Readonly<{ serviceName: string; method: string; route: string }>;
export type CaptureEndpointSummary = CaptureEndpointCursor & Readonly<{ requestCount: number; errorCount: number; totalDurationMs: number; databaseTimeMs: number }>;
export type CaptureEndpointListInput = Readonly<{ worktree: string; limit: number; before?: CaptureEndpointCursor; since?: number; until?: number }>;

export const captureDatabaseDefinition = {
 migrations: captureMigrations,
 incumbentQueryFixture: { id: 'capture-readable', async run(tx: import('@happier-dev/plugin-sdk/storage').DaemonDatabaseMigrationReadTransaction) {
  await tx.query('SELECT id,worktree,at FROM captureSummaries LIMIT 1');
  await tx.query('SELECT id,worktree,at FROM captureDetails LIMIT 1');
  await tx.query('SELECT id,worktree,at FROM metricPoints LIMIT 1');
  await tx.query('SELECT pointId,worktree,at FROM metricBuckets LIMIT 1');
 } },
 retention: [...metricRetention, { table: 'captureSummaries', timeColumn: 'at', changeKeyColumn: 'worktree' }, { table: 'captureDetails', timeColumn: 'at', changeKeyColumn: 'worktree' },
  { table: 'captureExceptions', timeColumn: 'at', changeKeyColumn: 'worktree' }],
} as const;
