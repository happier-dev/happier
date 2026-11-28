import type { DaemonDatabase, DaemonDatabaseMigration, DaemonDatabaseRow, DaemonDatabaseValue } from '@happier-dev/plugin-sdk/storage';
import { createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import type { DatabaseWorktreeTargetV1 } from '@happier-dev/plugin-sdk/database';
import type { DatabaseCaptureQueryGetResultV1, DatabaseCaptureTracesListInputV1 } from '@happier-dev/database-protocol';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 as limits } from '@happier-dev/plugin-sdk/storage';
import { createProductionFindingStore, productionFindingMigration, productionFindingRetention } from './productionFindingStore.js';
import { createMetricStore, metricMigration, metricRetention, writeMetricPoint } from './metrics.js';
import { costMigration, createCostStore } from './costs.js';
import { worktreeMigration, createCaptureWorktrees, writeCaptureWorktree } from './worktrees.js';
import type { DatabaseCaptureCostMetadataV1 } from '@happier-dev/database-protocol';
import type { NormalizedMetricPoint } from '../otlp/types.js';
import type { ExceptionApplicationOrigin } from '../exceptions/contracts.js';
import { REQUEST_DATABASE_TIME_SQL_CTES, REQUEST_SPANS_SQL_CTES, REQUEST_ANCESTRY_SQL_CTE, type RequestSpanEvidence } from '../analysis/requests.js';

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
} }, metricMigration, costMigration, worktreeMigration, { version: 7, id: 'exception-application-origin', async up(tx) {
 // Earlier retained exceptions have no proven application origin; never infer one from their text.
 await tx.execute('ALTER TABLE captureExceptions ADD COLUMN applicationOrigin TEXT');
} }, { version: 8, id: 'clear-previous-query-capture', async up(tx) {
 // Queries and their transaction links precede the current normalization and masking contract.
 await tx.execute("DELETE FROM captureSummaries WHERE kind IN ('query','transaction')");
 // Summaries and details expire independently. A detail without either surviving owner has no current shape guarantee.
 await tx.execute(`DELETE FROM captureDetails AS detail
  WHERE NOT EXISTS (SELECT 1 FROM captureSummaries AS summary WHERE summary.worktree = detail.worktree AND summary.id = detail.id)
    AND NOT EXISTS (SELECT 1 FROM captureExceptions AS exception WHERE exception.worktree = detail.worktree AND exception.id = detail.id)`);
} }, { version: 9, id: 'worktree-database-member', async up(tx) {
 await tx.execute('ALTER TABLE captureSummaries ADD COLUMN databaseMemberKey TEXT');
} }, productionFindingMigration, { version: 11, id: 'environment-status-time', async up(tx) {
 // The open status reads the latest exception across fingerprints and the latest cost across models.
 await tx.execute('CREATE INDEX captureExceptionTime ON captureExceptions(worktree,at)');
 await tx.execute('CREATE INDEX captureAppLlmTime ON captureSummaries(worktree,at) WHERE genAi IS NOT NULL');
} }];
const summaryFields = ['id','worktree','kind','source','at','shape','traceId','spanId','durationMs','outcome','parentSpanId','spanKind','serviceName','endpointMethod','endpointRoute','httpStatusCode','statementKind','parameterIdentity','executionIdentity','callsite','transactionId','retryOf','connectionId','severityNumber'] as const;
const summaryWriteFields = [...summaryFields, 'serviceVersion', 'genAi', 'databaseMemberKey'] as const;
const changingFields = summaryWriteFields.filter(field => field !== 'id' && field !== 'worktree');
// Disabling future numeric capture does not erase an already retained call on an exporter retry.
const summaryUpdateValue = (field: typeof changingFields[number]) => field === 'genAi'
 ? 'COALESCE(excluded.genAi,captureSummaries.genAi)' : `excluded.${field}`;
const summarySql = `INSERT INTO captureSummaries(${summaryWriteFields.join(',')}) VALUES(${summaryWriteFields.map(() => '?').join(',')}) ON CONFLICT(worktree,id) DO UPDATE SET ${changingFields.map(field => `${field}=${summaryUpdateValue(field)}`).join(',')} WHERE ${changingFields.map(field => `${field} IS NOT ${summaryUpdateValue(field)}`).join(' OR ')}`;
const detailSql = 'INSERT INTO captureDetails(id,worktree,at,body) VALUES(?,?,?,?) ON CONFLICT(worktree,id) DO UPDATE SET at=excluded.at,body=excluded.body WHERE body IS NOT excluded.body';
const exceptionFields = ['id','worktree','at','fingerprint','origin','serviceName','serviceVersion','type','message','topFrame','traceId','spanId','escaped'] as const;
const exceptionWriteFields = [...exceptionFields, 'applicationOrigin'] as const;
/** An exporter retry repeats the same occurrence identity and changes nothing. */
const exceptionSql = `INSERT INTO captureExceptions(${exceptionWriteFields.join(',')}) VALUES(${exceptionWriteFields.map(() => '?').join(',')}) ON CONFLICT(worktree,id) DO NOTHING`;
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
 async function queryPage<T extends DaemonDatabaseRow>(statement: string, params: readonly DaemonDatabaseValue[],
  requested: number, prefixLength?: number) {
  let pageSize = requested;
  while (true) {
   const pageParams = prefixLength === undefined ? [...params, pageSize] : [...params, pageSize, prefixLength];
   try { return { rows: await db.query<T>(statement, pageParams), pageSize }; }
   catch (error) {
    if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'daemon_database_result_too_large') throw error;
    // Preserve the prefix unless the host refuses even a single row with its metadata.
    if (pageSize > 1) pageSize = Math.ceil(pageSize / 2);
    else if (prefixLength) prefixLength = Math.floor(prefixLength / 2);
    else throw error;
   }
  }
 }
 async function listPage(input: CaptureListInput): Promise<{
  items: readonly CaptureSummary[]; nextCursor: CaptureListInput['before'];
 }> {
  const predicates = ['worktree = ?'];
  const params: (string | number)[] = [input.worktree];
  if (input.kind) { predicates.push('kind = ?'); params.push(input.kind); }
  if (input.databaseMember !== undefined) {
   predicates.push('databaseMemberKey = ?'); params.push(createCanonicalJsonSigningInput(input.databaseMember));
  }
  if (input.traceId) { predicates.push('traceId = ?'); params.push(input.traceId); }
  if (input.spanKind !== undefined) { predicates.push('spanKind = ?'); params.push(input.spanKind); }
  if (input.serviceName !== undefined) { predicates.push('serviceName = ?'); params.push(input.serviceName); }
  if (input.serviceVersion !== undefined) { predicates.push('serviceVersion = ?'); params.push(input.serviceVersion); }
  if (input.endpoints !== undefined) {
   predicates.push(`(endpointMethod, endpointRoute) IN (
    SELECT json_extract(value, '$.method'), json_extract(value, '$.route') FROM json_each(?)
   )`);
   params.push(JSON.stringify(input.endpoints));
  }
  if (input.appLlmCalls) {
   predicates.push('genAi IS NOT NULL', "traceId IS NOT NULL AND traceId <> ''");
   for (const field of ['serviceName', 'serviceVersion'] as const) {
    const value = input.appLlmCalls[field];
    if (value !== undefined) { predicates.push(`${field} = ?`); params.push(value); }
   }
  }
  if (input.severityNumber !== undefined) { predicates.push('severityNumber = ?'); params.push(input.severityNumber); }
  if (input.since !== undefined) { predicates.push('at >= ?'); params.push(input.since); }
  if (input.until !== undefined) { predicates.push('at < ?'); params.push(input.until); }
  if (input.before) { predicates.push('(at < ? OR (at = ? AND id < ?))'); params.push(input.before.at, input.before.at, input.before.id); }
  const requested = Math.min(input.limit, limits.maximumResultRows);
  const includeLogs = (input.kind === undefined || input.kind === 'log') && input.spanKind === undefined;
  const fields = input.appLlmCalls ? [...summaryFields, 'serviceVersion', 'genAi'] : summaryFields;
  // Look ahead one summary within this read, without projecting its body.
  const pageLimit = `?${params.length + 1}`;
  const candidates = `WITH candidates AS MATERIALIZED (
 SELECT ${fields.join(',')} FROM captureSummaries WHERE ${predicates.join(' AND ')}
 ORDER BY at DESC,id DESC LIMIT (${pageLimit} + 1)
), selected AS (
 SELECT *, EXISTS (SELECT 1 FROM candidates LIMIT 1 OFFSET ${pageLimit}) AS hasOlder
 FROM candidates ORDER BY at DESC,id DESC LIMIT ${pageLimit}
)`;
  // Only already-redacted retained bodies are projected, scoped by BOTH keys.
  // substr works in Unicode code points, so the prefix cannot split UTF-8.
  const statement = includeLogs ? `${candidates},
logBodies AS MATERIALIZED (SELECT selected.*, CASE WHEN selected.kind = 'log' THEN
 (SELECT CAST(json_extract(body,'$.log.body') AS TEXT) FROM captureDetails WHERE worktree = selected.worktree AND id = selected.id)
 END AS logBody FROM selected),
logPrefixes AS (SELECT *, substr(
 CASE WHEN instr(logBody,char(10)) > 0 THEN substr(logBody,1,instr(logBody,char(10))-1) ELSE logBody END,
 1, ?) AS bodyPrefix FROM logBodies)
SELECT ${summaryFields.join(',')},hasOlder,bodyPrefix,
 CASE WHEN length(logBody) > length(bodyPrefix) THEN 1 ELSE 0 END AS bodyPrefixTruncated FROM logPrefixes ORDER BY at DESC,id DESC`
   : `${candidates} SELECT * FROM selected ORDER BY at DESC,id DESC`;
  // A JSON-escaped code point can occupy six bytes. The host measures the actual page, including metadata.
  const prefixLength = includeLogs ? Math.floor(limits.maximumResultBytes / 6) : undefined;
  const { rows: page } = await queryPage(statement, params, requested, prefixLength);
  // The table is produced only by this store; SQLite scalar decoding is the genuine boundary.
  const summaries = page.map(({ hasOlder: _hasOlder, ...summary }) => summary) as unknown as readonly CaptureSummary[];
  const last = summaries.at(-1);
  const nextCursor = last && page[0]?.hasOlder === 1 ? { at: last.at, id: last.id } : undefined;
  if (input.appLlmCalls) {
   const calls = summaries as unknown as readonly (Omit<CaptureSummary, 'genAi'> & { genAi: string })[];
   return { items: calls.map(call => ({ ...call, genAi: JSON.parse(call.genAi) as DatabaseCaptureCostMetadataV1 })), nextCursor };
  }
  const items = includeLogs ? summaries.map(summary => {
   const { bodyPrefix, bodyPrefixTruncated, ...rest } = summary;
   return bodyPrefix === null || bodyPrefix === undefined ? rest
    : { ...rest, bodyPrefix, bodyPrefixTruncated: Boolean(bodyPrefixTruncated) };
  }) : summaries;
  return { items, nextCursor };
 }
 async function traceQueryMemberKeys(worktree: string, traceId: string, source: 'wire' | 'otlp'): Promise<ReadonlyMap<string, string>> {
  const keys = new Map<string, string>();
  let after = '';
  for (;;) {
   const { rows, pageSize } = await queryPage<{ id: string; databaseMemberKey: string }>(
    "SELECT id, databaseMemberKey FROM captureSummaries WHERE worktree = ? AND traceId = ? AND kind = 'query' AND source = ? AND databaseMemberKey IS NOT NULL AND id > ? ORDER BY id LIMIT ?",
    [worktree, traceId, source, after], limits.maximumResultRows);
   for (const row of rows) keys.set(row.id, row.databaseMemberKey);
   if (rows.length < pageSize) return keys;
   after = rows[rows.length - 1].id;
  }
 }
 return {
  ...metricStore,
  ...createProductionFindingStore(db),
  ...createCaptureWorktrees(db, queryPage),
  ...createCostStore(queryPage),
  async environmentStatus(partition: string) {
   // Keep only the newest stored time for each signal. The loss marker is not evidence.
   const [row] = await db.query<{
    summary: number | null; metrics: number | null; appLlmCost: number | null; exceptions: number | null;
   }>(`SELECT
    (SELECT at FROM captureSummaries WHERE worktree = ? AND kind != 'coverage' ORDER BY at DESC LIMIT 1) AS summary,
    (SELECT CAST(at AS INTEGER) FROM metricPoints WHERE worktree = ? ORDER BY metricPoints.at DESC LIMIT 1) AS metrics,
    (SELECT at FROM captureSummaries WHERE worktree = ? AND genAi IS NOT NULL ORDER BY at DESC LIMIT 1) AS appLlmCost,
    (SELECT at FROM captureExceptions WHERE worktree = ? ORDER BY at DESC LIMIT 1) AS exceptions
   `, [partition, partition, partition, partition]);
   const metrics = row?.metrics ?? null;
   const summary = row?.summary ?? null;
   return {
    lastReceivedAt: summary === null ? metrics : Math.max(summary, metrics ?? summary),
    capabilityLastSampleAt: { metrics, appLlmCost: row?.appLlmCost ?? null, exceptions: row?.exceptions ?? null },
   };
  },
  async listPartitions(): Promise<readonly string[]> {
   const partitions: string[] = [];
   let after = '';
   while (true) {
    // Retention can remove summaries before the matching detail chunk. Include
    // every owned table so an offline assignment withdrawal clears all history.
    const { rows: page, pageSize } = await queryPage('SELECT worktree FROM (SELECT worktree FROM captureSummaries UNION SELECT worktree FROM captureDetails UNION SELECT worktree FROM captureExceptions UNION SELECT worktree FROM metricPoints UNION SELECT worktree FROM metricBuckets UNION SELECT worktree FROM captureFindingRepresentatives) WHERE worktree > ? ORDER BY worktree LIMIT ?', [after], limits.maximumResultRows);
    for (const row of page) partitions.push(String(row.worktree));
    if (page.length < pageSize) return partitions;
    after = partitions[partitions.length - 1]!;
   }
  },
  async write(events: readonly CaptureEvent[]): Promise<readonly string[]> {
   if (!events.length) return [];
   const changed = new Set<string>();
   let changedTraceIds: Set<string> | undefined;
   await db.transaction(async tx => {
    // Local observations and the lookup used by settled worktree removal commit together.
    const indexedWorktrees = new Set<string>();
    for (const event of events) {
     if (event.physicalRootIdentity !== undefined && !indexedWorktrees.has(event.worktree)) {
      await writeCaptureWorktree(tx, event.worktree, event.physicalRootIdentity);
      indexedWorktrees.add(event.worktree);
     }
     if (event.kind === 'metric') {
      if (await writeMetricPoint(tx, event.worktree, event.metric)) changed.add(event.worktree);
      continue;
     }
     if (event.kind === 'exception') {
      const inserted = await tx.execute(exceptionSql, exceptionWriteFields.map(field => field === 'escaped'
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
     if (result.changes || detailsChanged) {
      changed.add(event.worktree);
      if (event.source === 'otlp' && (event.kind === 'query' || event.kind === 'span') && event.traceId) {
       (changedTraceIds ??= new Set()).add(event.traceId);
      }
     }
    }
   });
   if (changed.size) publish([...changed]);
   return [...(changedTraceIds ?? [])];
  },
  listPage,
  async list(input: CaptureListInput): Promise<readonly CaptureSummary[]> {
   const rows: CaptureSummary[] = [];
   let before = input.before;
   while (rows.length < input.limit) {
    const page = await listPage({ ...input, before, limit: input.limit - rows.length });
    rows.push(...page.items);
    if (!page.nextCursor) break;
    before = page.nextCursor;
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
    const endpoint = input.endpoint;
    const selectedKey = endpoint ? 'WHERE serviceName = ? AND method = ? AND route = ?' : '';
    if (endpoint) params.push(endpoint.serviceName, endpoint.method, endpoint.route);
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
 SUM(COALESCE(durationMs,0)) AS totalDurationMs FROM endpointCandidates ${selectedKey} GROUP BY serviceName,method,route
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
groups AS (SELECT fingerprint,COUNT(*) AS count,MIN(at) AS firstAt,MAX(at) AS lastAt,MAX(applicationOrigin) AS applicationOrigin FROM scoped GROUP BY fingerprint),
latest AS (SELECT fingerprint,id AS lastId,serviceName,serviceVersion AS lastServiceVersion,type,message,topFrame,ROW_NUMBER() OVER (PARTITION BY fingerprint ORDER BY at DESC,id DESC) AS position FROM scoped)
SELECT groups.fingerprint,groups.count,groups.firstAt,groups.lastAt,groups.applicationOrigin,latest.lastId,latest.serviceName,latest.lastServiceVersion,latest.type,latest.message,latest.topFrame
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
  /** One group's counts per authored bucket and the distinct traces it reached, over retained occurrences only. */
  async exceptionTrend(input: Readonly<{ worktree: string; fingerprint: string; since: number; until: number; bucketMs: number }>): Promise<Readonly<{
   buckets: readonly Readonly<{ since: number; until: number; count: number }>[]; requestsAffected: number }>> {
   const where = 'worktree = ? AND fingerprint = ? AND at >= ? AND at < ?';
   const params = [input.worktree, input.fingerprint, input.since, input.until];
   const counts = new Map<number, number>();
   let afterAt = input.since;
   while (true) {
    const { rows, pageSize } = await queryPage(`SELECT CAST((at - ?) / ? AS INTEGER) AS bucket, COUNT(*) AS count FROM captureExceptions WHERE ${where} GROUP BY bucket ORDER BY bucket LIMIT ?`,
     [input.since, input.bucketMs, input.worktree, input.fingerprint, afterAt, input.until], limits.maximumResultRows);
    for (const row of rows) counts.set(Number(row.bucket), Number(row.count));
    if (rows.length < pageSize) break;
    // Resume at the next whole bucket, using the existing group/time index.
    afterAt = input.since + (Number(rows.at(-1)!.bucket) + 1) * input.bucketMs;
   }
   const [affected] = await db.query(`SELECT COUNT(DISTINCT traceId) AS requests FROM captureExceptions WHERE ${where} AND traceId IS NOT NULL`, params);
   const buckets: { since: number; until: number; count: number }[] = [];
   for (let start = input.since, index = 0; start < input.until; start += input.bucketMs, index++) {
    buckets.push({ since: start, until: Math.min(start + input.bucketMs, input.until), count: counts.get(index) ?? 0 });
   }
   return { buckets, requestsAffected: Number(affected?.requests ?? 0) };
  },
  async exceptionOccurrences(input: CaptureExceptionOccurrencesInput): Promise<readonly CaptureExceptionOccurrence[]> {
   const predicates = ['worktree = ?', 'fingerprint = ?'];
   const params: DaemonDatabaseValue[] = [input.worktree, input.fingerprint];
   if (input.before) { predicates.push('(at < ? OR (at = ? AND id < ?))'); params.push(input.before.at, input.before.at, input.before.id); }
   // Page first, then attribute only those traces through the one nearest-server SQL owner.
   // No detail bodies or per-occurrence RPC/query; retained/missing requests stay nullable.
   const { rows } = await queryPage(`WITH RECURSIVE
capturePartition AS (SELECT ? AS worktree),
selected AS MATERIALIZED (SELECT ${exceptionFields.join(',')} FROM captureExceptions WHERE ${predicates.join(' AND ')} ORDER BY at DESC,id DESC LIMIT ?),
captureEvidence AS MATERIALIZED (SELECT id,at,traceId,spanId,parentSpanId,spanKind,httpStatusCode,durationMs FROM captureSummaries
 WHERE worktree = (SELECT worktree FROM capturePartition) AND traceId IN (SELECT traceId FROM selected)),
${REQUEST_SPANS_SQL_CTES}
logicalExecutions AS (SELECT id,traceId,spanId,NULL AS knownParentSpanId,0 AS durationMs FROM selected),
${REQUEST_ANCESTRY_SQL_CTE}
requestFacts AS (SELECT ancestry.executionId,evidence.httpStatusCode,evidence.durationMs FROM requestAncestry ancestry
 JOIN requestSpanVersions version ON version.traceId = ancestry.traceId AND version.spanId = ancestry.spanId AND version.version = 1
 JOIN captureEvidence evidence ON evidence.traceId = version.traceId AND evidence.spanId = version.spanId AND evidence.id = version.id
 WHERE ancestry.spanKind = 2)
SELECT selected.*,request.httpStatusCode,request.durationMs FROM selected LEFT JOIN requestFacts request ON request.executionId = selected.id
ORDER BY selected.at DESC,selected.id DESC`, [input.worktree, ...params], Math.min(input.limit, limits.maximumResultRows));
   // SQLite scalar decoding is the genuine boundary; escaped is stored as 0/1/NULL.
   return rows.map(row => {
    const { escaped, ...rest } = row as unknown as Omit<CaptureExceptionOccurrence, 'escaped'> & { escaped: number | null };
    return { ...rest, ...(escaped === null ? {} : { escaped: escaped === 1 }) } as CaptureExceptionOccurrence;
   });
  },
  async requestSpans(worktree: string, traceId: string, limit: number): Promise<RequestSpanEvidence[]> {
   const spans: RequestSpanEvidence[] = [];
   let after = '';
   for (;;) {
    const { rows, pageSize } = await queryPage<{ spanId: string; parentSpanId: string | null; spanKind: number }>(
     `WITH captureEvidence AS (
       SELECT id,at,traceId,spanId,parentSpanId,spanKind FROM captureSummaries
       WHERE worktree = ? AND traceId = ? AND spanId > ?
      ), ${REQUEST_SPANS_SQL_CTES} selected AS (SELECT * FROM requestSpans ORDER BY spanId LIMIT ?)
      SELECT spanId,parentSpanId,spanKind FROM selected ORDER BY spanId`,
     [worktree, traceId, after], Math.min(limit, limits.maximumResultRows));
    for (const row of rows) spans.push({ traceId, spanId: row.spanId, kind: row.spanKind,
     ...(row.parentSpanId ? { parentSpanId: row.parentSpanId } : {}) });
    if (rows.length < pageSize) return spans;
    after = rows[rows.length - 1]!.spanId;
   }
  },
  async detail(worktree: string, id: string, selection?: Readonly<{ fingerprint: string } | { databaseMember: DatabaseWorktreeTargetV1 }>)
  : Promise<Extract<DatabaseCaptureQueryGetResultV1, { ok: true }>['detail']> {
   // Retention can remove the owning summary or occurrence before it removes the body.
   const scope = selection && 'fingerprint' in selection
    ? { table: 'captureExceptions', predicate: 'AND fingerprint = ?', params: [selection.fingerprint] }
    : { table: 'captureSummaries', predicate: selection ? "AND kind = 'query' AND databaseMemberKey = ?" : '',
     params: selection ? [createCanonicalJsonSigningInput(selection.databaseMember)] : [] };
   const rows = await db.query(`SELECT body FROM captureDetails WHERE worktree = ? AND id = ? AND EXISTS (
    SELECT 1 FROM ${scope.table} WHERE worktree = captureDetails.worktree AND id = captureDetails.id ${scope.predicate}
   )`, [worktree, id, ...scope.params]);
   return typeof rows[0]?.body === 'string' ? JSON.parse(rows[0].body) : null;
  },
  traceDatabaseEndpointKeys(worktree: string, traceId: string) {
   return traceQueryMemberKeys(worktree, traceId, 'otlp');
  },
  traceWorktreeMemberKeys(worktree: string, traceId: string) {
   return traceQueryMemberKeys(worktree, traceId, 'wire');
  },
  async clear(worktree: string) {
   let changed = 0;
   await db.transaction(async tx => {
    for (const table of [...metricRetention.map(({ table }) => table), 'captureDetails', 'captureSummaries', 'captureExceptions', productionFindingRetention.table]) {
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
 bodyPrefix?: string; bodyPrefixTruncated?: boolean;
 serviceVersion?: string | null; genAi?: DatabaseCaptureCostMetadataV1;
 shape?: string | null; traceId?: string | null; spanId?: string | null; durationMs?: number | null; outcome?: string | null;
 parentSpanId?: string | null; spanKind?: number | null; serviceName?: string | null; severityNumber?: number | null; endpointMethod?: string | null; endpointRoute?: string | null; httpStatusCode?: number | null;
 statementKind?: 'select' | 'control' | 'other' | 'unknown' | null; parameterIdentity?: string | null; executionIdentity?: string | null; callsite?: string | null; transactionId?: string | null; retryOf?: string | null; connectionId?: string | null;
}>;
/** Values here have already passed the canonical dialect's masking boundary. */
export type CaptureSummaryEvent = CaptureSummary & Readonly<{ detail?: Readonly<Record<string, unknown>>; databaseMemberKey?: string;
 serviceVersion?: string }>;
/** One redacted exception occurrence; identity is span/event position or the emitter's log uid. */
export type CaptureExceptionOccurrence = Readonly<{
 id: string; worktree: string; at: number; fingerprint: string; origin: 'span' | 'log';
 applicationOrigin?: ExceptionApplicationOrigin;
 serviceName?: string | null; serviceVersion?: string | null; type?: string | null; message?: string | null; topFrame?: string | null;
 traceId?: string | null; spanId?: string | null; escaped?: boolean;
 /** Facts of the nearest retained server span; null when uncorrelated/expired. */
 httpStatusCode?: number | null; durationMs?: number | null;
}>;
export type CaptureExceptionEvent = CaptureExceptionOccurrence & Readonly<{ kind: 'exception'; detail: Readonly<Record<string, unknown>> }>;
export type CaptureMetricEvent = Readonly<{id:string;worktree:string;kind:'metric';source:'otlp';at:number;metric:NormalizedMetricPoint}>;
export type CaptureEvent = (CaptureSummaryEvent | CaptureExceptionEvent | CaptureMetricEvent) & Readonly<{ physicalRootIdentity?: string }>;
export type CaptureExceptionGroup = Readonly<{
 fingerprint: string; count: number; firstAt: number; lastAt: number; lastId: string;
 applicationOrigin?: ExceptionApplicationOrigin | null;
 serviceName: string | null; lastServiceVersion: string | null; type: string | null; message: string | null; topFrame: string | null;
}>;
export type CaptureExceptionGroupsInput = Readonly<{ worktree: string; limit: number; fingerprints?: readonly string[];
 after?: Readonly<{ lastAt: number; fingerprint: string }> }>;
export type CaptureExceptionOccurrencesInput = Readonly<{ worktree: string; fingerprint: string; limit: number; before?: Readonly<{ at: number; id: string }> }>;
export type CaptureListInput = Readonly<{worktree: string; databaseMember?: DatabaseWorktreeTargetV1; appLlmCalls?: DatabaseCaptureTracesListInputV1['appLlmCalls']; kind?: CaptureSummary['kind']; traceId?: string; spanKind?: number; serviceName?: string; serviceVersion?: string;
 endpoints?: readonly Readonly<{ method: string; route: string }>[];
 severityNumber?: number; since?: number; until?: number; limit: number; before?: Readonly<{at:number; id:string}>}>;
export type CaptureEndpointCursor = Readonly<{ serviceName: string; method: string; route: string }>;
export type CaptureEndpointSummary = CaptureEndpointCursor & Readonly<{ requestCount: number; errorCount: number; totalDurationMs: number; databaseTimeMs: number }>;
export type CaptureEndpointListInput = Readonly<{ worktree: string; limit: number; before?: CaptureEndpointCursor; since?: number; until?: number; endpoint?: CaptureEndpointCursor }>;

export const captureDatabaseDefinition = {
 migrations: captureMigrations,
 incumbentQueryFixture: { id: 'capture-readable', async run(tx: import('@happier-dev/plugin-sdk/storage').DaemonDatabaseMigrationReadTransaction) {
  await tx.query('SELECT id,worktree,at FROM captureSummaries LIMIT 1');
  await tx.query('SELECT id,worktree,at FROM captureDetails LIMIT 1');
  await tx.query('SELECT id,worktree,at FROM metricPoints LIMIT 1');
  await tx.query('SELECT pointId,worktree,at FROM metricBuckets LIMIT 1');
 } },
 retention: [...metricRetention, productionFindingRetention, { table: 'captureSummaries', timeColumn: 'at', changeKeyColumn: 'worktree' }, { table: 'captureDetails', timeColumn: 'at', changeKeyColumn: 'worktree' },
  { table: 'captureExceptions', timeColumn: 'at', changeKeyColumn: 'worktree' }],
} as const;
