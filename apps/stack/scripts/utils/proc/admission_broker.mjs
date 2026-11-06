import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, watch } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { admitWorkerDiskBudget } from '../dev_targets/worker_disk_budget.mjs';
import { readLinuxWorkerProcesses } from './service_memory.mjs';
import { createWorkspaceBuildResourceObservation } from './workspace_build_admission.mjs';
import { DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../../packages/cli-common/fileChangeObserver.mjs';
import { brokerAddress, readSlotAddress, slotAddress } from './admission_socket.mjs';
export { brokerAddress } from './admission_socket.mjs';

function readLinuxMemory() {
  const memory = readFileSync('/proc/meminfo', 'utf8');
  return { availableMemoryKiB: Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1]),
    totalMemoryKiB: Number(/^MemTotal:\s+(\d+)/m.exec(memory)?.[1]) };
}

const socketGone = error => error.code === 'ECONNREFUSED' || error.code === 'ENOENT';

async function lockFile(fd) {
  // flock locks the inherited open-file description. Retaining the original
  // FD keeps the lock after this one-shot utility exits.
  await new Promise((resolveLocked, reject) => {
    const child = spawn('flock', ['--exclusive', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    child.once('error', reject);
    child.once('exit', status => status === 0 ? resolveLocked()
      : reject(Object.assign(new Error('Admission lock unavailable'), { code: 'HSTACK_ADMISSION_UNAVAILABLE' })));
  });
}

async function withStartupLock(root, run, inheritedFd) {
  const fd = inheritedFd ?? openSync(join(root, 'broker-start.lock'), 'a', 0o600);
  try {
    if (inheritedFd === undefined) await lockFile(fd);
    return await run();
  } finally { closeSync(fd); }
}

async function socketListening(address) {
  const peer = createConnection(address);
  try {
    await new Promise((resolveConnected, reject) => {
      peer.once('connect', resolveConnected);
      peer.once('error', reject);
    });
    return true;
  } catch (error) {
    if (socketGone(error)) return false;
    throw error;
  } finally { peer.destroy(); }
}

/** Physical availability already excludes resident pages. Credit each admitted
 * tree's resident pages once, reserving only the part of its floor still free. */
export async function readAdmissionMemorySample({ slots = [], readProcesses = readLinuxWorkerProcesses,
  readMemory = readLinuxMemory } = {}) {
  const memory = await readMemory();
  if (!Number.isSafeInteger(memory.availableMemoryKiB) || memory.availableMemoryKiB < 0
    || !Number.isSafeInteger(memory.totalMemoryKiB) || memory.totalMemoryKiB <= 0) {
    throw Object.assign(new Error('Memory observation unavailable'), { code: 'HSTACK_MEMORY_UNAVAILABLE' });
  }
  const processes = slots.length ? await readProcesses() : new Map();
  const roots = new Set(slots.map(slot => slot.pid));
  const residentByRoot = new Map();
  for (const process of processes.values()) {
    let pid = process.pid;
    while (pid > 1 && !roots.has(pid)) {
      const parent = processes.get(pid)?.parentPid;
      if (!parent || parent === pid) { pid = 0; break; }
      pid = parent;
    }
    if (roots.has(pid)) {
      const proportional = process.pssKiB;
      const exact = Number.isSafeInteger(proportional) && proportional >= 0;
      const resident = exact ? proportional : 0;
      residentByRoot.set(pid, (residentByRoot.get(pid) ?? 0) + resident);
    }
  }
  const residentMemoryKiB = [...residentByRoot.values()].reduce((sum, value) => sum + value, 0);
  const creditedResidentMemoryKiB = slots.reduce((sum, slot) => sum + Math.min(slot.floorKiB, residentByRoot.get(slot.pid) ?? 0), 0);
  const reservedMemoryKiB = slots.reduce((sum, slot) => sum + slot.floorKiB, 0);
  const achievableMemoryKiB = Math.min(memory.totalMemoryKiB, memory.availableMemoryKiB + residentMemoryKiB);
  return { ...memory, reservedMemoryKiB, residentMemoryKiB, creditedResidentMemoryKiB,
    achievableMemoryKiB,
    unreservedMemoryKiB: Math.max(0, memory.availableMemoryKiB + creditedResidentMemoryKiB - reservedMemoryKiB) };
}

/** One Linux host authority. The control connection carries the finite
 * admission handshake; a client-owned pathname listener carries job lifetime.
 * The existing private root's OS permissions are the sole peer boundary. */
export function createAdmissionBroker({ root, oldLockPath = '/tmp/happier-heavyweight-admission-v3/lock',
  oldLockFd, startupLockFd, sampleResources = readAdmissionMemorySample,
  admitDisk = request => request.cacheBaseDir
    ? admitWorkerDiskBudget({ ...request, commandClass: request.className }) : { admitted: true } } = {}) {
  const slots = new Map();
  const waiting = [];
  const controls = new Set();
  const pendingConnections = new Set();
  const watchers = new Map();
  const pendingResourceChanges = new Set();
  let resourceCatchUp;
  let sample = { availableMemoryKiB: 0, totalMemoryKiB: 0, reservedMemoryKiB: 0,
    residentMemoryKiB: 0, unreservedMemoryKiB: 0, achievableMemoryKiB: 0 };
  let sampleCount = 0;
  let arrivalOrder = 0;
  let serial = Promise.resolve();
  let closing = false;
  let server;
  let started = false;
  let heldOldLockFd = oldLockFd;

  function slotMemoryBudget() {
    const reservedMemoryKiB = [...slots.values()].reduce((sum, slot) => sum + slot.floorKiB, 0);
    return { reservedMemoryKiB,
      unreservedMemoryKiB: Math.max(0, sample.availableMemoryKiB + (sample.creditedResidentMemoryKiB ?? 0) - reservedMemoryKiB) };
  }
  function headReservationKiB(head) {
    if (!head) return 0;
    const floorKiB = head.floorOptions?.at(-1).floorKiB ?? head.floorKiB;
    let precedingFloorKiB = 0;
    for (const slot of slots.values()) {
      // Recovered slots predate every request in this broker. Younger
      // backfills must never count as releases that can make room for the head.
      if (slot.arrivalOrder === undefined || slot.arrivalOrder < head.arrivalOrder) precedingFloorKiB += slot.floorKiB;
    }
    return Math.max(0, floorKiB - precedingFloorKiB);
  }
  function status() {
    const memory = slotMemoryBudget();
    const head = waiting.find(item => !item.slot && !item.blocked && !item.socket.destroyed);
    // Publish the same head reservation used by drain and read-only checks.
    // Publication-blocked demand has no memory reservation.
    return { ...sample, ...memory,
      unreservedMemoryKiB: Math.max(0, memory.unreservedMemoryKiB - headReservationKiB(head)),
      queuedMemoryKiB: waiting.reduce((sum, item) => sum + (item.slot ? 0 : item.floorKiB), 0),
      activeCount: slots.size, waitingCount: waiting.filter(item => !item.slot).length, sampleCount };
  }
  const send = (socket, value, snapshot = status()) => { if (!socket.destroyed) socket.write(JSON.stringify({ ...snapshot, ...value }) + '\n'); };
  function recordFailure(error) {
    // Keep only a symbolic code and a source location, never exception text,
    // resource paths or OS payloads. Retain this evidence after recovery.
    const candidate = error?.code ?? error?.name;
    const code = typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(candidate) ? candidate : 'Error';
    const source = String(error?.stack ?? '').split('\n').slice(1)
      .map(line => /^\s+at .*?([A-Za-z0-9_.-]+\.mjs:\d+:\d+)\)?$/.exec(line)?.[1]).find(Boolean);
    sample = { ...sample, lastFailure: { code, ...(source ? { source } : {}) } };
  }
  function enqueue(run) {
    serial = serial.then(async () => { if (!closing) await run(); }).catch(error => {
      recordFailure(error);
      // A failed observation cannot authorize work from a stale capacity fact.
      sample = { ...sample, availableMemoryKiB: 0, creditedResidentMemoryKiB: 0, achievableMemoryKiB: 0, unreservedMemoryKiB: 0 };
      // The failed pass does not decide the fate of unrelated waiters. Keep
      // their order, watchers and existing catch-up so the next pass can decide.
    }).then(publishQueuePositions);
    return serial;
  }
  function publishQueuePositions() {
    if (closing) return;
    const queued = waiting.filter(item => !item.slot);
    let snapshot;
    for (const [index, item] of queued.entries()) {
      const queuePosition = index + 1;
      if (item.queuePosition === queuePosition) continue;
      item.queuePosition = queuePosition;
      // One shared status projection keeps a queue advance proportional to
      // its waiters instead of rescanning the queue for every notice.
      snapshot ??= status();
      send(item.socket, { kind: 'queued', queuePosition, countAhead: index }, snapshot);
    }
  }
  async function observe() {
    sample = { ...(sample.lastFailure ? { lastFailure: sample.lastFailure } : {}),
      ...await sampleResources({ slots: [...slots.values()].map(({ pid, floorKiB }) => ({ pid, floorKiB })) }) };
    sampleCount += 1;
  }
  function removeWaiting(item) {
    const index = waiting.indexOf(item);
    if (index !== -1) waiting.splice(index, 1);
  }
  function refuse(item, reason, cause) {
    removeWaiting(item);
    if (item.slot && !item.settled) {
      slots.delete(item.slot.address);
      item.slot.peer?.destroy();
    }
    item.settled = true;
    send(item.socket, { kind: 'refused', reason, ...(cause ? { cause } : {}) });
    item.socket.end();
  }
  function readResources(item) {
    try { return item.observation.readState(); }
    catch (error) {
      recordFailure(error);
      refuse(item, 'HSTACK_RESOURCE_OBSERVATION_UNAVAILABLE', error.code ?? error.name);
      return null;
    }
  }
  function refreshWatchers() {
    const blocked = waiting.filter(item => item.blocked);
    const memoryWaiting = waiting.some(item => !item.slot && !item.blocked);
    // External RAM recovery, process death and expired leases need not emit
    // filesystem events. Share the lock owner's existing catch-up cadence.
    // Unchanged workspace-only demand still performs no memory observation.
    if ((blocked.length || memoryWaiting) && !resourceCatchUp) {
      // Retain this handle while queued/running. Rearm only after recovery
      // drains, so slow OS observations cannot accumulate ticks or run back-to-back.
      const timer = setTimeout(() => enqueue(async () => {
        try {
          await resourcesChanged(waiting.filter(item => item.blocked),
            waiting.some(item => !item.slot && !item.blocked));
        } finally {
          if (resourceCatchUp === timer) {
            resourceCatchUp = undefined;
            refreshWatchers();
          }
        }
      }), DEFAULT_FILE_CHANGE_CATCH_UP_MS);
      resourceCatchUp = timer;
      timer.unref();
    } else if (!blocked.length && !memoryWaiting && resourceCatchUp) {
      clearTimeout(resourceCatchUp);
      resourceCatchUp = undefined;
    }
    const directories = new Set(blocked.flatMap(item => item.observation.directories));
    for (const [directory, watcher] of watchers) if (!directories.has(directory)) { watcher.close(); watchers.delete(directory); }
    for (const directory of directories) {
      if (watchers.has(directory)) continue;
      let watcher;
      try {
        watcher = watch(directory, (_event, filename) => {
          const queued = pendingResourceChanges.size > 0;
          for (const item of waiting) {
            if (item.blocked && item.observation.directories.includes(directory)
              && item.observation.isRelevant(directory, filename)) pendingResourceChanges.add(item);
          }
          if (queued || !pendingResourceChanges.size) return;
          // A publication scope can update many watched files in one burst.
          // Read each affected waiter's current snapshot once, rather than
          // queueing full lock scans ahead of every control/status request.
          setImmediate(() => enqueue(() => {
            const consumers = [...pendingResourceChanges];
            pendingResourceChanges.clear();
            return resourcesChanged(consumers);
          }));
        });
      } catch (error) {
        // An unvisited resource's parent may not exist yet. The client's
        // canonical attempt creates it before that resource can block.
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      watcher.on('error', () => enqueue(async () => {
        watcher.close();
        watchers.delete(directory);
        for (const item of waiting.filter(item => item.blocked)) {
          if (item.observation.directories.includes(directory)) {
            refuse(item, 'HSTACK_RESOURCE_OBSERVATION_UNAVAILABLE');
          }
        }
        refreshWatchers();
      }));
      watchers.set(directory, watcher);
    }
    // Arm before comparing the offer's canonical snapshot, so a release
    // between the client's busy reply and watcher registration cannot be lost.
    const changed = blocked.filter(item => {
      const resources = readResources(item);
      return resources !== null && resources.snapshot !== item.resourceSnapshot;
    });
    if (changed.length) {
      enqueue(() => resourcesChanged(changed));
    }
  }
  async function resourcesChanged(consumers, resampleMemory) {
    let changed = resampleMemory;
    for (const item of consumers) {
      if (!waiting.includes(item) || !item.blocked || !resourceChanged(item)) continue;
      changed = true;
      item.blocked = false;
    }
    if (changed) { await observe(); await drain(); }
  }
  function resourceChanged(item) {
    const resources = readResources(item);
    if (!resources || resources.snapshot === item.resourceSnapshot) return false;
    item.resourceSnapshot = resources.snapshot;
    return true;
  }
  async function release(slot) {
    if (!slots.delete(slot.address)) return;
    slot.peer?.destroy();
    await releaseDecision();
  }
  async function releaseDecision() {
    await observe();
    await drain();
  }
  async function drain() {
    // Reserve only what older holders cannot supply to the head. Their releases
    // increase that reservation, while backfills can reuse only the remainder.
    let availableMemoryKiB = slotMemoryBudget().unreservedMemoryKiB;
    let head;
    for (const item of [...waiting]) {
      if (item.slot || item.blocked) continue;
      if (item.socket.destroyed) { removeWaiting(item); continue; }
      const minimumFloorKiB = item.floorOptions?.at(-1).floorKiB ?? item.floorKiB;
      if (minimumFloorKiB > sample.totalMemoryKiB) {
        refuse(item, 'HSTACK_MEMORY_CAPACITY');
        continue;
      }
      const fitting = item.floorOptions?.find(option => option.floorKiB <= availableMemoryKiB);
      if (item.floorOptions ? !fitting : item.floorKiB > availableMemoryKiB) {
        if (item.noWait) refuse(item, 'HSTACK_MEMORY_BUSY');
        else {
          // Publication preference cannot block admitted work while this
          // request waits for that work to release its memory reservation.
          if (item.locks.length) send(item.socket, { kind: 'capacity-wait' });
          // A head that cannot fit has not reached the client's resource
          // attempt yet. An active publication must not reserve its floor.
          const resources = readResources(item);
          if (!resources) continue;
          if (resources.publicationBlocked) {
            item.blocked = true;
            item.resourceSnapshot = resources.snapshot;
          } else if (!head) {
            head = item;
            availableMemoryKiB = Math.max(0, availableMemoryKiB - headReservationKiB(head));
          }
        }
        continue;
      }
      const floorKiB = fitting?.floorKiB ?? item.floorKiB;
      if (item.socket.destroyed) { removeWaiting(item); continue; }
      // Observe before publishing a reservation: a failed request must not
      // leave a slot that its client was never offered.
      const resources = readResources(item);
      if (!resources) continue;
      const address = slotAddress(root, item.pid, floorKiB, randomUUID());
      const slot = { address, pid: item.pid, floorKiB, workers: fitting?.workers, control: item.socket, arrivalOrder: item.arrivalOrder };
      slots.set(address, slot);
      availableMemoryKiB -= floorKiB;
      item.slot = slot;
      item.resourceSnapshot = resources.snapshot;
      send(item.socket, { kind: 'reserved', slotAddress: address, floorKiB, workers: slot.workers });
    }
    refreshWatchers();
  }
  async function connectSlot(slot) {
    const peer = createConnection(slot.address);
    slot.peer = peer;
    await new Promise((resolveConnected, reject) => {
      peer.once('connect', resolveConnected);
      peer.once('error', reject);
    });
    peer.on('error', () => {});
    peer.once('close', () => enqueue(() => release(slot)));
    return slot;
  }
  function accept(socket) {
    controls.add(socket);
    let item;
    const lines = createInterface({ input: socket });
    // readline forwards input errors independently of the socket listener.
    // A disconnected control releases only its own unfinished admission.
    lines.on('error', () => socket.destroy());
    lines.on('line', line => enqueue(async () => {
      let request;
      try { request = JSON.parse(line); } catch { socket.destroy(); return; }
      if (request.kind === 'sample') { send(socket, { kind: 'sample' }); socket.end(); return; }
      if (request.kind === 'check') {
        const valid = Number.isSafeInteger(request.floorKiB) && request.floorKiB > 0;
        const admitted = valid && request.floorKiB <= status().unreservedMemoryKiB;
        const capacity = request.floorKiB > sample.totalMemoryKiB;
        send(socket, { kind: admitted ? 'admitted' : 'refused',
          ...(!admitted ? { reason: !valid ? 'HSTACK_INVALID_ADMISSION'
            : capacity ? 'HSTACK_MEMORY_CAPACITY' : 'HSTACK_MEMORY_BUSY' } : {}) });
        socket.end(); return;
      }
      if (request.kind === 'ready' && item?.slot && !item.settled) {
        try {
          await connectSlot(item.slot);
          item.settled = true;
          removeWaiting(item);
          send(socket, { kind: 'admitted', floorKiB: item.slot.floorKiB, workers: item.slot.workers });
          refreshWatchers();
        } catch { refuse(item, 'HSTACK_SLOT_UNAVAILABLE'); await releaseDecision(); }
        return;
      }
      if (request.kind === 'resources-busy' && item?.slot && !item.settled) {
        slots.delete(item.slot.address);
        item.slot = null;
        item.blocked = true;
        if (item.noWait) refuse(item, 'HSTACK_WORKSPACE_RESOURCE_BUSY');
        // A release may race the client's busy acknowledgement. Its offer's
        // snapshot closes that gap without a timer or retaining partial scopes.
        else if (resourceChanged(item)) {
          item.blocked = false;
          await observe();
        }
        await drain();
        return;
      }
      if (request.kind !== 'acquire' || item || !Number.isSafeInteger(request.floorKiB) || request.floorKiB <= 0
        || !Number.isSafeInteger(request.pid) || request.pid <= 1 || typeof request.className !== 'string'
        || typeof request.repoDir !== 'string' || (request.cacheBaseDir !== undefined && typeof request.cacheBaseDir !== 'string')
        || (request.floorOptions !== undefined && (!Array.isArray(request.floorOptions) || request.floorOptions.length === 0
          || request.floorOptions.some(option => !Number.isSafeInteger(option?.floorKiB) || option.floorKiB <= 0
            || !Number.isSafeInteger(option.workers) || option.workers <= 0)))
        || !Array.isArray(request.locks ?? []) || (request.locks ?? []).some(lock => typeof lock?.path !== 'string')) {
        send(socket, { kind: 'refused', reason: 'HSTACK_INVALID_ADMISSION' }); socket.end(); return;
      }
      item = { ...request, socket, locks: request.locks ?? [], env: request.env ?? {}, settled: false, arrivalOrder: ++arrivalOrder };
      item.observation = createWorkspaceBuildResourceObservation({ locks: item.locks });
      if (item.floorOptions) item.floorOptions = [...item.floorOptions].sort((left, right) => right.floorKiB - left.floorKiB || right.workers - left.workers);
      waiting.push(item);
      refreshWatchers();
      let disk;
      try { disk = await admitDisk(item); }
      catch (error) {
        recordFailure(error);
        refuse(item, 'HSTACK_ADMISSION_UNAVAILABLE', error.code ?? error.name);
        refreshWatchers();
        return;
      }
      if (!disk.admitted) { refuse(item, 'HSTACK_DISK_UNAVAILABLE'); refreshWatchers(); return; }
      // Existing memory demand already has an observation and the shared
      // recovery loop. Another waiter changes neither physical capacity nor
      // admitted floors, including when many clients reconnect after restart.
      // Disk reclamation is a real resource change and still needs a new read.
      const memoryWaiting = waiting.some(other => other !== item && !other.slot && !other.blocked);
      if (!memoryWaiting || disk.reclamation?.length) await observe();
      await drain();
    }));
    socket.on('error', () => {});
    socket.once('close', () => {
      controls.delete(socket);
      if (!item || item.settled) return;
      enqueue(async () => {
        if (item.slot) { removeWaiting(item); await release(item.slot); }
        else { removeWaiting(item); await drain(); }
      });
    });
  }
  return {
    status,
    async start() {
      if (process.platform !== 'linux') throw new Error('Admission broker requires Linux');
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const directory = lstatSync(root);
      if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o700) {
        throw Object.assign(new Error('Admission root must be a private owned directory'), { code: 'EACCES' });
      }
      await withStartupLock(root, async () => {
        const address = brokerAddress(root);
        if (await socketListening(address)) {
          throw Object.assign(new Error('Admission broker already listening'), { code: 'EADDRINUSE' });
        }
        if (heldOldLockFd === undefined) {
          mkdirSync(dirname(oldLockPath), { recursive: true, mode: 0o700 });
          heldOldLockFd = openSync(oldLockPath, 'a', 0o600);
          await lockFile(heldOldLockFd);
        }
        // At cutover this is the barrier's already-locked open description;
        // never unlock/reacquire it. Late parsed old launchers remain queued
        // on their existing mutex throughout this broker's runtime.
        try {
          if (!lstatSync(address).isSocket()) throw Object.assign(new Error('Admission socket path occupied'), { code: 'EEXIST' });
          unlinkSync(address);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        server = createServer(socket => {
          if (started) accept(socket);
          else {
            pendingConnections.add(socket);
            socket.on('error', () => {});
            socket.once('close', () => pendingConnections.delete(socket));
          }
        });
        await new Promise((resolveListening, reject) => { server.once('error', reject); server.listen(address, resolveListening); });
        try {
          for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (!entry.isSocket()) continue;
            const slot = readSlotAddress(root, entry.name);
            if (!slot) continue;
            try { await connectSlot(slot); slots.set(slot.address, slot); }
            catch (error) {
              slot.peer.destroy();
              // Only an absent listener proves its floor is gone. Descriptor,
              // permission and other observation failures cannot erase live work.
              if (!socketGone(error)) throw error;
              try { unlinkSync(slot.address); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
            }
          }
          await observe();
          started = true;
          for (const socket of pendingConnections) if (!socket.destroyed) accept(socket);
          pendingConnections.clear();
        } catch (error) {
          await this.close();
          throw error;
        }
      }, startupLockFd);
      return this;
    },
    async close() {
      if (closing) return;
      closing = true;
      clearTimeout(resourceCatchUp);
      resourceCatchUp = undefined;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      for (const socket of controls) socket.destroy();
      for (const socket of pendingConnections) socket.destroy();
      await serial;
      for (const slot of slots.values()) {
        slot.peer?.destroy();
      }
      await new Promise(resolveClosed => server?.listening ? server.close(resolveClosed) : resolveClosed());
      if (heldOldLockFd !== undefined) {
        closeSync(heldOldLockFd);
        heldOldLockFd = undefined;
      }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--serve') {
  const argument = name => process.argv.slice(4).find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const descriptor = name => {
    const value = argument(name);
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 3) {
      throw new Error('Invalid inherited admission descriptor');
    }
    return Number(value);
  };
  const broker = createAdmissionBroker({ root: process.argv[3], oldLockPath: argument('old-lock-path'),
    oldLockFd: descriptor('old-lock-fd'), startupLockFd: descriptor('startup-lock-fd') });
  try { await broker.start(); process.stdout.write('ready\n'); }
  catch (error) {
    if (error.code === 'EADDRINUSE') process.stdout.write('ready\n');
    else { process.stderr.write('HSTACK_ADMISSION_BROKER_UNAVAILABLE\n'); process.exitCode = 76; }
    await broker.close();
  }
}
