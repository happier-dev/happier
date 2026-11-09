import type { MachineGuardPolicyV1 } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import type { MachineGuardStateV1 } from '@happier-dev/protocol/machines/guard/guardStateV1';
import type { MachineGuardActivityEntryV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import type { OwnerRowV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { readSessionMemoryCeilingOverride } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import type { TrackedSession } from '../../types';
import type { SessionGuardMemoryObservationV1 } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import type { HappierProcessRoot } from '../../processes/ownership/types';
import type { SessionEligibility } from '../../guard/sessionEligibility';
import type { ActivityLog } from '../../guard/activityLog';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { posix } from 'node:path';
import { equalProcessStart } from '../../processes/ownership/types';
import { setGuardSessionMemoryHigh, sessionScopeExitEvidencePath } from './systemdUserResourceGovernor';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { readGuardSessionTitle } from '../../guard/readGuardSessionTitle';

export type SessionMemoryCeilingTarget = Readonly<{
  tracked: TrackedSession; root: HappierProcessRoot; label: string | null;
  attribution: MachineGuardActivityEntryV1['attribution'];
  metadata: Readonly<Record<string, unknown>>;
}>;
export type SessionMemoryCeilingInput = Readonly<{
  activeServerDir: string;
  capability: MachineGuardStateV1['capabilities']['ceiling'];
  readPolicy(): MachineGuardPolicyV1;
  readSessions(signal?: AbortSignal): Promise<readonly SessionMemoryCeilingTarget[]>;
  /** Cheap activation hint from the incumbent tracked runner/metadata owner, not metadata authority. */
  hasSessionOverrides?: () => boolean;
  readEligibility(tracked: TrackedSession, signal: AbortSignal): Promise<SessionEligibility>;
  stopSession(sessionId: string, tracked: TrackedSession): Promise<boolean>;
  onSessionStopRecorded?: (tracked: TrackedSession) => Promise<void>;
  notice(tracked: TrackedSession, state: Readonly<{ kind: 'stopped'; at: number; rule: 'ceiling'; ceilingBytes: number } | { kind: 'clear' }>, signal: AbortSignal): Promise<boolean>;
  /** Original requester transport lifetime; policy cancellation must not cancel withdrawing its own intent. */
  clearNotice?: (tracked: TrackedSession) => Promise<boolean>;
  notify(input: Readonly<{ kind: 'ceiling_near' | 'ceiling_reached'; sessionId: string; memory?: SessionGuardMemoryObservationV1 }>): Promise<void>;
  activityLog: ActivityLog;
  nowMs?: () => number;
  native?: Readonly<{
    readFile(path: string, encoding: 'utf8'): Promise<string>;
    writeFile(path: string, value: string): Promise<void>;
    watch(path: string, listener: () => void, onError: (error: Error) => void): Readonly<{ close(): void }>;
    setProperty(unit: string, bytes: number | null): Promise<void>;
    cgroupRoot?: string;
  }>;
}>;

const ScopeExitStoredSchema = createStoredReadSchema(z.strictObject({
  v: z.literal(1), unit: z.string(), path: z.optional(z.string()), status: z.enum(['captured', 'unavailable']),
  oom: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  oomKill: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
}));
const SESSION_OOM_EXPLANATION = 'This Session ran out of memory.';

type Scope = Readonly<{ path: string; unit: string; systemd: boolean }>;
type Edge = 'high' | 'near' | 'oom';
type PendingEdge = { kind: Edge; bytes: number | null; memory?: SessionGuardMemoryObservationV1; entry?: MachineGuardActivityEntryV1; recorded?: boolean; notified?: boolean; stopRecorded?: boolean; clearTracked?: TrackedSession };
type Runner = {
  target: SessionMemoryCeilingTarget; scope: Scope; watcher: Readonly<{ close(): void }>;
  high: number; oom: number; dirty: boolean; highHandled: boolean;
  notified: Set<number>; pending: PendingEdge[]; appliedBytes?: number | null; ceilingBytes: number | null;
  error?: Error;
  observedSince: number; throttles: Array<{ at: number; count: number }>;
  usage?: Readonly<{ usedBytes: number; observedAtMs: number }>;
};

// The Processes detail promises the kernel's throttle count over the last five minutes.
const THROTTLE_WINDOW_MS = 5 * 60_000;

function readCounters(value: string): Readonly<{ high: number; oom: number }> {
  const counter = (key: string) => {
    const raw = new RegExp(`^${key} ([0-9]+)$`, 'm').exec(value)?.[1];
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Session memory counters unavailable');
    return parsed;
  };
  return { high: counter('high'), oom: counter('oom_kill') };
}

export function resolveSessionMemoryCeilingBytes(metadata: unknown, policy?: MachineGuardPolicyV1): number | null {
  const override = readSessionMemoryCeilingOverride(metadata);
  return override !== undefined ? override : policy?.sessionMemoryCeiling.bytes ?? null;
}

export function createSessionMemoryCeiling(input: SessionMemoryCeilingInput) {
  const listeners = new Set<() => void>();
  const runners = new Map<string, Runner>();
  const oomRecorded = new WeakSet<TrackedSession>();
  const exitObservations = new WeakMap<TrackedSession, Readonly<{ entry: MachineGuardActivityEntryV1; path: string }>>();
  const native = input.native ?? {
    readFile, writeFile,
    watch: (path: string, listener: () => void, onError: (error: Error) => void) => {
      const watcher = watch(path, { persistent: false }, listener);
      watcher.on('error', onError); return watcher;
    },
    setProperty: (unit: string, bytes: number | null) => setGuardSessionMemoryHigh({ unit, bytes }),
    cgroupRoot: '/sys/fs/cgroup',
  };
  const now = input.nowMs ?? Date.now;
  let stopped = false;
  let tick = false;
  const changed = () => { if (!stopped) for (const listener of [...listeners]) listener(); };
  const key = (target: SessionMemoryCeilingTarget) => `${target.tracked.happySessionId}:${target.root.pid}:${target.root.start.startTimeMs}:${target.root.start.native ?? ''}:${target.root.containment?.kind === 'linux_unit' ? target.root.containment.prefix : ''}`;
  const enabled = (policy: MachineGuardPolicyV1) => !stopped && input.capability.status === 'available'
    && (policy.sessionMemoryCeiling.bytes !== null || input.hasSessionOverrides?.() === true || runners.size > 0);
  const joinExitCapture = async (tracked: TrackedSession, path: string, initial: string): Promise<string> => {
    const launcher = tracked.childProcess;
    const incomplete = (raw: string) => { try { JSON.parse(raw); return false; } catch { return true; } };
    if (!launcher || launcher.exitCode !== null || launcher.signalCode !== null || !incomplete(initial)) return initial;
    // Runner liveness can report exit before scope-exec finishes its one write. Join that
    // native file event, not the scope becoming empty; surviving descendants may keep it live.
    return await new Promise(resolve => {
      let done = false;
      let watcher: Readonly<{ close(): void }> | undefined;
      const finish = (raw: string) => {
        if (done) return;
        done = true; watcher?.close(); launcher.off('exit', onExit); resolve(raw);
      };
      const read = async (exited = false) => {
        if (done) return;
        try {
          const raw = await native.readFile(path, 'utf8');
          if (exited || launcher.exitCode !== null || launcher.signalCode !== null || !incomplete(raw)) finish(raw);
        } catch { finish(initial); }
      };
      const onExit = () => { void read(true); };
      launcher.once('exit', onExit);
      try { watcher = native.watch(path, () => { void read(); }, () => { finish(initial); }); }
      catch { finish(initial); }
      // Re-read after subscription to close the capture/subscription race.
      void read();
    });
  };
  const scopeFor = (target: SessionMemoryCeilingTarget): Scope | null => {
    const root = target.root;
    const prefix = root.containment?.kind === 'linux_unit' ? root.containment.prefix : undefined;
    const id = target.tracked.happySessionId;
    const runnerPid = target.tracked.sessionRunnerPid ?? target.tracked.pid;
    const runnerBirth = target.tracked.runnerProcessIdentity?.pid === runnerPid
      ? target.tracked.runnerProcessIdentity.processStartTimeMs
      : runnerPid === target.tracked.pid ? target.tracked.processStartTimeMs : undefined;
    if (!root.live || !id || root.owner.kind !== 'session' || root.owner.sessionId !== id
      || root.pid !== runnerPid || runnerBirth === undefined || runnerBirth !== root.start.startTimeMs
      || !prefix?.startsWith('/') || prefix.split('/').some(part => part === '..' || part === '.')) return null;
    // The root owner joins physical launch custody to this Session and runner generation.
    // A fresh launch unit need not encode the subsequently accepted Session identity.
    const unit = posix.basename(prefix);
    return { path: posix.join(native.cgroupRoot ?? '/sys/fs/cgroup', prefix), unit,
      systemd: posix.basename(posix.dirname(prefix)) === 'happier-jobs.slice' };
  };
  const same = (a: SessionMemoryCeilingTarget, b: SessionMemoryCeilingTarget) => a.tracked === b.tracked
    && a.root.pid === b.root.pid && equalProcessStart(a.root.start, b.root.start)
    && scopeFor(a)?.path === scopeFor(b)?.path;
  const applyNative = async (scope: Scope, bytes: number | null, signal?: AbortSignal) => {
    signal?.throwIfAborted(); if (stopped) throw new Error('Session ceiling owner stopped');
    if (scope.systemd) await native.setProperty(scope.unit, bytes);
    else await native.writeFile(posix.join(scope.path, 'memory.high'), `${bytes ?? 'max'}\n`);
  };
  const current = async (target: SessionMemoryCeilingTarget, signal: AbortSignal) => {
    signal.throwIfAborted();
    const found = (await input.readSessions(signal)).find(item => same(item, target));
    signal.throwIfAborted(); return !stopped && found && scopeFor(found) ? found : undefined;
  };
  const attachRunner = async (target: SessionMemoryCeilingTarget, scope: Scope, bytes: number, signal?: AbortSignal) => {
    const counters = readCounters(await native.readFile(posix.join(scope.path, 'memory.events'), 'utf8'));
    signal?.throwIfAborted(); if (stopped) throw new Error('Session ceiling owner stopped');
    const runner: Runner = { target, scope, high: counters.high, oom: counters.oom, dirty: true, highHandled: false,
      notified: new Set(), pending: [], ceilingBytes: bytes, watcher: { close() {} }, observedSince: now(), throttles: [] };
    runner.watcher = native.watch(posix.join(scope.path, 'memory.events'), () => { runner.dirty = true; changed(); },
      error => { runner.error = error; changed(); });
    runners.set(key(target), runner); return runner;
  };
  const record = (runner: Runner, kind: MachineGuardActivityEntryV1['kind'], rule: 'ceiling' | 'system',
    outcome: MachineGuardActivityEntryV1['outcome'], note?: string, wayBack?: MachineGuardActivityEntryV1['wayBack']) => {
    return { v: 1, id: randomUUID(), at: now(), kind, rule, outcome,
      attribution: runner.target.attribution,
      subject: { kind: 'session', sessionId: runner.target.tracked.happySessionId!, title: runner.target.label },
      ...(note ? { note } : {}), ...(wayBack ? { wayBack } : {}) } satisfies MachineGuardActivityEntryV1;
  };
  const runEdge = async (runner: Runner, pending: PendingEdge, signal: AbortSignal): Promise<void> => {
    // A confirmed native effect is a fact to commit, not a decision cancellation may withdraw.
    if (pending.entry?.kind !== 'stopped_session') { signal.throwIfAborted(); if (stopped) return; }
    const edge = pending.kind;
    if (pending.entry) {
      if (pending.clearTracked) {
        const cleared = input.clearNotice ? await input.clearNotice(pending.clearTracked) : await input.notice(pending.clearTracked, { kind: 'clear' }, signal);
        if (!cleared) throw new Error('Session stop marker clear unavailable');
        pending.clearTracked = undefined;
      }
      if (!pending.recorded) {
        if (edge !== 'oom' || !oomRecorded.has(runner.target.tracked)) await input.activityLog.append(pending.entry);
        pending.recorded = true;
        if (edge === 'oom') oomRecorded.add(runner.target.tracked);
      }
      if (pending.entry.kind === 'stopped_session' && !pending.stopRecorded) { await input.onSessionStopRecorded?.(runner.target.tracked); pending.stopRecorded = true; }
      if (edge !== 'oom' && !pending.notified) { await input.notify({ kind: edge === 'near' ? 'ceiling_near' : 'ceiling_reached', sessionId: runner.target.tracked.happySessionId!,
        ...(pending.memory ? { memory: pending.memory } : {}) }); pending.notified = true; }
      if (edge === 'near' && pending.bytes !== null) runner.notified.add(pending.bytes);
      return;
    }
    if (edge === 'oom') { pending.entry = record(runner, 'system_oom_kill', 'system', 'done', SESSION_OOM_EXPLANATION); return runEdge(runner, pending, signal); }
    const target = await current(runner.target, signal);
    if (!target || runner.ceilingBytes === null || runner.ceilingBytes !== pending.bytes) return;
    const override = readSessionMemoryCeilingOverride(target.metadata);
    if (override !== undefined && override !== pending.bytes) return;
    const sessionId = target.tracked.happySessionId!;
    if (edge === 'near') {
      pending.entry = { ...record(runner, 'ceiling_near', 'ceiling', 'done'), ...(pending.memory ? { memory: pending.memory } : {}) };
      return runEdge(runner, pending, signal);
    }
    let reason: string | undefined;
    try {
      const marked = await input.notice(target.tracked, { kind: 'stopped', at: now(), rule: 'ceiling', ceilingBytes: runner.ceilingBytes }, signal);
      if (marked) pending.clearTracked = target.tracked; else reason = 'notice_unavailable';
      signal.throwIfAborted(); if (stopped) return;
      if (reason) pending.entry = record(runner, 'ceiling_reached', 'ceiling', 'done', reason);
      else {
        let didStop = false;
        try {
          if (!pending.notified) { await input.notify({ kind: 'ceiling_reached', sessionId }); pending.notified = true; }
          signal.throwIfAborted();
          const admitted = await current(target, signal);
          if (!admitted) reason = 'identity_changed';
          else if (runner.ceilingBytes !== pending.bytes
            || resolveSessionMemoryCeilingBytes(admitted.metadata, input.readPolicy()) !== pending.bytes) reason = 'ceiling_changed';
          else {
            // Notice and notification may await transport. Only this final
            // exact-runner admission can authorize the subsequent native stop.
            const eligibility = await input.readEligibility(admitted.tracked, signal);
            if (!eligibility.eligible) reason = eligibility.reasons[0]?.kind ?? 'activity_unknown';
          }
          signal.throwIfAborted();
          if (!reason && admitted && (runner.ceilingBytes !== pending.bytes
            || resolveSessionMemoryCeilingBytes(admitted.metadata, input.readPolicy()) !== pending.bytes)) reason = 'ceiling_changed';
          if (!reason) didStop = await input.stopSession(sessionId, target.tracked);
        }
        catch (error) { if (signal.aborted && error === signal.reason) throw error; didStop = false; }
        if (didStop) pending.clearTracked = undefined;
        else if (!reason) await target.tracked.guardStopReceipt?.settle('failed');
        pending.entry = reason ? record(runner, 'ceiling_reached', 'ceiling', 'done', reason)
          : record(runner, didStop ? 'stopped_session' : 'stop_failed', 'ceiling', didStop ? 'done' : 'failed',
            didStop ? undefined : 'stop_incomplete', didStop ? [{ label: 'resume', actionId: 'session.open', input: { sessionId } }] : undefined);
      }
      return await runEdge(runner, pending, signal);
    } finally {
      if ((signal.aborted || !pending.entry) && pending.clearTracked) {
        if (!input.clearNotice || !await input.clearNotice(pending.clearTracked)) throw new Error('Session stop marker clear unavailable');
        pending.clearTracked = undefined;
      }
    }
  };
  return {
    enabled,
    readObservation(root: HappierProcessRoot): OwnerRowV1['ceiling'] {
      const runner = [...runners.values()].find(item => root.live && root.owner.kind === 'session'
        && item.target.root.owner.kind === 'session' && root.owner.sessionId === item.target.root.owner.sessionId
        && root.pid === item.target.root.pid && equalProcessStart(root.start, item.target.root.start)
        && root.containment?.kind === 'linux_unit' && item.target.root.containment?.kind === 'linux_unit'
        && root.containment.prefix === item.target.root.containment.prefix);
      if (!runner || runner.error || runner.ceilingBytes === null || runner.appliedBytes !== runner.ceilingBytes
        || resolveSessionMemoryCeilingBytes(runner.target.metadata, input.readPolicy()) !== runner.ceilingBytes) return undefined;
      const cutoff = now() - THROTTLE_WINDOW_MS;
      return { limitBytes: runner.ceilingBytes, ...runner.usage,
        ...(runner.observedSince <= cutoff ? { throttleCount5m: runner.throttles.filter(edge => edge.at > cutoff)
          .reduce((sum, edge) => sum + edge.count, 0) } : {}) };
    },
    async observeRunnerExit(tracked: TrackedSession): Promise<Readonly<{ status: 'recorded' | 'already_recorded' | 'not_observed' | 'unavailable' }>> {
      if (input.capability.status === 'unavailable' && input.capability.reason === 'not_linux') return { status: 'not_observed' };
      const unit = tracked.linuxLaunchUnit;
      const sessionId = tracked.happySessionId;
      if (!unit || !sessionId) return { status: 'not_observed' };
      const path = sessionScopeExitEvidencePath(input.activeServerDir, unit);
      let observation = exitObservations.get(tracked);
      if (!observation) {
        let raw: string;
        try { raw = await joinExitCapture(tracked, path, await native.readFile(path, 'utf8')); }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { status: oomRecorded.has(tracked) ? 'already_recorded' : 'not_observed' };
          return { status: 'unavailable' };
        }
        const parsed = ScopeExitStoredSchema.safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
        if (!parsed.success || parsed.data.unit !== unit || parsed.data.status !== 'captured'
          || !parsed.data.path || posix.basename(parsed.data.path) !== unit) return { status: 'unavailable' };
        if (parsed.data.oomKill === 0) {
          await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
          return { status: 'not_observed' };
        }
        const metadata = tracked.happySessionMetadataFromLocalWebhook;
        const title = readGuardSessionTitle(metadata);
        const entry: MachineGuardActivityEntryV1 = { v: 1, id: randomUUID(), at: now(), kind: 'system_oom_kill',
          rule: 'system', outcome: 'done', note: SESSION_OOM_EXPLANATION,
          subject: { kind: 'session', sessionId, title }, attribution: tracked.requesterWorkAttributionV1 ?? { kind: 'unknown' } };
        observation = { entry, path }; exitObservations.set(tracked, observation);
      }
      const already = oomRecorded.has(tracked);
      if (!already) { await input.activityLog.append(observation.entry); oomRecorded.add(tracked); }
      for (const [identity, runner] of runners) if (runner.target.tracked === tracked) {
        runner.watcher.close(); runners.delete(identity);
      }
      await unlink(observation.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      return { status: already ? 'already_recorded' : 'recorded' };
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refreshOnTick() { if (!stopped) { tick = true; for (const runner of runners.values()) runner.dirty = true; changed(); } },
    async readPlan(request: Readonly<{ policy: MachineGuardPolicyV1; now: number; signal: AbortSignal; readSignal?: AbortSignal }>): Promise<Readonly<{ nextAt?: number; run?: () => Promise<void> }>> {
      if (!enabled(request.policy)) return {};
      const { signal, policy } = request;
      const readSignal = request.readSignal ?? signal;
      readSignal.throwIfAborted();
      for (const runner of runners.values()) if (runner.pending[0]?.entry) {
        const edge = runner.pending[0];
        return { run: async () => { await runEdge(runner, edge, signal); runner.pending.shift(); changed(); } };
      }
      const targets = await input.readSessions(readSignal);
      readSignal.throwIfAborted(); if (stopped) return {};
      const live = new Set(targets.filter(target => scopeFor(target) !== null).map(key));
      // Watchers only invalidate. Counter reads and every effect belong to the one Guard loop.
      // Reconcile the native birth first: a collected scope no longer has memory.events to read.
      for (const runner of runners.values()) if (live.has(key(runner.target)) && runner.dirty) {
        const counters = readCounters(await native.readFile(posix.join(runner.scope.path, 'memory.events'), 'utf8'));
        readSignal.throwIfAborted(); if (stopped) return {};
        runner.dirty = false;
        const at = now();
        runner.throttles = runner.throttles.filter(edge => edge.at > at - THROTTLE_WINDOW_MS);
        if (counters.high < runner.high) { runner.observedSince = at; runner.throttles = []; }
        else if (counters.high > runner.high) runner.throttles.push({ at, count: counters.high - runner.high });
        if (counters.high > runner.high && !runner.highHandled && runner.ceilingBytes !== null) {
          runner.highHandled = true; runner.pending.push({ kind: 'high', bytes: runner.ceilingBytes });
        }
        if (counters.oom > runner.oom) runner.pending.push({ kind: 'oom', bytes: runner.ceilingBytes });
        runner.high = counters.high; runner.oom = counters.oom;
      }
      for (const target of targets) {
        const scope = scopeFor(target); if (!scope) continue;
        const identity = key(target);
        let runner = runners.get(identity);
        const bytes = resolveSessionMemoryCeilingBytes(target.metadata, policy);
        if (bytes === null && !runner) continue;
        if (bytes === null && runner) {
          const selected = runner;
          const selectedBytes = selected.ceilingBytes;
          return { run: async () => {
            const fresh = await current(target, signal);
            if (!fresh || runners.get(identity) !== selected || selected.ceilingBytes !== selectedBytes
              || resolveSessionMemoryCeilingBytes(fresh.metadata, input.readPolicy()) !== null) return;
            await applyNative(scope, null, signal); selected.watcher.close(); runners.delete(identity); changed();
          } };
        }
        if (!runner) {
          runner = await attachRunner(target, scope, bytes!, readSignal);
        }
        readSignal.throwIfAborted(); if (stopped) return {};
        runner.target = target; runner.ceilingBytes = bytes;
        if (runner.error) throw runner.error;
        if (runner.appliedBytes !== bytes) {
          const selected = runner;
          return { run: async () => {
            const fresh = await current(target, signal);
            if (!fresh || runners.get(identity) !== selected || selected.ceilingBytes !== bytes
              || resolveSessionMemoryCeilingBytes(fresh.metadata, input.readPolicy()) !== bytes) return;
            await applyNative(scope, bytes, signal); selected.appliedBytes = bytes; changed();
          } };
        }
      }
      for (const [identity, runner] of runners) if (!live.has(identity)) {
        runner.watcher.close(); runner.pending = runner.pending.filter(edge => edge.kind === 'oom' || edge.entry !== undefined);
        if (!runner.pending.length) runners.delete(identity);
      }
      if (tick) {
        for (const runner of runners.values()) if (live.has(key(runner.target)) && runner.ceilingBytes !== null) {
          // Failed current observations withdraw usage; the applied native limit remains known.
          runner.usage = undefined;
          const raw = await native.readFile(posix.join(runner.scope.path, 'memory.current'), 'utf8');
          readSignal.throwIfAborted(); if (stopped) return {};
          const used = /^[0-9]+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
          if (!Number.isSafeInteger(used) || used < 0) throw new Error('Session memory usage unavailable');
          runner.usage = { usedBytes: used, observedAtMs: now() };
          if (!runner.notified.has(runner.ceilingBytes) && used / runner.ceilingBytes * 100 >= policy.sessionMemoryCeiling.warnAtPercent) {
            if (!runner.pending.some(edge => edge.kind === 'near' && edge.bytes === runner.ceilingBytes)) runner.pending.push({ kind: 'near', bytes: runner.ceilingBytes,
              memory: { usedBytes: used, limitBytes: runner.appliedBytes! } });
          }
        }
        tick = false;
      }
      for (const runner of runners.values()) if (runner.pending.length) {
        const edge = runner.pending[0]!;
        return { run: async () => { await runEdge(runner, edge, signal); runner.pending.shift(); changed(); } };
      }
      return {};
    },
    async apply(request: Readonly<{ sessionId: string; bytes: number | null }>, signal?: AbortSignal) {
      if (input.capability.status === 'unavailable') return { status: 'unavailable' as const,
        appliesAt: 'next_start' as const, reason: input.capability.reason };
      const target = (await input.readSessions(signal)).find(item => item.tracked.happySessionId === request.sessionId);
      signal?.throwIfAborted();
      if (!target) return { status: 'applied' as const, appliesAt: 'next_start' as const };
      const scope = scopeFor(target);
      if (!scope) throw new Error('Current Session memory scope unavailable');
      await applyNative(scope, request.bytes, signal);
      let runner = runners.get(key(target));
      if (request.bytes !== null) {
        runner ??= await attachRunner(target, scope, request.bytes, signal);
        runner.appliedBytes = request.bytes; runner.ceilingBytes = request.bytes;
      } else if (runner) {
        runner.watcher.close(); runner.ceilingBytes = null; runner.appliedBytes = null;
        runner.pending = runner.pending.filter(edge => edge.entry !== undefined);
        if (!runner.pending.length) runners.delete(key(target));
      }
      changed(); return { status: 'applied' as const, appliesAt: 'now' as const };
    },
    deactivate() { for (const [identity, runner] of runners) if (runner.ceilingBytes === null && !runner.pending.length) { runner.watcher.close(); runners.delete(identity); } tick = false; },
    stop() { stopped = true; for (const runner of runners.values()) runner.watcher.close(); runners.clear(); listeners.clear(); },
  };
}
