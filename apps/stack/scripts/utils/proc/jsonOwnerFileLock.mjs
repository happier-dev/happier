import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createFileChangeObserver, DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../../packages/cli-common/fileChangeObserver.mjs';

import { isPidAlive } from './pids.mjs';

export const JSON_OWNER_FILE_LOCK_BUSY_ERROR_CODE = 'EJSONOWNERFILELOCKBUSY';
const activeWriterWaiters = new Set();

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

function serializeJsonOwnerLock({ createdAtMs, updatedAtMs, priority }) {
  return JSON.stringify({
    pid: process.pid,
    createdAtMs,
    updatedAtMs,
    ...(priority === 'writer' || priority === 'reader' ? { priority } : {}),
  });
}

// Publish complete records for holders and waiters alike. Linking a completed
// sibling file retains exclusive-create semantics without exposing an empty
// live path; replacement uses the same atomic rename as queue heartbeats.
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
  if (owner?.priority === 'reader' && Array.isArray(owner.readers)) {
    state.kind = 'reader';
    state.liveOwners = owner.readers.filter(reader => Number(reader.pid) > 1 && isPidAlive(Number(reader.pid)));
    state.reclaimable = state.liveOwners.length === 0;
    return state;
  }
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

export async function withJsonOwnerFileLock(fn, options = {}) {
  return await withJsonOwnerFileLockInternal(fn, options, true);
}

// The short registration lock uses the same owner/reclaim protocol, but must
// not recursively create a queue for itself. Only registration takes this lock;
// long-running holders and already registered waiters never contend on it.
async function withJsonOwnerFileLockInternal(fn, options, fair) {
  const lockPath = options.lockPath;
  if (!lockPath) {
    throw new Error('withJsonOwnerFileLock requires options.lockPath');
  }

  mkdirSync(dirname(lockPath), { recursive: true });

  const timeoutMs = options.timeoutMs ?? 240_000;
  // Match workspace notifications: legacy poll intervals do not keep healthy
  // owners on 125/250ms scans. The shared fallback catches death/missed events.
  const configuredCatchUpMs = Number(options.watchFallbackMs);
  const catchUpMs = Number.isFinite(configuredCatchUpMs) && configuredCatchUpMs > 0
    ? configuredCatchUpMs : DEFAULT_FILE_CHANGE_CATCH_UP_MS;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;
  const startedAt = Date.now();
  const errorLabel = options.errorLabel ?? 'JSON owner file lock';

  let exclusiveAcquired = false;
  let heartbeat = null;
  let ownLockRaw = null;
  let acquiredAtMs = null;
  let waited = false;
  const sharedReaders = fair && options.sharedReaders === true;
  const ownReader = { pid: process.pid, createdAtMs: startedAt, readerId: Math.random().toString(36).slice(2) };
  let sharedAcquired = false;
  const waitersDir = `${lockPath}.waiters`;
  let observedWaiterNames = new Set();
  let waitLockState;
  const observer = createFileChangeObserver([dirname(lockPath), waitersDir], {
    isRelevant(directory, filename) {
      if (filename == null) return true;
      const name = String(filename);
      if (directory === dirname(lockPath)) return name === basename(lockPath) || name === basename(waitersDir);
      // Existing tickets only heartbeat; their identity and queue position stay
      // fixed. Joins/removals affect eligibility. The usual catch-up still
      // observes death or an externally replaced ticket without a file event.
      return /^\d+\.json$/.test(name)
        && (!observedWaiterNames.has(name) || !existsSync(join(waitersDir, name)));
    },
  });
  let waiterPath = null;
  let ownWaiterRaw = null;
  let waiterCreatedAtMs = startedAt;
  let waiterHeartbeat = null;
  const heartbeatIntervalMs = Math.max(500, Math.min(5_000, Math.floor(staleAfterMs / 4)));

  const readWaiters = () => {
    let names;
    try { names = readdirSync(waitersDir); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    return names.filter(name => /^\d+\.json$/.test(name)).flatMap(name => {
      const path = join(waitersDir, name);
      const snapshot = readJsonOwnerLockSnapshot(path);
      let mtimeMs = 0;
      try { mtimeMs = statSync(path).mtimeMs; } catch {}
      if (!(path === waiterPath && snapshot.raw === ownWaiterRaw)
          && shouldReclaimJsonOwnerLockSnapshot(snapshot, staleAfterMs, Date.now(), mtimeMs, options)
          && reclaimJsonOwnerLockSnapshot(path, snapshot.raw)) return [];
      // Predecessor waiters were all exclusive. Only an explicit reader ticket
      // grants reader status; live untyped tickets still exclude new readers.
      return [{path, ticket:BigInt(name.slice(0, -5)), writer:snapshot.owner?.priority !== 'reader',
        owner:snapshot.owner}];
    }).sort((a, b) => a.writer !== b.writer ? a.writer ? -1 : 1 : a.ticket < b.ticket ? -1 : a.ticket > b.ticket ? 1 : 0);
  };

  // Creation and heartbeats both publish complete records: killing a waiter
  // during a heartbeat must not leave an ownerless head for an infinite wait.
  const publishWaiter = (raw, expectedRaw) => publishOwnerRecord(waiterPath, raw, { expectedRaw });

  const registerWaiter = (waiters, reuseOnly = false) => {
    // A re-entering writer keeps its original queue identity. Do not adopt a
    // ticket used by another active call in this process: those are separate
    // exclusive operations, not retries of the same pending operation.
    const previous = options.priority === 'writer' ? waiters.find(waiter => waiter.writer
      && waiter.owner?.pid === process.pid && Number.isFinite(waiter.owner?.createdAtMs)
      && !activeWriterWaiters.has(waiter.path)) : null;
    if (reuseOnly && !previous) return;
    mkdirSync(waitersDir, {recursive:true});
    const ticket = waiters.reduce((maximum, waiter) => waiter.ticket > maximum ? waiter.ticket : maximum, 0n) + 1n;
    waiterPath = previous?.path ?? join(waitersDir, `${ticket}.json`);
    waiterCreatedAtMs = previous?.owner.createdAtMs ?? startedAt;
    ownWaiterRaw = serializeJsonOwnerLock({createdAtMs:waiterCreatedAtMs, updatedAtMs:Date.now(), priority:options.priority});
    publishWaiter(ownWaiterRaw);
    if (options.priority === 'writer') activeWriterWaiters.add(waiterPath);
    waiterHeartbeat = setInterval(() => {
      try {
        if (readJsonOwnerLockRaw(waiterPath) !== ownWaiterRaw) return;
        const nextRaw = serializeJsonOwnerLock({createdAtMs:waiterCreatedAtMs, updatedAtMs:Date.now(), priority:options.priority});
        if (publishWaiter(nextRaw, ownWaiterRaw)) ownWaiterRaw = nextRaw;
      } catch {}
    }, heartbeatIntervalMs);
  };

  const acquire = () => {
    acquiredAtMs = Date.now();
    ownLockRaw = serializeJsonOwnerLock({createdAtMs:acquiredAtMs, updatedAtMs:acquiredAtMs, priority:options.priority});
    publishOwnerRecord(lockPath, ownLockRaw, { create: true });
    exclusiveAcquired = true;
  };

  const withQueueGate = fn => withJsonOwnerFileLockInternal(fn, {
    ...options, sharedReaders: false, lockPath: `${lockPath}.queue.lock`, onWait: undefined,
    timeoutMs: Math.max(0, timeoutMs - (Date.now() - startedAt)), staleAfterMs,
  }, false);
  const publishReaders = (readers, create = false) => {
    const raw = JSON.stringify({ ...readers[0], priority: 'reader', updatedAtMs: Date.now(), readers });
    publishOwnerRecord(lockPath, raw, { create });
  };
  const readLockState = () => {
    const snapshot = readJsonOwnerLockSnapshot(lockPath);
    let mtimeMs = 0;
    try { mtimeMs = statSync(lockPath).mtimeMs; } catch {}
    return inspectJsonOwnerLockSnapshot(snapshot, staleAfterMs, Date.now(), mtimeMs, options);
  };
  const trySharedAcquire = () => {
    let waiters = readWaiters();
    if (!waiterPath && options.priority === 'writer') registerWaiter(waiters, true);
    waitLockState = readLockState();
    if (waitLockState.snapshot.exists && waitLockState.reclaimable) {
      reclaimJsonOwnerLockSnapshot(lockPath, waitLockState.snapshot.raw);
      waitLockState = readLockState();
    }
    const snapshot = waitLockState.snapshot;
    const reader = options.priority === 'reader';
    const eligible = reader ? !waiters.some(waiter => waiter.writer)
      : waiterPath ? waiters[0]?.path === waiterPath : waiters.length === 0;
    if (eligible && reader && (!snapshot.exists || (snapshot.owner?.priority === 'reader' && Array.isArray(snapshot.owner.readers)))) {
      const readers = (snapshot.owner?.readers ?? []).filter(owner => isPidAlive(Number(owner.pid)));
      try { publishReaders([...readers, ownReader], !snapshot.exists); }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (!waiterPath && options.wait !== false) registerWaiter(waiters);
        return;
      }
      sharedAcquired = true;
      return;
    }
    if (eligible && !reader && !snapshot.exists) {
      try { acquire(); return; } catch (error) { if (error?.code !== 'EEXIST') throw error; ownLockRaw = null; }
    }
    if (!waiterPath && options.wait !== false) registerWaiter(waiters);
  };

  // Heartbeats establish recovery freshness, not changed exclusion or queue
  // eligibility. Keep the JSON owner/reclaim contract separate from workspace
  // leases while sharing their native notification mechanics.
  const ownerIdentity = path => {
    const snapshot = readJsonOwnerLockSnapshot(path);
    if (!snapshot.owner) return snapshot.raw;
    const { updatedAtMs, ...identity } = snapshot.owner;
    return identity;
  };
  const readWaitSnapshot = () => {
    let names = [];
    try { names = readdirSync(waitersDir).filter(name => /^\d+\.json$/.test(name)).sort(); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    observedWaiterNames = new Set(names);
    return JSON.stringify([ownerIdentity(lockPath), names.filter(name => join(waitersDir, name) !== waiterPath)
      .map(name => [name, ownerIdentity(join(waitersDir, name))])]);
  };

  try {
    while (true) {
      options.signal?.throwIfAborted();
      if (waiterPath && readJsonOwnerLockRaw(waiterPath) !== ownWaiterRaw) {
        // A caller opting into live stale reclaim can resume after its ticket
        // was reclaimed. Join again rather than waiting on a missing head.
        clearInterval(waiterHeartbeat);
        waiterHeartbeat = null;
        activeWriterWaiters.delete(waiterPath);
        waiterPath = null;
        ownWaiterRaw = null;
      }
      const waitSnapshot = observer.capture(readWaitSnapshot);
      if (fair && options.shouldAcquire && !await options.shouldAcquire()) {
        options.signal?.throwIfAborted();
        return;
      }
      if (sharedReaders) {
        // Both reader joins and writer decisions use the existing short ticket
        // registration lock. No reader may race a newly registered writer.
        await withQueueGate(trySharedAcquire);
        if (sharedAcquired || exclusiveAcquired) break;
      }
      const head = fair ? readWaiters()[0] : null;
      let eligible = !fair || (waiterPath ? head?.path === waiterPath : !head);
      try {
        if (eligible && !sharedReaders) acquire();
        if (exclusiveAcquired) {
          // Keep the exclusive-create fast path. A newcomer may reserve the file
          // during a head's slow poll, but may not enter ahead of that head.
          if (!fair || waiterPath || readWaiters().length === 0) break;
          exclusiveAcquired = false;
          if (readJsonOwnerLockRaw(lockPath) === ownLockRaw) unlinkSync(lockPath);
          ownLockRaw = null;
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        ownLockRaw = null;
      }
      if (fair && !sharedReaders && !waiterPath && options.wait !== false) {
        await withJsonOwnerFileLockInternal(() => registerWaiter(readWaiters()), {
          ...options, lockPath:`${lockPath}.queue.lock`, onWait:undefined,
          timeoutMs:Math.max(0, timeoutMs - (Date.now() - startedAt)), staleAfterMs,
        }, false);
        eligible = readWaiters()[0]?.path === waiterPath;
      }
      const lockState = sharedReaders ? waitLockState : readLockState();
      const { snapshot, observedAtMs } = lockState;
      if (!sharedReaders && eligible && lockState.reclaimable) {
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
              ...owner,
              kind: lockState.kind,
              ...readJsonOwnerLockOwnerAges(owner, observedAtMs),
            })),
            observedAtMs,
            queueHead: head?.owner,
            staleAfterMs,
            timeoutMs,
            waitedMs: Date.now() - startedAt,
          });
        } catch {}
      }
      await observer.wait({ snapshot: waitSnapshot, readSnapshot: readWaitSnapshot,
        maxWaitMs: Math.min(catchUpMs, Math.max(1, timeoutMs - (Date.now() - startedAt)), Math.max(1, staleAfterMs)),
        signal: options.signal });
    }

    observer.close();
    options.signal?.throwIfAborted();
    if (!sharedAcquired) heartbeat = setInterval(() => {
      try {
        if (readJsonOwnerLockRaw(lockPath) !== ownLockRaw) return;
        const nextRaw = serializeJsonOwnerLock({ createdAtMs: acquiredAtMs, updatedAtMs: Date.now(), priority:options.priority });
        if (publishOwnerRecord(lockPath, nextRaw, { expectedRaw: ownLockRaw })) ownLockRaw = nextRaw;
      } catch {}
    }, heartbeatIntervalMs);
    return await fn({ waited, lockPath, owner: sharedAcquired ? ownReader : readJsonOwnerLockSnapshot(lockPath).owner });
  } finally {
    observer.close();
    if (heartbeat) clearInterval(heartbeat);
    if (waiterHeartbeat) clearInterval(waiterHeartbeat);
    if (sharedAcquired) {
      // Release must finish even when the containing operation was cancelled.
      await withJsonOwnerFileLockInternal(() => {
        const owner = readJsonOwnerLockSnapshot(lockPath).owner;
        if (owner?.priority !== 'reader' || !Array.isArray(owner.readers)) return;
        const readers = owner.readers.filter(reader => reader.readerId !== ownReader.readerId && isPidAlive(Number(reader.pid)));
        if (readers.length > 0) publishReaders(readers);
        else unlinkSync(lockPath);
      }, { ...options, signal: undefined, wait: true, sharedReaders: false,
        lockPath: `${lockPath}.queue.lock`, timeoutMs: Infinity, onWait: undefined }, false);
    }
    if (exclusiveAcquired) {
      try {
        if (readJsonOwnerLockRaw(lockPath) === ownLockRaw) unlinkSync(lockPath);
      } catch {}
    }
    try {
      if (waiterPath && readJsonOwnerLockRaw(waiterPath) === ownWaiterRaw) unlinkSync(waiterPath);
    } catch {}
    if (options.priority === 'writer') activeWriterWaiters.delete(waiterPath);
  }
}
