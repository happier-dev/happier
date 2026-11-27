import { describe, expect, it } from 'vitest';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 as limits, type DaemonDatabase, type DaemonDatabaseRow, type DaemonDatabaseValue } from '@happier-dev/plugin-sdk/storage';
import { captureMigrations, createCaptureStore } from './capture.js';
import { writeCaptureWorktree } from './worktrees.js';
import { createCaptureSqliteFixture as fixture } from '../testing/sqlite.js';
describe('capture store through SQLite', () => {
 it('preserves useful first lines when 100 logs are requested', async () => {
  const f = fixture();
  try {
   for (const migration of captureMigrations) await migration.up(f.db);
   const store = createCaptureStore(f.db, () => {});
   const line = 'Checkout completed for the authenticated customer. '.repeat(4).trim();
   await store.write(Array.from({ length: 100 }, (_, at) => ({
    id: String(at), worktree: 'chosen', kind: 'log', source: 'otlp', at,
    detail: { log: { body: at % 2 ? line : `${line}\nrequest metadata` } },
   })));
   const rows = await store.list({ worktree: 'chosen', kind: 'log', limit: 100 });
   expect(rows.map(({ bodyPrefix }) => bodyPrefix)).toEqual(Array(100).fill(line));
   expect(rows.map(({ bodyPrefixTruncated }) => bodyPrefixTruncated))
    .toEqual(Array.from({ length: 100 }, (_, index) => index % 2 === 1));
  } finally { f.close(); }
 });
 it('returns bounded redacted log prefixes for N rows in one list read, with details on demand', async () => {
  const f = fixture();
  try {
   for (const migration of captureMigrations) await migration.up(f.db);
   const store = createCaptureStore(f.db, () => {});
   const bodies = ['short [REDACTED]', 'first line\nprivate second line', '😀'.repeat(3000), { message: '[REDACTED]' }];
   await store.write(bodies.map((body, index) => ({ id: String(index), worktree: 'chosen', kind: 'log', source: 'otlp', at: index, detail: { log: { body } } })));
   await store.write([{ id: '0', worktree: 'other', kind: 'log', source: 'otlp', at: 99, detail: { log: { body: 'other worktree' } } }]);
   f.statements.length = 0;
   const rows = await store.list({ worktree: 'chosen', kind: 'log', limit: 10 });
   expect(f.statements).toHaveLength(1);
   expect(rows).toEqual([
    expect.objectContaining({ id: '3', bodyPrefix: '{"message":"[REDACTED]"}', bodyPrefixTruncated: false }),
    expect.objectContaining({ id: '2', bodyPrefix: expect.any(String), bodyPrefixTruncated: true }),
    expect.objectContaining({ id: '1', bodyPrefix: 'first line', bodyPrefixTruncated: true }),
    expect.objectContaining({ id: '0', bodyPrefix: 'short [REDACTED]', bodyPrefixTruncated: false }),
   ]);
   expect(JSON.stringify(rows)).not.toContain('private second line');
   expect(JSON.stringify(rows)).not.toContain('other worktree');
   expect(rows[1]!.bodyPrefix).toMatch(/^(?:😀)+$/u);
   expect(rows[1]!.bodyPrefix!.length).toBeLessThan(String(bodies[2]).length);
   expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(limits.maximumResultBytes);
   expect(await store.detail('chosen', '1')).toEqual({ log: { body: bodies[1] } });
  } finally { f.close(); }
 });
 it('continues after byte-limited log pages, including an oversized single-row projection', async () => {
  const f = fixture();
  try {
   for (const migration of captureMigrations) await migration.up(f.db);
   const acceptedBytes: number[] = [];
   // The daemon worker measures encoded row bytes and separator commas, excluding array brackets.
   const db: DaemonDatabase = {
    ...f.db,
    async query<T extends DaemonDatabaseRow>(sql: string, params: readonly DaemonDatabaseValue[] = []) {
     const rows = await f.db.query<T>(sql, params);
     const bytes = Buffer.byteLength(JSON.stringify(rows)) - 2;
     if (bytes > limits.maximumResultBytes) {
      throw Object.assign(new Error('SQLite query result exceeds the daemon database limit'), { code: 'daemon_database_result_too_large' });
     }
     acceptedBytes.push(bytes);
     return rows;
    },
   };
   const store = createCaptureStore(db, () => {});
   const body = '\u0001'.repeat(2000);
   await store.write(['a', 'b', 'c'].map(id => ({
    id, worktree: 'chosen', kind: 'log', source: 'otlp', at: 10,
    serviceName: id === 'c' ? 'x'.repeat(5000) : 'checkout',
    detail: { log: { body } },
   })));
   const input = { worktree: 'chosen', kind: 'log', limit: 100 } as const;
   const first = await store.listPage(input);
   expect(first.items.map(({ id }) => id)).toEqual(['c']);
   expect(first.items[0]!.bodyPrefixTruncated).toBe(true);
   expect(first.items[0]!.bodyPrefix!.length).toBeGreaterThan(200);
   expect(first.nextCursor).toEqual({ at: 10, id: 'c' });

   const second = await store.listPage({ ...input, before: first.nextCursor });
   expect(second.items).toMatchObject([{ id: 'b', bodyPrefix: body, bodyPrefixTruncated: false }]);
   expect(second.nextCursor).toEqual({ at: 10, id: 'b' });
   const last = await store.listPage({ ...input, before: second.nextCursor });
   expect(last.items).toMatchObject([{ id: 'a', bodyPrefix: body, bodyPrefixTruncated: false }]);
   expect(last.nextCursor).toBeUndefined();
   expect(acceptedBytes).toHaveLength(3);
   expect(Math.max(...acceptedBytes)).toBeLessThanOrEqual(limits.maximumResultBytes);

   const onlyOversizedLog = await store.listPage({ ...input, serviceName: 'x'.repeat(5000) });
   expect(onlyOversizedLog.items).toMatchObject([{ id: 'c', bodyPrefixTruncated: true }]);
   expect(onlyOversizedLog.nextCursor).toBeUndefined();

   const exactLastPage = await store.listPage({ ...input, before: second.nextCursor, limit: 1 });
   expect(exactLastPage.items.map(({ id }) => id)).toEqual(['a']);
   expect(exactLastPage.nextCursor).toBeUndefined();
  } finally { f.close(); }
 });
 it('adds browser provenance without relabeling or discarding retained pre-provenance exceptions', async () => {
  const f = fixture();
  try {
   for (const migration of captureMigrations.filter(migration => migration.version <= 6)) await migration.up(f.db);
   await f.db.execute('INSERT INTO captureExceptions(id,worktree,at,fingerprint,origin,message) VALUES(?,?,?,?,?,?)',
    ['retained', 'chosen', 1, 'retained-fp', 'log', 'app.browser.errors in browser stack text']);
   await f.db.execute('INSERT INTO captureDetails(id,worktree,at,body) VALUES(?,?,?,?)', ['retained', 'chosen', 1, '{"retained":true}']);
   for (const migration of captureMigrations.filter(migration => migration.version > 6)) await migration.up(f.db);
   const store = createCaptureStore(f.db, () => {});
   const [retained] = await store.exceptionGroups({ worktree: 'chosen', limit: 10 });
   expect(retained).toMatchObject({ fingerprint: 'retained-fp', count: 1 });
   expect(retained).not.toMatchObject({ applicationOrigin: 'browser' });
   expect(await store.detail('chosen', 'retained', { fingerprint: retained!.fingerprint })).toEqual({ retained: true });
   // Reach the genuine SQLite column after the append-only migration.
   expect(await f.db.query('SELECT applicationOrigin FROM captureExceptions WHERE id = ?', ['retained']))
    .toEqual([{ applicationOrigin: null }]);
  } finally { f.close(); }
 });

 it('clears the previous query capture shape and linked transactions while preserving other capture data', async () => {
  const f = fixture();
  try {
   for (const migration of captureMigrations.filter(migration => migration.version <= 7)) await migration.up(f.db);
   const store = createCaptureStore(f.db, () => {});
   // Seed the historical columns directly: the current writer expects the latest schema.
   await f.db.execute(`INSERT INTO captureSummaries(id,worktree,kind,source,at,shape,transactionId) VALUES
    ('query','chosen','query','wire',1,'select ?','tx'), ('tx','chosen','transaction','wire',1,NULL,NULL),
    ('query','other','log','otlp',1,NULL,NULL)`);
   for (const [id, worktree, detail] of [
    ['query', 'chosen', { parameters: ['previous format'] }],
    ['tx', 'chosen', { executionIds: ['query'] }],
    ['expired-first', 'chosen', { span: { database: { maskedParameters: ['previous format'] } } }],
    ['query', 'other', { log: { body: 'unrelated log' } }],
   ] as const) {
    await f.db.execute('INSERT INTO captureDetails(id,worktree,at,body) VALUES(?,?,1,?)', [id, worktree, JSON.stringify(detail)]);
   }
   await writeCaptureWorktree(f.db, 'chosen', '/chosen');
   await writeCaptureWorktree(f.db, 'other', '/other');
   // Retention can expire the summary before its separately retained detail.
   await f.db.execute('CREATE TABLE unrelated (value TEXT)');
   await f.db.execute('INSERT INTO unrelated VALUES (?)', ['retained']);
   for (const migration of captureMigrations.filter(migration => migration.version > 7)) {
    await f.db.transaction(migration.up);
   }
   expect(await store.list({ worktree: 'chosen', limit: 10 })).toEqual([]);
   expect(await store.detail('chosen', 'query')).toBeNull();
   expect(await store.detail('chosen', 'tx')).toBeNull();
   expect(await store.detail('chosen', 'expired-first')).toBeNull();
   expect(await store.detail('other', 'query')).toEqual({ log: { body: 'unrelated log' } });
   expect(await store.worktreePartitions('/other')).toEqual(['other']);
   expect(await f.db.query('SELECT value FROM unrelated')).toEqual([{ value: 'retained' }]);

   await store.write([{ id: 'current', worktree: 'chosen', kind: 'query', source: 'wire', at: 2,
    physicalRootIdentity: '/chosen', shape: 'select ?', detail: { parameters: ['[redacted]'] } }]);
   expect(await store.list({ worktree: 'chosen', kind: 'query', limit: 10 })).toEqual([expect.objectContaining({ id: 'current' })]);
   expect(await store.detail('chosen', 'current')).toEqual({ parameters: ['[redacted]'] });
  } finally { f.close(); }
 });

 it('keeps demanded details out of selected summary reads and clears only the selected worktree', async () => {
  const f = fixture();
  try {
   for (const migration of captureMigrations) await migration.up(f.db);
   const changes: string[][] = [];
   const store = createCaptureStore(f.db, keys => changes.push([...keys]));
   await store.write([{ id: 'a', worktree: 'chosen', kind: 'query', source: 'wire', at: 10, shape: 'select ?', detail: { parameters: ['[masked]'], error: '[masked]' } },
    { id: 'b', worktree: 'other', kind: 'query', source: 'wire', at: 11, shape: 'select ?' }]);
   f.statements.length = 0;
   expect(await store.list({ worktree: 'chosen', kind: 'query', limit: 20 })).toEqual([expect.objectContaining({ id: 'a', shape: 'select ?' })]);
   expect(f.statements.some(sql => sql.includes('captureDetails'))).toBe(false);
   expect(await store.detail('chosen', 'a')).toEqual({ parameters: ['[masked]'], error: '[masked]' });
   expect(await store.detail('other', 'a')).toBeNull();
   await store.clear('chosen');
   expect(await store.detail('chosen', 'a')).toBeNull();
   expect(await store.list({ worktree: 'other', limit: 20 })).toHaveLength(1);
   expect(changes).toEqual([['chosen', 'other'], ['chosen']]);
  } finally { f.close(); }
 });
 it('publishes no change for the same event and exposes detail truncation within host input bounds', async () => {
  const f = fixture();
  try {
   for (const migration of captureMigrations) await migration.up(f.db);
   let publications = 0;
   const store = createCaptureStore(f.db, () => publications++);
   const row = { id: 'span', worktree: 'chosen', kind: 'span' as const, source: 'otlp' as const, at: 1,
    detail: { body: '😀'.repeat(20000) } };
   await store.write([row]); await store.write([row]);
   expect(publications).toBe(1);
   expect(await store.detail('chosen', 'span')).toMatchObject({ truncated: true });
  } finally { f.close(); }
 });
 it('projects request metadata and scoped endpoint summaries without reading demanded details', async () => {
  const f = fixture();
  try {
   for (const migration of captureMigrations) await migration.up(f.db);
   const store = createCaptureStore(f.db, () => {});
   await store.write([
    { id: 'root', worktree: 'chosen', kind: 'span', source: 'otlp', at: 10, traceId: 't', spanId: 'root', spanKind: 2, serviceName: 'api', endpointMethod: 'GET', endpointRoute: '/users/:id', durationMs: 20, outcome: 'error', httpStatusCode: 500, detail: { body: 'secret detail' } },
    { id: 'db', worktree: 'chosen', kind: 'query', source: 'otlp', at: 11, traceId: 't', spanId: 'db', parentSpanId: 'root', shape: 'select ?', statementKind: 'select', durationMs: 5 },
    { id: 'other', worktree: 'other', kind: 'span', source: 'otlp', at: 12, traceId: 't', spanId: 'root', spanKind: 2, endpointMethod: 'GET', endpointRoute: '/users/:id', durationMs: 900 },
   ]);
   f.statements.length = 0;
   expect(await store.list({ worktree: 'chosen', spanKind: 2, traceId: 't', limit: 1 })).toEqual([expect.objectContaining({ id: 'root', endpointRoute: '/users/:id', httpStatusCode: 500 })]);
   expect(f.statements.some(sql => sql.includes('captureDetails'))).toBe(false);
  } finally { f.close(); }
 });

 it('filters log service and exact severity before paging with only bounded body projections', async () => {
  const f = fixture();
  try {
   for (const migration of captureMigrations) await migration.up(f.db);
   const store = createCaptureStore(f.db, () => {});
   await store.write([
    { id: 'match-older', worktree: 'chosen', kind: 'log', source: 'otlp', at: 10, serviceName: 'api', severityNumber: 13, detail: { body: 'demanded only' } },
    { id: 'match-newer', worktree: 'chosen', kind: 'log', source: 'otlp', at: 20, serviceName: 'api', severityNumber: 13 },
    { id: 'zero', worktree: 'chosen', kind: 'log', source: 'otlp', at: 30, serviceName: 'api', severityNumber: 0 },
    ...Array.from({ length: 1000 }, (_, index) => ({ id: `other-${index}`, worktree: 'chosen', kind: 'log' as const, source: 'otlp' as const, at: 100 + index, serviceName: index % 2 ? 'worker' : 'api', severityNumber: index % 2 ? 13 : 17 })),
    { id: 'other-worktree', worktree: 'other', kind: 'log', source: 'otlp', at: 5000, serviceName: 'api', severityNumber: 13 },
   ]);
   f.statements.length = 0; f.queryRows.length = 0;
   const first = await store.list({ worktree: 'chosen', kind: 'log', serviceName: 'api', severityNumber: 13, limit: 1 });
   expect(first).toEqual([expect.objectContaining({ id: 'match-newer', serviceName: 'api', severityNumber: 13 })]);
   expect(f.statements).toHaveLength(1);
   expect(f.queryRows).toEqual([1]);
   // J2 #3: the list now projects log prefixes in this same selected read.
   expect(await store.list({ worktree: 'chosen', kind: 'log', serviceName: 'api', severityNumber: 13, limit: 1, before: { at: 20, id: 'match-newer' } })).toEqual([expect.objectContaining({ id: 'match-older' })]);
   expect(await store.list({ worktree: 'chosen', kind: 'log', serviceName: 'api', severityNumber: 0, limit: 1 })).toEqual([expect.objectContaining({ id: 'zero', severityNumber: 0 })]);
  } finally { f.close(); }
 });

 it('migrates existing capture history to nullable severity metadata', async () => {
  const f = fixture();
  try {
   const first = captureMigrations[0];
   if (!first) throw new Error('Missing initial capture migration');
   await first.up(f.db);
   await f.db.execute("INSERT INTO captureSummaries(id,worktree,kind,source,at,serviceName) VALUES(?,?,?,?,?,?)", ['retained', 'chosen', 'log', 'otlp', 1, 'api']);
   for (const migration of captureMigrations.slice(1)) await migration.up(f.db);
   const store = createCaptureStore(f.db, () => {});
   expect(await store.list({ worktree: 'chosen', kind: 'log', limit: 1 })).toEqual([expect.objectContaining({ id: 'retained', serviceName: 'api', severityNumber: null })]);
   await store.write([{ id: 'new', worktree: 'chosen', kind: 'log', source: 'otlp', at: 2, severityNumber: 9 }]);
   expect(await store.list({ worktree: 'chosen', kind: 'log', severityNumber: 9, limit: 1 })).toEqual([expect.objectContaining({ id: 'new', severityNumber: 9 })]);
  } finally { f.close(); }
 });

});
