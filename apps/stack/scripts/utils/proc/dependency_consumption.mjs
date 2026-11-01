import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createFileChangeObserver, DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../../packages/cli-common/fileChangeObserver.mjs';
import { observePidLiveness } from './pids.mjs';
import { readJsonOwnerLockSnapshot, isJsonOwnerFileLockActive, JSON_OWNER_FILE_LOCK_BUSY_ERROR_CODE } from './jsonOwnerFileLock.mjs';
import { createWorkspaceBuildWaitNotifier } from './workspaceBuildWaitNotifier.mjs';

const readers = new AsyncLocalStorage();
const custodyVariable = 'HAPPIER_BUILD_DEPENDENCY_CUSTODY';
export const DEPENDENCY_LOCK_STALE_AFTER_MS = 240_000;

export function inheritedDependencyWriter(lockPath, env) {
  let inherited;
  try { inherited = JSON.parse(env[custodyVariable] ?? 'null'); } catch { return null; }
  if (inherited?.kind !== 'writer' || inherited.lockPath !== lockPath) return null;
  const owner = readJsonOwnerLockSnapshot(lockPath).owner;
  return owner?.pid === inherited.pid && owner.createdAtMs === inherited.createdAtMs
    && isJsonOwnerFileLockActive(lockPath) ? { lockPath, owner } : null;
}

export function dependencyWriterEnv(lockPath, owner, env) {
  return { ...env, [custodyVariable]: JSON.stringify({ kind: 'writer', lockPath,
    pid: owner.pid, createdAtMs: owner.createdAtMs }) };
}

function inheritedReader(lockPath, env) {
  const local = readers.getStore()?.get(lockPath);
  if (local?.active) return local;
  let inherited;
  try { inherited = JSON.parse(env[custodyVariable] ?? 'null'); } catch { return null; }
  if (inherited?.lockPath !== lockPath || !/^reader-\d+-[a-f0-9-]+\.json$/.test(inherited.name ?? '')) return null;
  let record;
  try { record = JSON.parse(readFileSync(join(`${lockPath}.readers`, inherited.name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return record.pid === inherited.pid && observePidLiveness(record.pid).status !== 'dead'
    ? { active: true, env } : null;
}

export function hasDependencyReadLock(lockPath, env) {
  return inheritedReader(lockPath, env) !== null;
}

// Publish before checking the writer gate. Either the writer sees this record
// and drains it, or the reader sees the writer and withdraws before importing.
// Readers never take an exclusive FIFO turn merely to register consumption.
// Publication admission runs once here; inherited readers/writers retain it.
export async function withDependencyReadLock({ lockPath, env, signal, wait = true, onAdmit }, consume) {
  if (inheritedDependencyWriter(lockPath, env)) return await consume(env);
  const inherited = inheritedReader(lockPath, env);
  if (inherited) return await consume({ ...env, [custodyVariable]: inherited.env[custodyVariable] });
  const directory = `${lockPath}.readers`;
  mkdirSync(directory, { recursive: true });
  const name = `reader-${process.pid}-${randomUUID()}.json`;
  const recordPath = join(directory, name);
  const observer = createFileChangeObserver([dirname(lockPath)]);
  const readGate = () => readJsonOwnerLockSnapshot(lockPath).raw;
  const notify = createWorkspaceBuildWaitNotifier({ env, label: 'dependency refresh', kind: 'lock' });
  const startedAt = Date.now();
  let reader;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const snapshot = observer.capture(readGate);
      writeFileSync(recordPath, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
      if (!isJsonOwnerFileLockActive(lockPath, { staleAfterMs: DEPENDENCY_LOCK_STALE_AFTER_MS })) break;
      unlinkSync(recordPath);
      const owner = readJsonOwnerLockSnapshot(lockPath).owner;
      if (!wait) throw Object.assign(new Error(`Dependency refresh is busy with writer pid=${owner?.pid ?? 'unknown'}`),
        { code: JSON_OWNER_FILE_LOCK_BUSY_ERROR_CODE });
      notify({ lockPath, owner, waitedMs: Date.now() - startedAt });
      await observer.wait({ snapshot, readSnapshot: readGate, maxWaitMs: DEFAULT_FILE_CHANGE_CATCH_UP_MS, signal });
    }
    observer.close();
    reader = { active: true, env: { ...env,
      [custodyVariable]: JSON.stringify({ lockPath, name, pid: process.pid }) } };
    signal?.throwIfAborted();
    return await readers.run(new Map([...(readers.getStore() ?? []), [lockPath, reader]]), async () => {
      await onAdmit?.();
      return await consume(reader.env);
    });
  } finally {
    observer.close();
    if (reader) reader.active = false;
    try { unlinkSync(recordPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// The writer already owns the gate: no new independent reader can enter.
// Filesystem departures wake this wait; the existing catch-up policy handles
// a process that died without unlinking its immutable record.
export async function waitForDependencyReaders({ lockPath, env, signal, wait = true }) {
  const directory = `${lockPath}.readers`;
  mkdirSync(directory, { recursive: true });
  const observer = createFileChangeObserver([directory]);
  const startedAt = Date.now();
  const notify = createWorkspaceBuildWaitNotifier({ env, label: 'dependency consumers', kind: 'lock' });
  const inspect = () => {
    const active = [];
    for (const name of readdirSync(directory)) {
      const match = /^reader-(\d+)-[a-f0-9-]+\.json$/.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (observePidLiveness(pid).status === 'dead') {
        try { unlinkSync(join(directory, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      } else active.push({ name, pid });
    }
    return active.sort((a, b) => a.name.localeCompare(b.name));
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      const snapshot = observer.capture(() => JSON.stringify(inspect()));
      const active = JSON.parse(snapshot);
      if (active.length === 0) return;
      if (!wait) throw Object.assign(new Error(`Dependency refresh is busy with consumer pid=${active[0].pid}`),
        { code: JSON_OWNER_FILE_LOCK_BUSY_ERROR_CODE });
      notify({ lockPath, owner: active[0], waitedMs: Date.now() - startedAt });
      await observer.wait({ snapshot, readSnapshot: () => JSON.stringify(inspect()),
        maxWaitMs: DEFAULT_FILE_CHANGE_CATCH_UP_MS, signal });
    }
  } finally { observer.close(); }
}
