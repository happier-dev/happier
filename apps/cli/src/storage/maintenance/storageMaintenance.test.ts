import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';
import { MachineStoragePolicyV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { createActivityLog } from '@/daemon/guard/activityLog';
import { createBrowserRecordingDaemonService } from '@/daemon/browser/recording/service';
import { createBrowserRecordingSessionMediaWriter } from '@/daemon/browser/recording/sessionMediaWriter';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { createDeferred } from '@/testkit/async/deferred';
import { createLogRetentionOwner, storageLogRoots } from '@/utils/logs/logRetention';
import { createTrashStore, resolveTrashOsUserId } from '../trash/trashStore';
import { createStorageMaintenance } from './storageMaintenance';
import { createStorageService } from '../storageService';
import { readStoragePathIdentity, removeStoragePath } from '../trash/removeStoragePath';
import { createDaemonStorageVitalsBindings } from '@/daemon/resources/createDaemonStorageVitalsBindings';
import { createMachineResourceSummary } from '@/daemon/resources/machineResourceSummary';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { createLinuxMachineVitalsReader } from '@/daemon/vitals/readers/linux';
import { createLinuxVitalsFixture } from '@/daemon/vitals/readers/linux.testkit';
import { HappierStorageSummaryV1Schema, TrashEntryV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { MachineVitalsSampleV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

// The Node timer module is the external clock boundary; use Vitest's same fake clock.
const clockBoundary = vi.hoisted(() => ({ onArm: undefined as (() => void) | undefined }));
vi.mock('node:timers', () => ({ setTimeout: (callback: () => void, delay?: number) => {
  const timer = globalThis.setTimeout(callback, delay); clockBoundary.onArm?.(); return timer;
},
  clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => globalThis.clearTimeout(handle) }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});


const day = 86_400_000;
let disposeNative: (() => Promise<void>) | undefined;
let scratch: string;
let serial = 0;
const size = { allocatedBytes: 0, freesBytes: 0, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false };

async function fixture(withRecording = false, readIdle?: () => boolean | Promise<boolean>) {
  const home = join(scratch, `home-${serial++}`); await fs.mkdir(home);
  const logDir = join(home, 'logs'); await fs.mkdir(logDir);
  let policy = MachineStoragePolicyV1Schema.parse({});
  let idle = false; let power = false;
  const policyListeners = new Set<() => void>(); const idleListeners = new Set<() => void>(); const volumeListeners = new Set<() => void>();
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const errors: unknown[] = []; const automatic: unknown[] = [];
  const activityLog = await createActivityLog({ activeServerDir: home, resourceSummary: { reportAutomaticAction: value => automatic.push(value) } });
  const store = createTrashStore({ happyHomeDir: home, osUserId: await resolveTrashOsUserId(), target: { machineId: 'machine' },
    readVolumes: () => [{ id: 'fixture', mount: scratch }], activityLog, attributionFor: accountId => ({ serverId: 'home', machineId: 'machine', installationId: 'install', accountId }),
    classifyRestorePath: async () => null, readEmptyAfterDays: () => policy.trashEmptyAfterDays });
  const source = join(home, 'capture.webm');
  const bytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]), Buffer.alloc(4096, 7)]);
  const recordings = createBrowserRecordingDaemonService({ captureAdapters: withRecording ? [{ captureKind: 'streamFrameCapture',
    start: async () => ({ status: 'started' }),
    stop: async () => ({ durationMs: 2_000, byteSize: bytes.length, frameCount: 24, fps: 12, mimeType: 'video/webm', source: { kind: 'local-file', path: source, fileNameHint: 'capture.webm' } }),
    discard: async () => {},
  }] : [], mediaWriter: createBrowserRecordingSessionMediaWriter({ workingDirectory: home,
    pathAllowanceRegistry: createTransferPathAllowanceRegistry(), resolveSessionMediaTarget: recording => ({ sessionId: 'recording-session', messageLocalId: recording.recordingId }) }) });
  let scans = 0;
  let logPasses = 0;
  const logs = createLogRetentionOwner({ happyHomeDir: home, currentLogPaths: () => { logPasses++; return [join(logDir, 'current.log')]; },
    env: { HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT: '1' }, onError: error => errors.push(error) });
  const maintenance = createStorageMaintenance({ readPolicy: () => policy, subscribePolicy: subscribe(policyListeners), subscribeVolumes: subscribe(volumeListeners),
    isIdle: () => readIdle ? readIdle() : idle, subscribeIdle: subscribe(idleListeners), isOnPower: () => power, subscribePower: subscribe(idleListeners),
    getTrashStore: async () => store, logs, recordings, runScheduledScan: async () => { scans++; }, activityLog,
    actorAccountId: 'custodian', onError: error => errors.push(error) });
  async function writeLog(name: string, ageDays: number, dir = logDir) {
    await fs.mkdir(dir, { recursive: true }); const path = join(dir, name); await fs.writeFile(path, Buffer.alloc(4096, 7));
    const at = new Date(Date.now() - ageDays * day); await fs.utimes(path, at, at); return path;
  }
  return { home, logDir, store, logs, activityLog, maintenance, recordings, errors, automatic, writeLog,
    readPolicy: () => policy, isIdle: () => readIdle ? readIdle() : idle, isOnPower: () => power,
    subscribePolicy: subscribe(policyListeners), subscribeIdle: subscribe(idleListeners), subscribeVolumes: subscribe(volumeListeners),
    async writeRecording(expiresAtMs: number) {
      await fs.writeFile(source, bytes);
      expect((await recordings.startRecording({ browserRecordingEnabled: true, recordingId: 'recording', browserSessionId: 'browser', viewId: 'view', profileId: 'profile',
        targetKind: 'streamedBrowser', adapterKind: 'streamedBrowserSurface', renderEngineKind: 'streamedSurface', captureKind: 'streamFrameCapture', fidelity: 'streamFrame',
        navigationGeneration: 1, mimeType: 'video/webm', retentionClass: 'preSend',
        captureSource: { kind: 'machineLiveStream', streamFamily: 'browser.streamed', sourceId: 'stream', targetMachineId: 'machine' },
        recordingCapabilities: { enabled: true, attachmentsEnabled: true, available: true, supportedCaptureKinds: ['streamFrameCapture'], supportedMimeTypes: ['video/webm'],
          supportedAdapterKinds: ['streamedBrowserSurface'], maxFps: 12, audioSupported: false, cursorOverlaySupported: true,
          actionTimelineChaptersSupported: true, supportedRetentionClasses: ['preSend'], disabledReasons: [], policyDeniedReasons: [] } })).status).toBe('started');
      expect((await recordings.stopRecording({ recordingId: 'recording', stoppedAtMs: Date.now() + 2_000, navigationGenerationEnd: 2, expiresAtMs })).status).toBe('finalized');
      await fs.unlink(source); return recordings.listStorageRecordings()[0].path;
    },
    setPolicy(patch: Partial<typeof policy>) { policy = { ...policy, ...patch }; for (const listener of policyListeners) listener(); },
    setIdlePower(nextIdle: boolean, nextPower: boolean) { idle = nextIdle; power = nextPower; for (const listener of idleListeners) listener(); },
    get logPasses() { return logPasses; }, get scans() { return scans; } };
}

describe('one due-time storage maintenance owner with real retained files', () => {
  beforeAll(async () => {
    scratch = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'happier-maintenance-')));
    disposeNative = await createProcessCustodyFixture();
  });
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(new Date('2026-10-11T09:00:00Z')); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  afterAll(async () => { await disposeNative?.(); await fs.rm(scratch, { recursive: true, force: true }); });

  it('projects sampler edges into real maintenance and Storage without idle work or no-op Trash invalidation', async () => {
    const f = await fixture();
    const os = await createLinuxVitalsFixture();
    const mountLine = (id: number, mount: string) => `${id} 0 8:${id} / ${mount} rw - ext4 /dev/fixture${id} rw\n`;
    await os.put('/proc/self/mountinfo', mountLine(1, scratch));
    await fs.mkdir(join(os.root, scratch), { recursive: true });
    await os.put('/sys/class/power_supply/AC/type', 'Mains\n');
    await os.put('/sys/class/power_supply/AC/online', '1\n');
    let available = 500;
    let sampled = createDeferred<void>();
    const sampler = createMachineVitalsSampler({
      readers: createLinuxMachineVitalsReader({ root: os.root, homePath: f.home,
        statfs: async () => ({ bsize: 4096, blocks: 1000, bfree: available, bavail: available, files: 100, ffree: 50 }) }),
      historyStore: await createMinuteHistoryStore({ directory: join(f.home, 'vitals') }),
      monotonicMs: () => Date.now(), onTick: () => sampled.resolve(), onError: error => f.errors.push(error),
    });
    await sampler.start();
    const resourceSummary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => f.errors.push(error) });
    const activityLog = await createActivityLog({ activeServerDir: f.home, resourceSummary });
    const binding = createDaemonStorageVitalsBindings(sampler);
    const service = createStorageService({ machineId: 'machine', homeDir: f.home, custodianAccountId: 'custodian',
      activityLog, readPolicy: f.readPolicy, ...binding, subscribeChanges: listener => {
        const releases = [f.subscribePolicy(listener), binding.subscribeVolumes(listener)];
        return () => { for (const release of releases) release(); };
      },
      catalog: { happyHomeDir: f.home, activeServerDir: f.home, tempRoot: join(f.home, 'absent-temp'),
        readProjects: () => ({ status: 'ready', projects: [] }) } });
    const store = await service.maintenanceTrash();
    const maintenance = createStorageMaintenance({ ...binding, readPolicy: f.readPolicy, subscribePolicy: f.subscribePolicy,
      isIdle: f.isIdle, subscribeIdle: f.subscribeIdle, getTrashStore: async () => store, logs: f.logs,
      recordings: f.recordings, runScheduledScan: async () => {
        await service.scanStart({ machineId: 'machine', target: { folderPath: f.home } }, { actor: { accountId: 'custodian', custodianAccountId: 'custodian',
          kind: 'person', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} } });
      }, activityLog, actorAccountId: 'custodian', onError: error => f.errors.push(error) });
    const releaseDemand = sampler.demand('live');
    let storageWakes = 0;
    const releaseStorage = service.subscribe(() => { storageWakes++; });
    async function tick() {
      sampled = createDeferred<void>();
      await vi.advanceTimersByTimeAsync(2000); await sampled.promise;
    }
    try {
      expect(binding.readVolumes()).toMatchObject([{ availableBytes: available * 4096 }]);
      const oldLog = await f.writeLog('retained.log', 2);
      const path = join(f.home, 'cache-to-retain'); await fs.mkdir(path); await fs.writeFile(join(path, 'bytes'), 'retained');
      const entry = await (await store.prepare({ path, title: 'Retained', batchId: 'sampler', size,
        movedBy: { accountId: 'custodian', kind: 'person' } })).commit();
      await maintenance.start();
      const initial = HappierStorageSummaryV1Schema.parse(await service.summary());
      const before = f.logPasses;
      storageWakes = 0;
      // requestPass is the existing queue's settlement fence. Subtract its one
      // explicit pass per tick to measure work requested by the ten sampler ticks.
      for (let i = 0; i < 10; i++) { await tick(); await maintenance.requestPass(); }
      expect.soft(f.logPasses - before - 10, 'idle maintenance passes for ten unchanged two-second samples').toBe(0);
      expect.soft(storageWakes, 'unchanged samples and no-op reconciliation must not wake Storage').toBe(0);
      const afterIdle = HappierStorageSummaryV1Schema.parse(await service.summary());
      expect.soft(afterIdle.revision).toBe(initial.revision);
      expect.soft(afterIdle.sizedAt).toBe(initial.sizedAt);
      MachineVitalsSampleV1Schema.parse(sampler.latest());
      storageWakes = 0; await store.reconcile();
      expect.soft(storageWakes, 'a committed Trash entry requires no reconciliation notification').toBe(0);

      available = 400;
      const beforeCapacity = f.logPasses;
      await tick(); await maintenance.requestPass();
      expect.soft(f.logPasses - beforeCapacity - 1, 'capacity changes update Storage without retention work').toBe(0);
      const afterCapacity = HappierStorageSummaryV1Schema.parse(await service.summary());
      expect(afterCapacity.volumes[0].freeBytes).toBe(400 * 4096);
      expect(afterCapacity.sizedAt).toBe(initial.sizedAt);

      const otherVolume = join(scratch, 'returning-volume'); await fs.mkdir(otherVolume);
      await fs.mkdir(join(os.root, otherVolume), { recursive: true });
      await os.put('/proc/self/mountinfo', mountLine(1, scratch) + mountLine(2, otherVolume));
      const beforeVolume = f.logPasses;
      await tick(); await maintenance.requestPass();
      expect(f.logPasses - beforeVolume - 1, 'a newly mounted volume must reach maintenance').toBe(1);
      const afterVolume = HappierStorageSummaryV1Schema.parse(await service.summary());
      expect(afterVolume.volumes).toHaveLength(2);
      expect(afterVolume.sizedAt).toBeGreaterThan(initial.sizedAt);

      const beforePower = f.logPasses;
      await os.put('/sys/class/power_supply/AC/online', '0\n');
      await tick(); await maintenance.requestPass();
      expect(f.logPasses - beforePower - 1, 'an AC edge must reach maintenance').toBe(1);
      expect(binding.isOnPower()).toBe(false);

      f.setPolicy({ logRetentionDays: 1, trashEmptyAfterDays: 1 });
      await maintenance.requestPass();
      await expect(fs.lstat(oldLog)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(TrashEntryV1Schema.parse(await store.read(entry.entryId)).emptiesAt).toBe(entry.movedAt + day);
      releaseDemand(); await sampler.stop();
      await vi.advanceTimersByTimeAsync(entry.movedAt + day - Date.now()); await maintenance.requestPass();
      expect(await store.list()).toEqual([]);
      expect((await activityLog.list({ range: 'today' })).entries.some(row => row.kind === 'housekeeping')).toBe(true);
      expect(f.errors).toEqual([]);
    } finally { releaseStorage(); releaseDemand(); await sampler.stop(); maintenance.stop(); service.dispose(); resourceSummary.stop();
      f.maintenance.stop(); await os.cleanup(); }
  });

  it('composes due volume scans through fresh idle/power admission, edge resumption and disabling pending work', async () => {
    let idle = true; let scheduled = false; let closeMakesBusy = false;
    let blocked = createDeferred<'blocked' | 'second_native'>();
    let secondComplete = createDeferred<void>();
    let powerChecked = createDeferred<void>();
    let nativeScans = 0;
    const nativeDiagnostics: string[] = [];
    const f = await fixture(false, () => { if (scheduled && !idle) blocked.resolve('blocked'); return idle; });
    const volumes = [join(f.home, 'scan-a'), join(f.home, 'scan-b')];
    for (const volume of volumes) { await fs.mkdir(volume); await fs.writeFile(join(volume, 'bytes'), Buffer.alloc(4096, 7)); }
    f.setIdlePower(true, true); f.setPolicy({ wholeDiskEnabled: true });
    const service = createStorageService({ machineId: 'machine', homeDir: f.home, custodianAccountId: 'custodian', activityLog: f.activityLog,
      catalog: { happyHomeDir: f.home, activeServerDir: f.home, tempRoot: join(f.home, 'absent-temp'), readProjects: () => ({ status: 'ready', projects: [] }) },
      readPolicy: f.readPolicy, subscribeChanges: f.subscribePolicy,
      readVolumes: () => volumes.map((mount, index) => ({ id: `volume-${index}`, label: `Volume ${index}`, mount, totalBytes: 1_000_000, availableBytes: 500_000 })),
      maintenance: { subscribePolicy: f.subscribePolicy, subscribeVolumes: f.subscribeVolumes, isIdle: f.isIdle, subscribeIdle: f.subscribeIdle,
        isOnPower: () => { const onPower = f.isOnPower(); if (!onPower) powerChecked.resolve(); return onPower; },
        subscribePower: f.subscribeIdle, logs: f.logs, recordings: f.recordings,
        activityLog: f.activityLog, actorAccountId: 'custodian', onError: error => f.errors.push(error) } });
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const spawn = vi.mocked(childProcess.spawn);
    // Decorate the real native process boundary: its first scheduled close produces
    // a canonical busy edge before the next queued volume is admitted.
    spawn.mockImplementation(((...args: unknown[]) => {
      const child = Reflect.apply(actual.spawn, undefined, args) as ReturnType<typeof childProcess.spawn>;
      child.stderr?.on('data', (bytes: Buffer) => nativeDiagnostics.push(bytes.toString()));
      child.stdout?.on('data', (bytes: Buffer) => nativeDiagnostics.push(bytes.toString()));
      if (scheduled && Array.isArray(args[1]) && args[1].includes('disk-scan')) {
        nativeScans++;
        if (!idle) blocked.resolve('second_native');
        child.once('close', () => {
          if (closeMakesBusy) { closeMakesBusy = false; idle = false; f.setIdlePower(false, true); }
          else secondComplete.resolve();
        });
      }
      return child;
    }) as typeof childProcess.spawn);
    try {
      await service.initialize();
      const scanFor = async (volumeId: string) => (await service.summary()).wholeDisk.scans.find(state =>
        'volumeId' in state.target && state.target.volumeId === volumeId);
      expect((await service.summary()).wholeDisk.scans).toEqual([]);
      const schedule = () => { const due = new Date(Date.now() + 60_000); return { weekday: due.getDay(),
        time: `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`, onlyOnPower: true as const }; };
      const armed = createDeferred<void>(); clockBoundary.onArm = () => armed.resolve();
      f.setPolicy({ scheduledScan: schedule() }); await armed.promise; clockBoundary.onArm = undefined;
      scheduled = true; closeMakesBusy = true;
      const passRearmed = createDeferred<void>(); clockBoundary.onArm = () => passRearmed.resolve();
      await vi.advanceTimersByTimeAsync(60_000);
      await passRearmed.promise; clockBoundary.onArm = undefined;
      expect(await scanFor('volume-0'), nativeDiagnostics.join('')).toBeDefined();
      expect(await blocked.promise).toBe('blocked');
      expect(await scanFor('volume-1')).toBeUndefined();
      idle = true; f.setIdlePower(true, false);
      // A fresh power decision must still hold the queued second volume.
      await powerChecked.promise;
      expect(await scanFor('volume-1')).toBeUndefined();
      f.setIdlePower(true, true); await secondComplete.promise;
      const after = (await service.summary()).wholeDisk.scans;
      expect(after.find(state => 'volumeId' in state.target && state.target.volumeId === 'volume-1')).toBeDefined();
      // A later due pass is held again, then policy-off retires pending admission.
      secondComplete = createDeferred(); blocked = createDeferred<'blocked' | 'second_native'>(); powerChecked = createDeferred(); idle = true; closeMakesBusy = true;
      const rearmed = createDeferred<void>(); clockBoundary.onArm = () => rearmed.resolve();
      f.setPolicy({ scheduledScan: schedule() }); await rearmed.promise; clockBoundary.onArm = undefined;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await blocked.promise).toBe('blocked');
      const scansBeforeDisable = nativeScans;
      f.setPolicy({ wholeDiskEnabled: false }); idle = true; f.setIdlePower(true, true);
      await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
      expect((await service.summary()).wholeDisk).toEqual({ enabled: false, scans: [] });
      expect(nativeScans).toBe(scansBeforeDisable);
    } finally { clockBoundary.onArm = undefined; service.dispose(); f.maintenance.stop(); spawn.mockImplementation(actual.spawn); }
  });

  it.skipIf(process.platform === 'win32')('does not start permission-repair effects after the admitted deletion is refused and maintenance stops', async () => {
    const f = await fixture(); const path = join(f.home, 'permission-retry'); await fs.mkdir(path); await fs.chmod(path, 0o500);
    let running = true;
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.rm).mockImplementation(async (...args) => {
      if (args[0] === path) { running = false; throw Object.assign(new Error('OS refused deletion'), { code: 'EACCES' }); }
      return actual.rm(...args);
    });
    try {
      await expect(removeStoragePath(path, { allowedRoot: f.home, expectedIdentity: await readStoragePathIdentity(path), beforeEffect: async () => {
        if (!running) throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
      } })).rejects.toMatchObject({ name: 'AbortError' });
      expect((await fs.lstat(path)).mode & 0o777).toBe(0o500);
    } finally { vi.mocked(fs.rm).mockImplementation(actual.rm); await fs.chmod(path, 0o700); f.maintenance.stop(); }
  });

  it('runs cheap startup cleanup while busy, across Accounts, and emits one housekeeping line without a rail signal', async () => {
    const f = await fixture();
    const current = await f.writeLog('current.log', 40);
    const old = await f.writeLog('old.log', 40);
    const crashLog = await f.writeLog('2020-pid-999993.log', 40);
    await fs.mkdir(join(f.logDir, 'session-exit')); await fs.writeFile(join(f.logDir, 'session-exit', 'crash.json'), JSON.stringify({ pid: 999993, code: 1, observedAt: Date.now() }));
    for (const root of storageLogRoots(f.home).slice(1)) await f.writeLog('old.log', 40, root);
    const movedAt = Date.now() - 8 * day; vi.setSystemTime(movedAt);
    for (const accountId of ['alice', 'bob']) {
      const path = join(f.home, `${accountId}-cache`); await fs.mkdir(path); await fs.writeFile(join(path, 'bytes'), Buffer.alloc(4096, 9));
      await (await f.store.prepare({ path, title: 'Cache', batchId: accountId, size, movedBy: { accountId, kind: 'person' } })).commit();
    }
    vi.setSystemTime(movedAt + 8 * day);
    expect((await f.store.empty({}, { actorAccountId: 'mallory', custodianAccountId: 'custodian' })).outcomes.every(row => row.status === 'refused')).toBe(true);
    await f.maintenance.start();
    expect(await f.store.list()).toEqual([]); await expect(fs.lstat(old)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(current)).toHaveLength(4096); expect(await fs.readFile(crashLog)).toHaveLength(4096);
    const housekeeping = (await f.activityLog.list({ range: 'today' })).entries.filter(row => row.kind === 'housekeeping');
    expect(housekeeping).toHaveLength(1); expect(housekeeping[0]).toMatchObject({ subject: { logs: storageLogRoots(f.home).length, trashEntries: 2 }, freedBytes: expect.any(Number) });
    expect(housekeeping[0].freedBytes).toBeGreaterThan(0); expect(f.automatic).toEqual([]);
    await f.maintenance.requestPass(); expect((await f.activityLog.list({ range: 'today' })).entries.filter(row => row.kind === 'housekeeping')).toHaveLength(1);
    expect(f.errors).toEqual([]); f.maintenance.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it('rearms existing Never Trash on a policy edge, then empties at the new deadline', async () => {
    const f = await fixture(); f.setPolicy({ trashEmptyAfterDays: null, logRetentionDays: null });
    const path = join(f.home, 'retained'); await fs.mkdir(path); await fs.writeFile(join(path, 'bytes'), 'retained');
    const entry = await (await f.store.prepare({ path, title: 'Retained', batchId: 'never', size, movedBy: { accountId: 'other', kind: 'person' } })).commit();
    await f.maintenance.start(); expect(vi.getTimerCount()).toBe(0);
    f.setPolicy({ trashEmptyAfterDays: 1 }); await f.maintenance.requestPass();
    expect((await f.store.read(entry.entryId))?.emptiesAt).toBe(entry.movedAt + day); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(day); await f.maintenance.requestPass(); expect(await f.store.list()).toEqual([]);
    f.maintenance.stop();
  });

  it('holds a due scan for idle and on-power edges without polling or delaying cheap file expiry', async () => {
    const f = await fixture(); const at = new Date(Date.now() + 60_000);
    f.setPolicy({ wholeDiskEnabled: true, scheduledScan: { weekday: at.getDay(), time: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`, onlyOnPower: true }, logRetentionDays: 1 });
    const path = await f.writeLog('due.log', 1 - 60_000 / day);
    await f.maintenance.start(); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000); await f.maintenance.requestPass();
    await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' }); expect(f.scans).toBe(0); expect(vi.getTimerCount()).toBe(0);
    f.setIdlePower(true, false); await f.maintenance.requestPass(); expect(f.scans).toBe(0);
    f.setIdlePower(true, true); await f.maintenance.requestPass(); expect(f.scans).toBe(1); expect(vi.getTimerCount()).toBe(1);
    f.maintenance.stop();
  });

  it('steps platform-long delays without running a periodic pass', async () => {
    const f = await fixture(); const path = await f.writeLog('future.log', 0); await f.maintenance.start();
    expect(vi.getTimerCount()).toBe(1); await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(vi.getTimerCount()).toBe(1); expect(await fs.readFile(path)).toHaveLength(4096);
    expect((await f.activityLog.list({ range: '30d' })).entries).toEqual([]);
    await vi.advanceTimersByTimeAsync(30 * day - 2_147_483_647); await f.maintenance.requestPass();
    await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' }); f.maintenance.stop();
  });

  it('does not admit a scheduled effect when stopped during the fresh asynchronous activity decision', async () => {
    const entered = createDeferred<void>(); const idle = createDeferred<boolean>();
    const f = await fixture(false, () => { entered.resolve(); return idle.promise; });
    const at = new Date(Date.now()); f.setIdlePower(true, true);
    f.setPolicy({ logRetentionDays: null, wholeDiskEnabled: true, scheduledScan: { weekday: at.getDay(),
      time: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`, onlyOnPower: true } });
    const starting = f.maintenance.start(); await entered.promise;
    f.maintenance.stop(); idle.resolve(true); await starting;
    expect(f.scans).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('records already-deleted log bytes after stop without deleting the next file or admitting a scan', async () => {
    const f = await fixture(); const first = await f.writeLog('z-first.log', 40); const second = await f.writeLog('a-second.log', 40);
    const at = new Date(Date.now()); f.setIdlePower(true, true);
    f.setPolicy({ wholeDiskEnabled: true, scheduledScan: { weekday: at.getDay(),
      time: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`, onlyOnPower: true } });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.rm).mockImplementation(async (path, options) => {
      await actual.rm(path, options);
      if (path === first) f.maintenance.stop();
    });
    try {
      await f.maintenance.start();
      await expect(fs.lstat(first)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await fs.readFile(second)).toHaveLength(4096);
      const rows = (await f.activityLog.list({ range: 'today' })).entries.filter(row => row.kind === 'housekeeping');
      expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ subject: { logs: 1, recordings: 0, trashEntries: 0 } });
      expect(rows[0].freedBytes).toBeGreaterThan(0); expect(f.scans).toBe(0); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.mocked(fs.rm).mockImplementation(actual.rm); f.maintenance.stop(); }
  });

  it('rearms from a new actual recording expiry and reports actual freed allocated bytes', async () => {
    const f = await fixture(true); f.setPolicy({ logRetentionDays: null, trashEmptyAfterDays: null });
    await f.maintenance.start(); expect(vi.getTimerCount()).toBe(0);
    const path = await f.writeRecording(Date.now() + 60_000); await f.maintenance.requestPass();
    expect(vi.getTimerCount()).toBe(1); expect(await fs.readFile(path)).toHaveLength(4104);
    await vi.advanceTimersByTimeAsync(60_000); await f.maintenance.requestPass();
    await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    const line = (await f.activityLog.list({ range: 'today' })).entries.find(row => row.kind === 'housekeeping');
    expect(line).toMatchObject({ subject: { recordings: 1 } }); expect(line?.freedBytes).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0); expect(f.errors).toEqual([]); f.maintenance.stop();
  });

  it('recovers the pass queue after the actual Activity file boundary rejects an append', async () => {
    const f = await fixture(); await f.writeLog('first.log', 40);
    const activity = join(f.home, 'machine-guard'); await fs.rename(activity, `${activity}-saved`); await fs.writeFile(activity, 'blocked');
    await expect(f.maintenance.start()).rejects.toThrow();
    await fs.unlink(activity); await fs.rename(`${activity}-saved`, activity);
    const second = await f.writeLog('second.log', 40);
    await expect(f.maintenance.requestPass()).resolves.toBeUndefined();
    await expect(fs.lstat(second)).rejects.toMatchObject({ code: 'ENOENT' }); f.maintenance.stop();
  });

  it('does not lose a policy edge during the awaited real Trash reconciliation', async () => {
    const f = await fixture(); await f.writeLog('old.log', 40); const future = await f.writeLog('young.log', 2);
    const path = join(f.home, 'pending-receipt'); await fs.mkdir(path); await fs.writeFile(join(path, 'bytes'), 'retained');
    const prepared = await f.store.prepare({ path, title: 'Pending receipt', batchId: 'recovery', size,
      movedBy: { accountId: 'custodian', kind: 'person' } });
    // Fail the real Activity filesystem boundary after retirement commits, so
    // reconciliation has a genuine receipt change to publish during its pass.
    const activity = join(f.home, 'machine-guard'); await fs.rename(activity, `${activity}-saved`); await fs.writeFile(activity, 'blocked');
    await expect(prepared.commit()).rejects.toThrow();
    await fs.unlink(activity); await fs.rename(`${activity}-saved`, activity);
    let changed = false;
    const release = f.store.subscribe(() => {
      if (!changed) { changed = true; f.setPolicy({ logRetentionDays: 1 }); }
    });
    await f.maintenance.start(); release();
    await expect(fs.lstat(future)).rejects.toMatchObject({ code: 'ENOENT' }); f.maintenance.stop();
  });
});
