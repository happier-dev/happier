import { describe, expect, it } from 'vitest';
import { createCaptureIngest, type CaptureCoverage } from './ingest.js';
import { captureMigrations, createCaptureStore } from './capture.js';
import { createCaptureSqliteFixture } from '../testing/sqlite.js';

async function fixture() {
 const f = createCaptureSqliteFixture();
 for (const migration of captureMigrations) await migration.up(f.db);
 return { ...f, store: createCaptureStore(f.db, () => {}) };
}

describe('capture single in-flight writer', () => {
 it('drops observations while the SQLite boundary is held, then resumes without replay', async () => {
  const f = await fixture(), held = f.holdNextCommit();
  const writer = createCaptureIngest(f.store.write);
  try {
  const row = { id: 'first', worktree: 'selected', kind: 'query' as const, source: 'wire' as const, at: 1 };
  expect(writer.offer([row])).toBe(true);
  await held.entered;
  expect(writer.offer([{ ...row, id: 'dropped' }])).toBe(false);
  expect(writer.coverage()).toMatchObject({ lostObservations: 1, reason: 'store_busy' });
  held.release(); await writer.settled();
  expect(writer.offer([{ ...row, id: 'later' }])).toBe(true);
  await writer.settled();
  expect((await f.store.list({ worktree: 'selected', kind: 'query', limit: 10 })).map(row => row.id).sort()).toEqual(['first', 'later']);
  } finally { held.release(); await writer.settled(); f.close(); }
 });
 it('attributes a dropped mixed batch only to its partitions and publishes their keys once', async () => {
  const f = await fixture(), held = f.holdNextCommit();
  const changes: { coverage: CaptureCoverage; partitions: readonly string[] }[] = [];
  const writer = createCaptureIngest(f.store.write, (coverage, partitions) => { changes.push({ coverage, partitions }); });
  try {
  const row = { id: 'first', worktree: 'admitted', kind: 'query' as const, source: 'wire' as const, at: 1 };
  writer.offer([row]);
  await held.entered;
  expect(writer.offer([{ ...row, worktree: 'a' }, { ...row, id: 'second', worktree: 'b' }, { ...row, id: 'third', worktree: 'a' }])).toBe(false);
  expect(writer.coverage('admitted')).toEqual({ lostObservations: 0, reason: null });
  expect(writer.coverage('a')).toEqual({ lostObservations: 2, reason: 'store_busy' });
  expect(writer.coverage('b')).toEqual({ lostObservations: 1, reason: 'store_busy' });
  expect(changes).toEqual([{ coverage: { lostObservations: 3, reason: 'store_busy' }, partitions: ['a', 'b'] }]);
  } finally { held.release(); await writer.settled(); f.close(); }
 });
 it('records source loss per partition and retains immutable snapshots through retry', async () => {
  const f = await fixture();
  const published: string[][] = [];
  const writer = createCaptureIngest(f.store.write, (_coverage, partitions) => { published.push([...partitions]); });
  try {
  writer.recordLoss('a', 'unsupported_statement', 2);
  const beforeRetry = writer.coverage('a');
  writer.recordLoss('b', 'unknown_message');
  expect(writer.coverage()).toEqual({ lostObservations: 3, reason: 'unknown_message' });
  writer.retry();
  expect(beforeRetry).toEqual({ lostObservations: 2, reason: 'unsupported_statement' });
  expect(writer.coverage('a')).toEqual({ lostObservations: 2, reason: 'incomplete_interval' });
  expect(writer.coverage('b')).toEqual({ lostObservations: 1, reason: 'incomplete_interval' });
  expect(writer.coverage('untouched')).toEqual({ lostObservations: 0, reason: null });
  expect(published).toEqual([['a'], ['b'], ['a', 'b']]);
  } finally { f.close(); }
 });
 it('settles quota exhaustion as visible loss and resumes only on explicit retry', async () => {
  const f = await fixture();
  const changes: (readonly string[])[] = [];
  const writer = createCaptureIngest(f.store.write, (_coverage, partitions) => { changes.push(partitions); });
  try {
  f.failWrites('daemon_database_quota_exceeded');
  const row = { id: 'first', worktree: 'selected', kind: 'query' as const, source: 'wire' as const, at: 1 };
  writer.offer([row, { ...row, worktree: 'other' }]); await writer.settled();
  expect(writer.coverage()).toMatchObject({ lostObservations: 2, reason: 'daemon_database_quota_exceeded' });
  expect(writer.coverage('selected')).toEqual({ lostObservations: 1, reason: 'daemon_database_quota_exceeded' });
  expect(writer.coverage('other')).toEqual({ lostObservations: 1, reason: 'daemon_database_quota_exceeded' });
  f.failWrites(null);
  expect(writer.offer([{ ...row, worktree: 'third' }])).toBe(false);
  expect(writer.coverage('third')).toEqual({ lostObservations: 1, reason: 'daemon_database_quota_exceeded' });
  writer.retry(); expect(writer.offer([row])).toBe(true); await writer.settled();
  expect(writer.coverage('selected')).toEqual({ lostObservations: 1, reason: 'incomplete_interval' });
  expect(writer.coverage()).toEqual({ lostObservations: 3, reason: 'incomplete_interval' });
  expect(changes).toEqual([['selected', 'other'], ['third'], ['selected', 'other', 'third']]);
  expect((await f.store.list({ worktree: 'selected', kind: 'query', limit: 10 })).map(row => row.id)).toEqual(['first']);
  } finally { await writer.settled(); f.close(); }
 });
 it('persists loss snapshots on the next successful batch without forgetting newer loss during its commit', async () => {
  const f = createCaptureSqliteFixture();
  try {
   for (const migration of captureMigrations) await migration.up(f.db);
   const store = createCaptureStore(f.db, () => {});
   const writer = createCaptureIngest(store.write);
   const row = { id: 'first', worktree: 'admitted', kind: 'query' as const, source: 'wire' as const, at: 1 };
   const first = f.holdNextCommit();
   writer.offer([row]); await first.entered;
   writer.offer([{ ...row, worktree: 'a' }, { ...row, worktree: 'b' }]);
   first.release(); await writer.settled();
   expect(await store.detail('a', 'coverage')).toBeNull();
   const second = f.holdNextCommit();
   writer.offer([{ ...row, id: 'second' }]); await second.entered;
   writer.recordLoss('a', 'unknown_message');
   second.release(); await writer.settled();
   expect(await store.detail('a', 'coverage')).toEqual({ lostObservations: 1, reason: 'store_busy' });
   expect(await store.detail('b', 'coverage')).toEqual({ lostObservations: 1, reason: 'store_busy' });
   writer.retry();
   writer.offer([{ ...row, id: 'third' }]); await writer.settled();
   expect(await store.detail('a', 'coverage')).toEqual({ lostObservations: 2, reason: 'incomplete_interval' });
   expect(await store.list({ worktree: 'a', kind: 'coverage', limit: 10 })).toEqual([expect.objectContaining({ id: 'coverage', source: 'capture' })]);
   expect(await store.detail('admitted', 'coverage')).toBeNull();
  } finally { f.close(); }
 });
 it('acknowledges only cleared loss and keeps new loss arriving during the SQLite clear', async () => {
  const f = createCaptureSqliteFixture();
  try {
   for (const migration of captureMigrations) await migration.up(f.db);
   const store = createCaptureStore(f.db, () => {}), writer = createCaptureIngest(store.write);
   const row = { id: 'first', worktree: 'admitted', kind: 'query' as const, source: 'wire' as const, at: 1 };
   writer.recordLoss('a', 'unknown_message');
   await writer.exclusive(async () => { const previous = writer.coverage('a').lostObservations; await store.clear('a'); writer.clearCoverage('a', previous); });
   writer.offer([row]); await writer.settled();
   expect(await store.detail('a', 'coverage')).toBeNull();
   expect(writer.coverage('a')).toEqual({ lostObservations: 0, reason: null });
   writer.recordLoss('a', 'unknown_message', 2); writer.recordLoss('b', 'unknown_message');
   writer.offer([{ ...row, id: 'second' }]); await writer.settled();
   const held = f.holdNextCommit();
   const clearing = writer.exclusive(async () => { const previous = writer.coverage('a').lostObservations; await store.clear('a'); writer.clearCoverage('a', previous); });
   await held.entered;
   expect(writer.offer([{ ...row, worktree: 'a' }])).toBe(false);
   held.release(); await clearing; await writer.settled();
   expect(writer.coverage('a')).toEqual({ lostObservations: 1, reason: 'store_busy' });
   expect(writer.coverage()).toEqual({ lostObservations: 2, reason: 'store_busy' });
   writer.offer([{ ...row, id: 'third' }]); await writer.settled();
   expect(await store.detail('a', 'coverage')).toEqual({ lostObservations: 1, reason: 'store_busy' });
   expect(await store.detail('b', 'coverage')).toEqual({ lostObservations: 1, reason: 'unknown_message' });
  } finally { f.close(); }
 });
 it('keeps the native write failure until Retry even after its lost coverage is cleared', async () => {
  const f = await fixture(), writer = createCaptureIngest(f.store.write);
  try {
  f.failWrites('daemon_database_quota_exceeded');
  const row = { id: 'first', worktree: 'selected', kind: 'query' as const, source: 'wire' as const, at: 1 };
  writer.offer([row]); await writer.settled();
  writer.clearCoverage('selected', 1);
  expect(writer.coverage()).toEqual({ lostObservations: 0, reason: null });
  expect(writer.offer([row])).toBe(false);
  expect(writer.coverage('selected')).toEqual({ lostObservations: 1, reason: 'daemon_database_quota_exceeded' });
  } finally { await writer.settled(); f.close(); }
 });
});
