import { describe, expect, it } from 'vitest';
import { captureMigrations, createCaptureStore } from './capture.js';
import { createCaptureSqliteFixture as fixture } from '../testing/sqlite.js';
describe('capture store through SQLite', () => {
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
   expect(await store.detail('chosen', 'retained')).toEqual({ retained: true });
   // Reach the genuine SQLite column after the append-only migration.
   expect(await f.db.query('SELECT applicationOrigin FROM captureExceptions WHERE id = ?', ['retained']))
    .toEqual([{ applicationOrigin: null }]);
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

 it('filters log service and exact severity before paging and never reads bodies', async () => {
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
   expect(f.statements.some(statement => statement.includes('captureDetails'))).toBe(false);
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
