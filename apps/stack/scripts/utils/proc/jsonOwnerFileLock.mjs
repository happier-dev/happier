import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createFileChangeObserver, DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../../packages/cli-common/fileChangeObserver.mjs';

import { isPidAlive, observePidLiveness } from './pids.mjs';

export const JSON_OWNER_FILE_LOCK_BUSY_ERROR_CODE = 'EJSONOWNERFILELOCKBUSY';

export function parseJsonOwnerLockRaw(raw) {
  try {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readJsonOwnerLockRaw(lockPath) {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
}

export function readJsonOwnerLockSnapshot(lockPath) {
  const raw = readJsonOwnerLockRaw(lockPath);
  if (raw == null) return { exists: false, raw: null, owner: null };
  return { exists: true, raw, owner: parseJsonOwnerLockRaw(raw) };
}

function serializeJsonOwnerLock({ createdAtMs, updatedAtMs }) {
  return JSON.stringify({
    pid: process.pid,
    createdAtMs,
    updatedAtMs,
  });
}

// Publish complete holder records. Linking a completed
// sibling file retains exclusive-create semantics without exposing an empty
// live path; heartbeats replace the record with an atomic rename.
function publishOwnerRecord(path, raw, { create = false, expectedRaw } = {}) {
  const pendingPath = `${path}.pending-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(pendingPath, raw, { encoding: 'utf8', flag: 'wx' });
    if (expectedRaw !== undefined && readJsonOwnerLockRaw(path) !== expectedRaw) return false;
    if (create) linkSync(pendingPath, path);
    else renameSync(pendingPath, path);
    return true;
  } finally {
    try { unlinkSync(pendingPath); } catch {}
  }
}

function readJsonOwnerLockOwnerAges(owner, nowMs) {
  const createdAtMs = Number(owner.createdAtMs ?? owner.updatedAtMs ?? nowMs);
  const updatedAtMs = Number(owner.updatedAtMs ?? owner.createdAtMs ?? nowMs);
  const heldMs = Math.max(0, nowMs - createdAtMs);
  const heartbeatAgeMs = Math.max(0, nowMs - updatedAtMs);
  return { heldMs, heartbeatAgeMs };
}

export function describeJsonOwnerLockOwner(owner, nowMs = Date.now()) {
  if (!owner) return 'owner=unknown';
  const { heldMs, heartbeatAgeMs } = readJsonOwnerLockOwnerAges(owner, nowMs);
  return `pid=${String(owner.pid ?? 'unknown')} heldMs=${heldMs} heartbeatAgeMs=${heartbeatAgeMs}`;
}

export function describeJsonOwnerLock(lockPath, nowMs) {
  return describeJsonOwnerLockOwner(readJsonOwnerLockSnapshot(lockPath).owner, nowMs);
}

function inspectJsonOwnerLockSnapshot(snapshot, staleAfterMs, nowMs, fallbackMtimeMs = 0, options = {}) {
  const state = { snapshot, observedAtMs: nowMs, liveOwners: [], kind: 'writer', reclaimable: true };
  if (!snapshot.exists) return state;
  const owner = snapshot.owner;
  // Shared-reader ownership is retired. Already-loaded callers may leave its
  // record behind, but it must never exclude current exclusive work.
  if (owner?.priority === 'reader') return state;
  const ownerPid = Number(owner?.pid);
  if (Number.isFinite(ownerPid) && ownerPid > 1) {
    if (!isPidAlive(ownerPid)) return state;
    state.liveOwners = [owner];
    if (options.allowLiveOwnerStaleReclaim !== true) {
      state.reclaimable = false;
      return state;
    }
    const updatedAtMs = Number(owner?.updatedAtMs ?? owner?.createdAtMs ?? fallbackMtimeMs);
    state.reclaimable = updatedAtMs > 0 && nowMs - updatedAtMs > staleAfterMs;
    return state;
  }
  const updatedAtMs = Number(owner?.updatedAtMs ?? owner?.createdAtMs ?? fallbackMtimeMs);
  state.reclaimable = updatedAtMs > 0 && nowMs - updatedAtMs > staleAfterMs;
  return state;
}

export function shouldReclaimJsonOwnerLockSnapshot(snapshot, staleAfterMs, nowMs, fallbackMtimeMs = 0, options = {}) {
  return inspectJsonOwnerLockSnapshot(snapshot, staleAfterMs, nowMs, fallbackMtimeMs, options).reclaimable;
}

function shouldReclaimJsonOwnerLock(lockPath, staleAfterMs, nowMs, options = {}) {
  let stats;
  try {
    stats = statSync(lockPath);
  } catch {
    return false;
  }
  return shouldReclaimJsonOwnerLockSnapshot(readJsonOwnerLockSnapshot(lockPath), staleAfterMs, nowMs, stats.mtimeMs, options);
}

function reclaimJsonOwnerLockSnapshot(lockPath, expectedRaw) {
  if (expectedRaw == null) return true;
  const reclaimPath = `${lockPath}.reclaim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    renameSync(lockPath, reclaimPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }

  let movedRaw = null;
  try {
    movedRaw = readFileSync(reclaimPath, 'utf8');
  } catch {
    return false;
  }

  if (movedRaw === expectedRaw) {
    try {
      unlinkSync(reclaimPath);
    } catch {}
    return true;
  }

  try {
    publishOwnerRecord(lockPath, movedRaw, { create: true });
    unlinkSync(reclaimPath);
  } catch {
    // Another owner already has the lock path. Keep the quarantined file for diagnostics.
  }
  return false;
}

export function isJsonOwnerFileLockActive(lockPath, options = {}) {
  const staleAfterMs = options.staleAfterMs ?? 240_000;
  const nowMs = options.nowMs ?? Date.now();
  try {
    statSync(lockPath);
  } catch {
    return false;
  }
  return !shouldReclaimJsonOwnerLock(lockPath, staleAfterMs, nowMs, options);
}

// Only current exclusive tickets participate. Former shared-reader queue files
// are deliberately ignored. Tickets are immutable, complete owner records;
// unique filenames make departure cleanup safe against replacement races.
function readExclusiveWaiters(waitersPath) {
  const waiters = [];
  for (const name of readdirSync(waitersPath)) {
    const match = /^exclusive-(\d+)-[a-f0-9-]+\.json$/.exec(name);
    if (!match) continue;
    const path = join(waitersPath, name);
    const snapshot = readJsonOwnerLockSnapshot(path);
    if (!snapshot.exists) continue;
    const pid = Number(snapshot.owner?.pid);
    if (Number.isFinite(pid) && pid > 1 && observePidLiveness(pid).status === 'dead') {
      try { unlinkSync(path); } catch {}
      continue;
    }
    waiters.push({ name, sequence: BigInt(match[1]) });
  }
  return waiters.sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1
    : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export async function withJsonOwnerFileLock(fn, options = {}) {
  const lockPath = options.lockPath;
  if (!lockPath) throw new Error('withJsonOwnerFileLock requires options.lockPath');
  mkdirSync(dirname(lockPath), { recursive: true });

  const timeoutMs = options.timeoutMs ?? 240_000;
  const configuredCatchUpMs = Number(options.watchFallbackMs);
  const catchUpMs = Number.isFinite(configuredCatchUpMs) && configuredCatchUpMs > 0
    ? configuredCatchUpMs : DEFAULT_FILE_CHANGE_CATCH_UP_MS;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;
  const startedAt = Date.now();
  const errorLabel = options.errorLabel ?? 'JSON owner file lock';
  const heartbeatIntervalMs = Math.max(500, Math.min(5_000, Math.floor(staleAfterMs / 4)));
  let ownLockRaw = null;
  let acquiredAtMs = null;
  let heartbeat = null;
  let acquired = false;
  let waited = false;
  const waitersPath = `${lockPath}.waiters`;
  mkdirSync(waitersPath, { recursive: true });
  let ownTicketPath = null;
  let waiters = [];
  let observedOwnerIdentity = null;
  const readOwnerIdentity = () => {
    const snapshot = readJsonOwnerLockSnapshot(lockPath);
    const { updatedAtMs, ...identity } = snapshot.owner ?? {};
    return JSON.stringify(snapshot.owner ? identity : snapshot.raw);
  };
  const observer = createFileChangeObserver([dirname(lockPath), waitersPath], {
    isRelevant(directory, filename) {
      return filename == null || (directory === waitersPath
        ? /^exclusive-\d+-[a-f0-9-]+\.json$/.test(String(filename))
        : String(filename) === basename(lockPath) && readOwnerIdentity() !== observedOwnerIdentity);
    },
  });
  // Heartbeats report liveness, not a change of exclusion. Native events wake
  // release/replacement promptly; catch-up also detects a departed PID.
  const readWaitSnapshot = () => {
    observedOwnerIdentity = readOwnerIdentity();
    waiters = readExclusiveWaiters(waitersPath);
    return JSON.stringify([observedOwnerIdentity, waiters.map(waiter => waiter.name)]);
  };
  try {
    options.signal?.throwIfAborted();
    if (options.shouldAcquire && !await options.shouldAcquire()) {
      options.signal?.throwIfAborted();
      return;
    }
    const existing = readExclusiveWaiters(waitersPath);
    const sequence = (existing.at(-1)?.sequence ?? 0n) + 1n;
    ownTicketPath = join(waitersPath, `exclusive-${sequence}-${randomUUID()}.json`);
    publishOwnerRecord(ownTicketPath, serializeJsonOwnerLock({ createdAtMs: startedAt, updatedAtMs: startedAt }), { create: true });
    while (true) {
      options.signal?.throwIfAborted();
      const waitSnapshot = observer.capture(readWaitSnapshot);
      // A queued mutation may have been satisfied by the preceding publisher.
      // Let every waiter depart without taking an otherwise empty FIFO turn.
      if (options.shouldAcquire && !await options.shouldAcquire()) {
        options.signal?.throwIfAborted();
        return;
      }
      const atHead = waiters[0]?.name === basename(ownTicketPath);
      if (atHead) {
        acquiredAtMs = Date.now();
        ownLockRaw = serializeJsonOwnerLock({ createdAtMs: acquiredAtMs, updatedAtMs: acquiredAtMs });
        try {
          publishOwnerRecord(lockPath, ownLockRaw, { create: true });
          acquired = true;
          // A holder is no longer queued. Its ordinary owner record/heartbeat
          // remains the sole exclusion authority, including stale-reclaim policy.
          unlinkSync(ownTicketPath);
          ownTicketPath = null;
          break;
        } catch (error) {
          if (acquired) throw error;
          ownLockRaw = null;
          if (error?.code !== 'EEXIST') throw error;
        }
      }
      const snapshot = readJsonOwnerLockSnapshot(lockPath);
      let mtimeMs = 0;
      try { mtimeMs = statSync(lockPath).mtimeMs; } catch {}
      const observedAtMs = Date.now();
      const lockState = inspectJsonOwnerLockSnapshot(snapshot, staleAfterMs, observedAtMs, mtimeMs, options);
      if (atHead && lockState.reclaimable) {
        reclaimJsonOwnerLockSnapshot(lockPath, snapshot.raw);
        continue;
      }
      if (options.wait === false) {
        const error = new Error(`${errorLabel} is busy: ${lockPath} (${describeJsonOwnerLock(lockPath)})`);
        error.code = JSON_OWNER_FILE_LOCK_BUSY_ERROR_CODE;
        throw error;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for ${errorLabel}: ${lockPath} (${describeJsonOwnerLock(lockPath, Date.now())})`);
      }
      waited = true;
      if (typeof options.onWait === 'function') {
        try {
          options.onWait({
            lockPath,
            owner: lockState.liveOwners[0] ?? null,
            holders: lockState.liveOwners.map(owner => ({
              ...owner, kind: 'writer', ...readJsonOwnerLockOwnerAges(owner, observedAtMs),
            })),
            observedAtMs, staleAfterMs, timeoutMs, waitedMs: Date.now() - startedAt,
          });
        } catch {}
      }
      await observer.wait({ snapshot: waitSnapshot, readSnapshot: readWaitSnapshot,
        maxWaitMs: Math.min(catchUpMs, Math.max(1, timeoutMs - (Date.now() - startedAt)), Math.max(1, staleAfterMs)),
        signal: options.signal });
    }
    observer.close();
    options.signal?.throwIfAborted();
    heartbeat = setInterval(() => {
      try {
        if (readJsonOwnerLockRaw(lockPath) !== ownLockRaw) return;
        const nextRaw = serializeJsonOwnerLock({ createdAtMs: acquiredAtMs, updatedAtMs: Date.now() });
        if (publishOwnerRecord(lockPath, nextRaw, { expectedRaw: ownLockRaw })) ownLockRaw = nextRaw;
      } catch {}
    }, heartbeatIntervalMs);
    return await fn({ waited, lockPath, owner: readJsonOwnerLockSnapshot(lockPath).owner });
  } finally {
    observer.close();
    if (heartbeat) clearInterval(heartbeat);
    if (ownTicketPath) {
      try { unlinkSync(ownTicketPath); } catch {}
    }
    if (acquired) {
      try {
        if (readJsonOwnerLockRaw(lockPath) === ownLockRaw) unlinkSync(lockPath);
      } catch {}
    }
  }
}
