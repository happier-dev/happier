import { randomUUID } from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';
import type { MachineStoragePolicyV1 } from '@happier-dev/protocol/storage/storageV1';
import type { ActivityLog } from '@/daemon/guard/activityLog';
import type { BrowserRecordingDaemonService } from '../../daemon/recording/service';
import type { LogRetentionPassResult } from '@/utils/logs/logRetention';
import type { TrashStore } from '../trash/trashStore';
import { storagePolicyUnavailableError } from '../storagePolicy';

type Subscribe = (listener: () => void) => () => void;
export type StorageMaintenanceDeps = Readonly<{
  /** Undefined while the Machine policy is unknown (loading, locked, offline): every policy effect waits for its edge. */
  readPolicy(): MachineStoragePolicyV1 | undefined;
  subscribePolicy: Subscribe;
  subscribeVolumes: Subscribe;
  isIdle(): boolean | Promise<boolean>;
  subscribeIdle: Subscribe;
  isOnPower(): boolean;
  subscribePower: Subscribe;
  getTrashStore(): Promise<TrashStore>;
  logs: Readonly<{ run(days: number | null, nowMs: number, input?: Readonly<{ beforeEffect?: () => Promise<void> }>): Promise<LogRetentionPassResult> }>;
  recordings: Pick<BrowserRecordingDaemonService, 'nextExpiryAtMs' | 'cleanupExpiredRecordings' | 'subscribeStorageChanges' | 'listStorageRecordings'>;
  runScheduledScan(): Promise<void>;
  activityLog: Pick<ActivityLog, 'append'>;
  actorAccountId: string;
  onError(error: unknown): void;
  nowMs?: () => number;
}>;

// Node timers use a signed 32-bit millisecond delay on every supported platform.
// Longer policy dates advance through this platform boundary, never a shorter policy cap.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
function scheduledAt(policy: MachineStoragePolicyV1, nowMs: number): number | null {
  if (!policy.wholeDiskEnabled || !policy.scheduledScan) return null;
  const [hour, minute] = policy.scheduledScan.time.split(':').map(Number);
  const date = new Date(nowMs);
  date.setHours(hour, minute, 0, 0);
  date.setDate(date.getDate() + (policy.scheduledScan.weekday - date.getDay() + 7) % 7);
  if (date.getTime() < nowMs) date.setDate(date.getDate() + 7);
  return date.getTime();
}

/** The daemon's sole retention/scheduled-scan timer; storage sizing remains demand-driven. */
export function createStorageMaintenance(deps: StorageMaintenanceDeps) {
  const now = deps.nowMs ?? Date.now;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let store: TrashStore | undefined;
  let subscriptions: (() => void)[] = [];
  let pending: Promise<void> = Promise.resolve();
  let requested = false;
  let inPass = false;
  let scheduleKey: string | undefined;
  let nextScanAt: number | null = null;

  function clearTimer() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function arm(dueAt: number | null) {
    clearTimer();
    if (!running || dueAt === null) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!running) return;
      if (now() < dueAt) arm(dueAt);
      else void requestPass().catch(deps.onError);
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, dueAt - now())));
    // Cross-package timer declarations also admit numeric browser/test handles.
    // Narrow the external handle while preserving Node's real unref operation.
    const timerHandle: unknown = timer;
    if (timerHandle !== null && typeof timerHandle === 'object' && 'unref' in timerHandle && typeof timerHandle.unref === 'function') timerHandle.unref();
  }
  const changed = () => { if (running) void requestPass().catch(deps.onError); };
  // This store emits for reconciliation too. Its own writes are reread below rather
  // than scheduling another pass indefinitely; external owner edges still coalesce.
  const trashChanged = () => { if (running && !inPass) void requestPass().catch(deps.onError); };
  const beforeEffect = async () => {
    if (!running) throw Object.assign(new Error('Storage maintenance stopped'), { name: 'AbortError' });
    if (!deps.readPolicy()) throw storagePolicyUnavailableError();
  };

  async function pass() {
    inPass = true;
    const policy = deps.readPolicy();
    // Retention, Trash emptying, log pruning and scheduled scans act on the
    // user's policy only. Unknown policy is not a default; subscribePolicy wakes us.
    if (!policy) { clearTimer(); return; }
    const at = now();
    const key = JSON.stringify([policy.wholeDiskEnabled, policy.scheduledScan]);
    if (key !== scheduleKey) { scheduleKey = key; nextScanAt = scheduledAt(policy, at); }
    const counts = { logs: 0, recordings: 0, trashEntries: 0 };
    let freedBytes = 0;
    async function recordHousekeeping() {
      if (counts.logs || counts.recordings || counts.trashEntries) {
        await deps.activityLog.append({ v: 1, id: randomUUID(), at, kind: 'housekeeping', rule: 'housekeeping',
          subject: { kind: 'housekeeping', ...counts }, freedBytes, outcome: 'done', attribution: { kind: 'unknown' } });
      }
    }
    let nextLogAt: number | null = null;
    let entries: Awaited<ReturnType<TrashStore['list']>> = [];
    try {
      store ??= await deps.getTrashStore();
      if (!running) return;
      if (!subscriptions.some(release => release === releaseTrash)) {
        releaseTrash = store.subscribe(trashChanged); subscriptions.push(releaseTrash);
      }
      await store.reconcile({ canRunOwnerOperation: deps.isIdle, beforeEffect });
      if (!running) return;
      await store.refreshRetention(policy.trashEmptyAfterDays, { beforeEffect });
      if (!running) return;
      entries = await store.list();
      const due = entries.filter(entry => entry.emptiesAt !== null && entry.emptiesAt <= at);
      if (due.length) {
        const result = await store.empty({ entryIds: due.map(entry => entry.entryId) }, { scheduled: true,
          actorAccountId: deps.actorAccountId, custodianAccountId: deps.actorAccountId, canRunOwnerOperation: deps.isIdle, assertCurrentAuthority: beforeEffect });
        counts.trashEntries = result.outcomes.filter(outcome => outcome.status === 'deleted').length;
        freedBytes += result.freedBytes;
        for (const outcome of result.outcomes) if (outcome.status === 'failed') deps.onError(Object.assign(new Error('Trash maintenance failed'), { outcome }));
      }
      entries = await store.list();
    } catch (error) { deps.onError(error); }
    if (!running) { await recordHousekeeping(); return; }
    try {
      const result = await deps.logs.run(policy.logRetentionDays, at, { beforeEffect });
      counts.logs = result.pruned; freedBytes += result.freedBytes; nextLogAt = result.nextDueAtMs;
    } catch (error) { deps.onError(error); }
    if (!running) { await recordHousekeeping(); return; }
    try {
      const dueRecordings = deps.recordings.listStorageRecordings().filter(recording => !recording.active && recording.expiresAtMs !== undefined && recording.expiresAtMs <= at);
      let measured = new Map<string, number>();
      if (dueRecordings.length) {
        const { measureNativeDisk } = await import('../measure/nativeDiskMeasure');
        const result = await measureNativeDisk({ paths: dueRecordings.map(recording => recording.path) });
        measured = new Map(result.perPath.map(path => [path.path, path.exclusiveBytes]));
      }
      await beforeEffect();
      const result = await deps.recordings.cleanupExpiredRecordings({ nowMs: at, beforeEffect });
      counts.recordings = result.discardedRecordingIds.length;
      const discarded = new Set(result.discardedRecordingIds);
      for (const recording of dueRecordings) if (discarded.has(recording.recordingId)) freedBytes += measured.get(recording.path) ?? 0;
      if (result.failedRecordingIds.length) deps.onError(Object.assign(new Error('Recording expiry failed'), { recordingIds: result.failedRecordingIds }));
    } catch (error) { deps.onError(error); }
    if (!running) { await recordHousekeeping(); return; }
    let receiptFailure: Readonly<{ error: unknown }> | undefined;
    try { await recordHousekeeping(); } catch (error) { receiptFailure = { error }; }
    if (nextScanAt !== null && nextScanAt <= now() && await deps.isIdle() && running && deps.isOnPower()) {
      const current = deps.readPolicy();
      if (current?.wholeDiskEnabled && JSON.stringify([current.wholeDiskEnabled, current.scheduledScan]) === scheduleKey) {
        try { await deps.runScheduledScan(); nextScanAt = scheduledAt(current, now() + 1); }
        catch (error) { deps.onError(error); }
      }
    }
    // A concurrent committed Trash mutation may have happened during log/recording
    // awaits; this final read consumes it without reacting to our own notifications.
    if (store) { try { entries = await store.list(); } catch (error) { deps.onError(error); } }
    const candidates = [nextLogAt, deps.recordings.nextExpiryAtMs(), ...entries.map(entry => entry.emptiesAt),
      nextScanAt !== null && nextScanAt > now() ? nextScanAt : null].filter((due): due is number => due !== null && due > now());
    // Failed/blocked due work waits for a canonical change edge, not a retry interval or a zero-delay loop.
    arm(deps.readPolicy() ? candidates.reduce<number | null>((first, due) => first === null ? due : Math.min(first, due), null) : null);
    if (receiptFailure) throw receiptFailure.error;
  }
  let releaseTrash: (() => void) | undefined;
  function requestPass(): Promise<void> {
    requested = true;
    if (inPass) return pending;
    // The failed caller still sees its rejection; the next requested pass starts
    // from settlement rather than inheriting a permanently rejected queue.
    pending = pending.catch(() => {}).then(async () => {
      while (running && requested) {
        requested = false;
        try { await pass(); } finally { inPass = false; }
      }
    });
    return pending;
  }
  return {
    async start(): Promise<void> {
      if (running) return pending;
      running = true;
      subscriptions = [deps.subscribePolicy(changed), deps.subscribeVolumes(changed), deps.subscribeIdle(changed),
        deps.subscribePower(changed), deps.recordings.subscribeStorageChanges(changed)];
      await requestPass();
    },
    stop() { running = false; clearTimer(); for (const release of subscriptions) release(); subscriptions = []; releaseTrash = undefined; },
    requestPass,
  };
}
export type StorageMaintenance = ReturnType<typeof createStorageMaintenance>;
