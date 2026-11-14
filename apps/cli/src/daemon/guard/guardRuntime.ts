import { randomUUID } from 'node:crypto';
import type { MachineGuardPolicyV1 } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import type { MachineGuardEpisodeV1 } from '@happier-dev/protocol/machines/guard/guardStateV1';
import type { MachineGuardActivityEntryV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import type { SessionGuardNoticeStateV1 } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import { isSustainedV1 } from '@happier-dev/protocol/machines/vitals/isSustainedV1';
import { effectiveMachineMemoryPressureV1 } from '@happier-dev/protocol/machines/vitals/effectiveMachineMemoryPressureV1';
import type { MachineVitalsSampler } from '../vitals/createMachineVitalsSampler';
import { waitForChangeOrDeadline } from '../lifecycle/waitForChangeOrDeadline';
import { equalProcessStart } from '../processes/ownership/types';
import type { ActivityLog } from './activityLog';
import { guardTargetRef, planGuard, planIdleSessions, projectGuardLadderV1, type GuardCandidate, type GuardConnectionMinute, type GuardFacts, type GuardLadderPreview, type IdleSessionCandidate } from './guardPlanner';

/**
 * The memory rule acts only under real memory scarcity (owner ruling 2026-11-12, "only under memory pressure";
 * orchestrator 2026-11-13). A kernel pressure signal alone is not scarcity: Linux PSI counts stall time and
 * stays nonzero on a busy host with most memory free. Scarcity line: available ≤ 10 % of the Machine's own
 * total, the default low-memory action line of earlyoom (`-m 10`), the userspace memory guard the Guard
 * already reports beside itself (`otherMemoryGuards`). Both the kernel signal and this line must hold.
 */
export const GUARD_SCARCE_AVAILABLE_PERCENT = 10;
export function isGuardMemoryScarce(memory: Readonly<{ totalBytes: number; availableBytes: number }>): boolean {
  return memory.totalBytes > 0 && memory.availableBytes * 100 <= memory.totalBytes * GUARD_SCARCE_AVAILABLE_PERCENT;
}

export type GuardPolicyWorkPlan = Readonly<{ nextAt?: number; run?: () => Promise<void> }>;
/** Root composition adapts the incumbent left-behind, terminal and ceiling owners. */
export type GuardPolicyWork = Readonly<{
  enabled(policy: MachineGuardPolicyV1): boolean;
  subscribe(listener: () => void): () => void;
  readPlan(input: Readonly<{ policy: MachineGuardPolicyV1; now: number; signal: AbortSignal;
    /** Read admission retires on a replan; a returned actuator retains the loop signal. */
    readSignal?: AbortSignal }>): Promise<GuardPolicyWorkPlan>;
  deactivate?(): void | Promise<void>;
}>;

export type GuardRuntimeInput = Readonly<{
  vitals: Pick<MachineVitalsSampler, 'latest' | 'state' | 'minutes' | 'subscribe'>;
  readPolicy(): MachineGuardPolicyV1;
  subscribePolicy(listener: () => void): () => void;
  /** Incumbent inventory/native ownership invalidations. Enabled only while this rule runs. */
  subscribe(listener: () => void): () => void;
  readFacts(signal?: AbortSignal): Promise<GuardFacts>;
  policyWork?: GuardPolicyWork;
  stop(candidate: GuardCandidate | IdleSessionCandidate, signal: AbortSignal): Promise<Readonly<{ status: 'stopped' } | { status: 'failed'; reason: string }>>;
  notice(candidate: GuardCandidate | IdleSessionCandidate, state: SessionGuardNoticeStateV1, signal?: AbortSignal): Promise<boolean>;
  activity: Pick<ActivityLog, 'append'>;
  /** A replacement may have become ready before the retiring runner's receipt committed. */
  onSessionStopRecorded?(candidate: GuardCandidate | IdleSessionCandidate): Promise<void>;
  /** The existing notification owner coalesces this exact episode, never individual steps. */
  notifyEpisode(input: Readonly<{ episodeId: string; freedBytes: number; outOfSteps: boolean;
    entries: readonly MachineGuardActivityEntryV1[] }>): Promise<void>;
  nowMs?: () => number;
  onError(error: unknown): void;
}>;
type Episode = { id: string; since: number; level: 'elevated' | 'critical'; failed: Set<string>; freedBytes: number;
  entries: MachineGuardActivityEntryV1[]; notified: boolean; exhausted: boolean };
type Verification = { candidate: GuardCandidate; availableBefore: number; goneAt?: number; cooldownMs: number };
type Warning = { candidate: GuardCandidate | IdleSessionCandidate; anchor: number; stopAt: number; policy: string;
  rule: 'memory_guard' | 'idle_sessions' };

/** One event/deadline loop; the minute sampler remains the sole measurement clock. */
export function createGuardRuntime(input: GuardRuntimeInput) {
  const now = input.nowMs ?? Date.now;
  const listeners = new Set<() => void>();
  const waiting = new Set<() => void>();
  const keepRunningAnchors = new Map<string, number>();
  const connectionMinutes = new Map<string, readonly GuardConnectionMinute[]>();
  const sessionWarnings = new Map<string, Warning>();
  const idleBlocked = new Map<string, Readonly<{ signature: string; failed: boolean }>>();
  let revision = 0;
  let published: MachineGuardEpisodeV1 | undefined;
  let preview: GuardLadderPreview | null = null;
  let publishedPreview = '';
  let episode: Episode | undefined;
  let verification: Verification | undefined;
  let warning: Warning | undefined;
  let running: Promise<void> | undefined;
  const changed = () => { revision++; for (const wake of [...waiting]) wake(); };
  // Channel/native failures retry only on an incumbent external edge, never our own progress.
  const ownerChanged = () => {
    for (const [id, blocked] of idleBlocked) if (blocked.failed) idleBlocked.delete(id);
    changed();
  };
  const emit = () => { for (const listener of listeners) { try { listener(); } catch (error) { input.onError(error); } } };
  /** The episode owns failed identities for every execution and requester preview. */
  const planMemory = (facts: GuardFacts, policy: MachineGuardPolicyV1['memoryGuard'], at: number) =>
    planGuard({ ...facts, policy, now: at, failedTargets: episode?.failed });
  /** The get/watch and execution planner consume these same observed native facts. */
  const observeFacts = (facts: GuardFacts): GuardFacts => {
    const policy = input.readPolicy().memoryGuard;
    if (!policy.enabled) { connectionMinutes.clear(); return { ...facts, targets: facts.targets.map(target =>
      target.kind === 'service' ? { ...target, connectionMinutes: [] } : target) }; }
    const observedAt = now();
    const minute = Math.floor(observedAt / 60000) * 60000;
    const sample = input.vitals.latest();
    const freshMinute = input.vitals.state().state === 'reporting' && sample !== null && sample.sampledAt >= minute;
    const live = new Set<string>();
    let updated = false;
    const targets = facts.targets.map(target => {
      if (target.kind !== 'service' || target.scope !== 'project') return target;
      const ref = guardTargetRef(target);
      live.add(ref);
      const previous = connectionMinutes.get(ref);
      const records = (previous ?? []).filter(record => record.t >= minute - policy.sustainMs);
      const hasVisitor = target.listeners.some(listener => listener.establishedConnections !== null && listener.establishedConnections > 0);
      const known = target.listeners.length > 0 && target.listeners.every(listener => listener.establishedConnections !== null);
      const quiet = hasVisitor ? false : known && freshMinute ? true : null;
      const lastObservation = previous?.at(-1);
      const quietSince = quiet === true ? lastObservation && lastObservation.t >= minute - 60000
        ? lastObservation.quietSince ?? observedAt : observedAt : undefined;
      const current = records.at(-1);
      if (current?.t === minute) {
        // A later zero cannot erase a visitor or uncertainty already observed in this minute.
        const nextQuiet = current.quiet === false || quiet === false ? false
          : current.quiet === null || quiet === null ? null : true;
        records[records.length - 1] = { t: minute, quiet: nextQuiet,
          ...(quietSince === undefined ? {} : { quietSince }) };
      } else if (freshMinute) {
        // The first observation does not prove the preceding interval was quiet.
        records.push({ t: minute, quiet: quiet === true && previous?.at(-1)?.t !== minute - 60000 ? null : quiet,
          ...(quietSince === undefined ? {} : { quietSince }) });
      } else if (current?.quietSince !== undefined) {
        records[records.length - 1] = { t: current.t, quiet: current.quiet };
      }
      if (JSON.stringify(previous) !== JSON.stringify(records)) { connectionMinutes.set(ref, records); updated = true; }
      return { ...target, connectionMinutes: records };
    });
    for (const ref of connectionMinutes.keys()) if (!live.has(ref)) { connectionMinutes.delete(ref); updated = true; }
    if (updated) { changed(); emit(); }
    return { ...facts, targets };
  };
  const publish = (state: MachineGuardEpisodeV1 | undefined, nextPreview = preview) => {
    const identity = nextPreview ? JSON.stringify(projectGuardLadderV1(nextPreview)) : '';
    if (JSON.stringify(published) === JSON.stringify(state) && identity === publishedPreview) return;
    published = state; preview = nextPreview; publishedPreview = identity;
    emit();
  };
  const sessionId = (candidate: GuardCandidate | IdleSessionCandidate) => candidate.target.kind === 'session' ? candidate.target.tracked.happySessionId : undefined;
  const anchorFor = (candidate: GuardCandidate) => Math.max(candidate.settledAt, keepRunningAnchors.get(sessionId(candidate) ?? '') ?? 0);
  const clearWarning = async () => {
    const current = warning; warning = undefined;
    if (current?.rule === 'memory_guard' && sessionWarnings.get(sessionId(current.candidate)!) === current) {
      sessionWarnings.delete(sessionId(current.candidate)!);
      emit(); await input.notice(current.candidate, { kind: 'clear' }).catch(input.onError);
    }
  };
  const clearSessionWarning = async (id: string) => {
    const current = sessionWarnings.get(id);
    if (!current) return;
    sessionWarnings.delete(id);
    if (warning === current) warning = undefined;
    emit(); await input.notice(current.candidate, { kind: 'clear' }).catch(input.onError);
  };
  const idleEntryFor = (candidate: IdleSessionCandidate | GuardCandidate, kind: MachineGuardActivityEntryV1['kind'],
    outcome: MachineGuardActivityEntryV1['outcome']): MachineGuardActivityEntryV1 => ({
    v: 1, id: randomUUID(), at: now(), kind, rule: 'idle_sessions', outcome, attribution: candidate.attribution,
    subject: { kind: 'session', sessionId: sessionId(candidate)!, title: candidate.target.label },
    ...(kind !== 'kept_running' && candidate.target.wayBack ? { wayBack: candidate.target.wayBack } : {}),
  });
  const runIdlePlan = async (facts: GuardFacts | undefined, policy: MachineGuardPolicyV1, signal: AbortSignal) => {
    const plan: ReturnType<typeof planIdleSessions> = facts ? planIdleSessions({ ...facts, policy: policy.idleSessions, now: now(), keepRunningAnchors,
      blocked: idleBlocked }) : { items: [] };
    if (facts) {
      const liveIds = new Set(facts.targets.flatMap(target => target.kind === 'session' && target.tracked.happySessionId ? [target.tracked.happySessionId] : []));
      for (const id of idleBlocked.keys()) if (!liveIds.has(id)) idleBlocked.delete(id);
    }
    for (const [id, current] of sessionWarnings) {
      if (current.rule !== 'idle_sessions') continue;
      const expected = plan.items.find(item => sessionId(item.candidate) === id);
      if (!expected || expected.anchor !== current.anchor || expected.stopAt !== current.stopAt
        || expected.signature !== current.policy) await clearSessionWarning(id);
    }
    if (!policy.idleSessions.enabled) { idleBlocked.clear(); return { acted: false }; }
    for (const decision of plan.items) {
      if (now() < decision.warnAt) continue;
      const candidate = decision.candidate;
      const id = sessionId(candidate)!;
      let current = sessionWarnings.get(id);
      if (!current || current.anchor !== decision.anchor || current.stopAt > decision.stopAt) {
        current = { candidate, anchor: decision.anchor, stopAt: decision.stopAt, policy: decision.signature, rule: 'idle_sessions' };
        sessionWarnings.set(id, current); emit();
        let acknowledged = false;
        try { acknowledged = await input.notice(candidate, { kind: 'stopping', stopAt: decision.stopAt, rule: 'idle_sessions' }, signal); }
        finally { if (!acknowledged && sessionWarnings.get(id) === current) await clearSessionWarning(id); }
        if (!acknowledged) {
          idleBlocked.set(id, { signature: decision.signature, failed: true });
          return { acted: true };
        }
      }
      if (signal.aborted || sessionWarnings.get(id) !== current
        || JSON.stringify(input.readPolicy().idleSessions) !== JSON.stringify(policy.idleSessions)) return { acted: false, nextAt: plan.nextAt };
      if (now() < decision.stopAt) continue;
      if (!await input.notice(candidate, { kind: 'stopped', at: now(), rule: 'idle_sessions', idleMs: now() - decision.anchor }, signal)) {
        idleBlocked.set(id, { signature: decision.signature, failed: true }); await clearSessionWarning(id);
        return { acted: true };
      }
      const firePolicy = input.readPolicy();
      // SessionStop owns fresh exact-runner eligibility after the notice ACK;
      // re-reading the fleet here repeats that admission for unrelated Sessions.
      if (signal.aborted || sessionWarnings.get(id) !== current
        || JSON.stringify(firePolicy.idleSessions) !== JSON.stringify(policy.idleSessions)) {
        await clearSessionWarning(id); return { acted: true };
      }
      const result = await input.stop(candidate, signal).catch((error: unknown) => {
        if (signal.aborted && error === signal.reason) throw error;
        input.onError(error);
        return { status: 'failed' as const, reason: 'native_stop_failed' };
      });
      idleBlocked.set(id, { signature: decision.signature, failed: result.status === 'failed' });
      if (result.status === 'failed') {
        await clearSessionWarning(id);
        await input.activity.append({ ...idleEntryFor(candidate, 'stop_failed', 'failed'), note: result.reason });
      } else {
        sessionWarnings.delete(id); if (warning === current) warning = undefined; emit();
        await input.activity.append({ ...idleEntryFor(candidate, 'stopped_session', 'done'),
          ...(candidate.footprintBytes === undefined ? {} : { freedBytes: candidate.footprintBytes }) });
        await input.onSessionStopRecorded?.(candidate);
      }
      return { acted: true };
    }
    return { acted: false, nextAt: plan.nextAt };
  };
  const entryFor = (candidate: GuardCandidate, kind: MachineGuardActivityEntryV1['kind'], outcome: MachineGuardActivityEntryV1['outcome']): MachineGuardActivityEntryV1 => ({
    v: 1, id: randomUUID(), at: now(), kind, rule: 'memory_guard', outcome, step: candidate.step,
    episodeId: episode?.id, attribution: candidate.attribution,
    subject: candidate.target.kind === 'session' ? { kind: 'session', sessionId: candidate.target.tracked.happySessionId!, title: candidate.target.label }
      : candidate.target.kind === 'browser' ? { kind: 'browser' } : { kind: 'service', label: candidate.target.label },
    ...(kind !== 'kept_running' && candidate.target.wayBack ? { wayBack: candidate.target.wayBack } : {}),
    trigger: { level: episode?.level ?? input.readPolicy().memoryGuard.actAt, sinceMs: episode?.since ?? now() },
  });
  const record = async (entry: MachineGuardActivityEntryV1) => {
    await input.activity.append(entry);
    episode?.entries.push(entry);
    if (entry.freedBytes !== undefined && episode) episode.freedBytes += entry.freedBytes;
  };
  const notify = async (outOfSteps: boolean) => {
    if (!episode || episode.notified) return;
    // Mark only after delivery admission settles. Errors remain observable at the owning dispatcher.
    await input.notifyEpisode({ episodeId: episode.id, freedBytes: episode.freedBytes, outOfSteps, entries: episode.entries });
    episode.notified = true;
  };
  const fail = async (candidate: GuardCandidate, reason: string) => {
    episode?.failed.add(guardTargetRef(candidate));
    await record({ ...entryFor(candidate, 'stop_failed', 'failed'), note: reason });
  };
  const waitForChange = (observed: number, signal: AbortSignal) => new Promise<void>(resolve => {
    if (observed !== revision || signal.aborted) { resolve(); return; }
    const wake = () => { waiting.delete(wake); signal.removeEventListener('abort', wake); resolve(); };
    waiting.add(wake); signal.addEventListener('abort', wake, { once: true });
  });

  const loop = async (signal: AbortSignal) => {
    const releasePolicy = input.subscribePolicy(ownerChanged);
    let releaseFacts: (() => void) | undefined;
    let releaseVitals: (() => void) | undefined;
    let releasePolicyWork: (() => void) | undefined;
    try {
      while (!signal.aborted) {
        const observed = revision;
        const policy = input.readPolicy();
        const memoryPolicy = policy.memoryGuard;
        const needsFacts = memoryPolicy.enabled || policy.idleSessions.enabled || verification !== undefined;
        if (needsFacts && !releaseFacts) releaseFacts = input.subscribe(ownerChanged);
        else if (!needsFacts && releaseFacts) { releaseFacts(); releaseFacts = undefined; }
        if ((memoryPolicy.enabled || verification) && !releaseVitals) releaseVitals = input.vitals.subscribe(({ sample, minute }) => {
          // Overview's live clock adds no sustain evidence. After a stop, observe
          // absence on the next sample, then wait for the existing settle budget.
          if (minute || verification && (verification.goneAt === undefined
            || sample.sampledAt >= verification.goneAt + verification.cooldownMs)) ownerChanged();
        });
        else if (!memoryPolicy.enabled && !verification && releaseVitals) { releaseVitals(); releaseVitals = undefined; }
        const needsPolicyWork = input.policyWork?.enabled(policy) === true;
        if (needsPolicyWork && !releasePolicyWork) releasePolicyWork = input.policyWork!.subscribe(changed);
        else if (!needsPolicyWork && releasePolicyWork) {
          releasePolicyWork(); releasePolicyWork = undefined;
          try { await input.policyWork?.deactivate?.(); } catch (error) { input.onError(error); }
        }
        let nextAt: number | undefined;
        try {
          const currentFacts = needsFacts ? observeFacts(await input.readFacts(signal)) : undefined;
          if (signal.aborted) break;
          // Inventory changes wake the loop; current policy and target admission,
          // rather than unrelated owner edges, decide whether this read can act.
          if (JSON.stringify(input.readPolicy()) !== JSON.stringify(policy)) continue;
          const idle = await runIdlePlan(currentFacts, policy, signal);
          if (idle.acted) { changed(); continue; }
          nextAt = idle.nextAt;
          if (needsPolicyWork) {
            let work: GuardPolicyWorkPlan | undefined;
            await waitForChangeOrDeadline({ signal, waitForChange: waitingSignal => Promise.race([
              // Retire only this observer; a shared native read may still finish.
              // The plan's actuator keeps the loop signal, not the temporary observer signal.
              input.policyWork!.readPlan({ policy, now: now(), signal, readSignal: waitingSignal }).then(value => {
                if (!waitingSignal.aborted) work = value;
              }),
              waitForChange(observed, waitingSignal),
            ]) });
            if (signal.aborted) break;
            // Retire obsolete auxiliary work without vetoing a due memory intent.
            // Its fresh target/policy/pressure admission remains below.
            if (observed === revision) {
              if (!work) throw new Error('Policy work read completed without a plan');
              if (work.nextAt !== undefined) nextAt = nextAt === undefined ? work.nextAt : Math.min(nextAt, work.nextAt);
              if (work.run) { await work.run(); changed(); continue; }
            }
            if (JSON.stringify(input.readPolicy()) !== JSON.stringify(policy)) continue;
          }
          if (!memoryPolicy.enabled && !verification) {
            connectionMinutes.clear();
            await clearWarning(); episode = undefined; publish(undefined, null);
          } else {
            if (!currentFacts) throw new Error('Enabled memory rule requires current owner facts');
            const facts = currentFacts;
            const plan = planMemory(facts, memoryPolicy, now());
            const sample = input.vitals.latest();
            const minute = Math.floor(now() / 60000) * 60000;
            const records = input.vitals.minutes(now() - memoryPolicy.sustainMs - 60000);
            const memory = input.vitals.state().state === 'reporting' && sample && sample.sampledAt >= minute && sample.memory.reported
              ? sample.memory : null;
            const pressureLevel = memory ? effectiveMachineMemoryPressureV1(memory) : 'not_reported';
            const holds = (level: string) => level === 'critical' || memoryPolicy.actAt === 'elevated' && level === 'elevated';
            // The kernel signal is sustained over minutes; scarcity is this minute's fact and is re-read at fire.
            const pressureHigh = memory !== null && holds(pressureLevel) && isGuardMemoryScarce(memory);
            const pressureLow = memory !== null && pressureLevel !== 'not_reported' && !pressureHigh;
            const paused = memoryPolicy.pausedUntil !== null && memoryPolicy.pausedUntil > now();
            if (paused) nextAt = nextAt === undefined ? memoryPolicy.pausedUntil! : Math.min(nextAt, memoryPolicy.pausedUntil!);
            publish(published, plan.ladder);
            if (verification) {
              const native = facts.ownership.status === 'ok' ? facts.ownership.snapshot.rows.find(row => row.pid === verification!.candidate.root.pid) : undefined;
              if (facts.ownership.status === 'ok' && (!native || !equalProcessStart(native.start, verification.candidate.root.start))) verification.goneAt ??= now();
              const deadline = verification.goneAt === undefined ? undefined : verification.goneAt + verification.cooldownMs;
              if (deadline !== undefined && now() < deadline) nextAt = nextAt === undefined ? deadline : Math.min(nextAt, deadline);
              if (deadline !== undefined && memory && sample && sample.sampledAt >= deadline && sample.sampledAt > verification.goneAt!) {
                const candidate = verification.candidate;
                const delta = memory.availableBytes - verification.availableBefore;
                await record({ ...entryFor(candidate, candidate.kind === 'browser' ? 'closed_browser' : candidate.kind === 'service' ? 'stopped_service' : 'stopped_session',
                  delta > 0 ? 'done' : 'did_not_help'), freedBytes: Math.max(0, delta) });
                verification = undefined;
                if (candidate.kind === 'session') await input.onSessionStopRecorded?.(candidate);
                publish(undefined);
                if (pressureLow || !memoryPolicy.enabled) { await notify(false); episode = undefined; publish(undefined); }
                changed(); continue;
              }
              publish({ state: 'verifying', since: episode!.since, step: verification.candidate.step, expectedReturnBytes: verification.candidate.footprintBytes });
            } else if (pressureLow || !memoryPolicy.enabled) {
              await clearWarning();
              if (episode?.entries.length) await notify(false);
              episode = undefined; publish(undefined);
            } else if (paused) {
              await clearWarning();
            } else if (!memory || pressureLevel === 'not_reported' || records.at(-1)?.t !== minute || records.at(-1)?.lvl === 'not_reported') {
              // A deadline may precede its same-minute asynchronous sample. Keep the
              // warning until that read settles; never act on the prior minute.
              if (input.vitals.state().state !== 'reporting' || memory !== null && pressureLevel === 'not_reported'
                || records.at(-1)?.t === minute && records.at(-1)?.lvl === 'not_reported') await clearWarning();
            } else {
              const sustained = isSustainedV1({ records, now: now(), sustainMs: memoryPolicy.sustainMs, holds: record => holds(record.lvl) });
              if (!episode && sustained.sustained) episode = { id: randomUUID(), since: sustained.since!,
                level: pressureLevel === 'critical' ? 'critical' : 'elevated',
                failed: new Set(), freedBytes: 0, entries: [], notified: false, exhausted: false };
              if (!episode || !sustained.sustained && !episode.exhausted) {
                await clearWarning();
                publish(sustained.since === null ? undefined : { state: 'sustaining', since: sustained.since });
              } else if (episode.exhausted) {
                publish({ state: 'out_of_steps', since: episode.since });
              } else if (!plan.candidate) {
                await clearWarning();
                await record({ v: 1, id: randomUUID(), at: now(), kind: 'out_of_steps', rule: 'memory_guard', outcome: 'done',
                  episodeId: episode.id, attribution: { kind: 'unknown' }, trigger: { level: episode.level, sinceMs: episode.since } });
                episode.exhausted = true;
                await notify(true); publish({ state: 'out_of_steps', since: episode.since });
              } else {
                const candidate = plan.candidate;
                let mayStop = candidate.kind !== 'session';
                if (candidate.kind === 'session') {
                  const anchor = anchorFor(candidate);
                  const policyIdentity = JSON.stringify({ memoryGuard: memoryPolicy, warningLead: policy.idleSessions.warnBeforeMs });
                  if (warning && sessionWarnings.get(sessionId(warning.candidate)!) !== warning) warning = undefined;
                  if (warning && (guardTargetRef(warning.candidate) !== guardTargetRef(candidate) || warning.anchor !== anchor
                    || warning.rule === 'memory_guard' && warning.policy !== policyIdentity)) await clearWarning();
                  if (!warning) {
                    const stopAt = now() + policy.idleSessions.warnBeforeMs;
                    const inherited = sessionWarnings.get(sessionId(candidate)!);
                    if (inherited && inherited.anchor === anchor && inherited.stopAt <= stopAt) warning = inherited;
                    else {
                      warning = { candidate, anchor, stopAt, policy: policyIdentity, rule: 'memory_guard' };
                      const pending = warning;
                      const id = sessionId(candidate)!;
                      sessionWarnings.set(id, pending);
                      emit();
                      let acknowledged = false;
                      try { acknowledged = await input.notice(candidate, { kind: 'stopping', stopAt, rule: 'memory_guard' }, signal); }
                      finally { if (!acknowledged && sessionWarnings.get(id) === pending) await clearSessionWarning(id); }
                      if (!acknowledged) { await fail(candidate, 'warning_unavailable'); changed(); continue; }
                    }
                  }
                  if (!warning || sessionWarnings.get(sessionId(candidate)!) !== warning) continue;
                  nextAt = nextAt === undefined ? warning.stopAt : Math.min(nextAt, warning.stopAt);
                  mayStop = now() >= warning.stopAt;
                } else if (warning) await clearWarning();
                publish({ state: 'acting', since: episode.since, step: candidate.step, expectedReturnBytes: candidate.footprintBytes });
                if (mayStop && !signal.aborted) {
                  const stoppingWarning = warning;
                  if (candidate.kind === 'session' && !await input.notice(candidate, { kind: 'stopped', at: now(), rule: 'memory_guard', idleMs: now() - candidate.settledAt }, signal)) {
                    await clearWarning(); await fail(candidate, 'stop_marker_unavailable'); changed(); continue;
                  }
                  // SessionStop owns the final exact-runner admission. Browser
                  // control and service visitors still need their fresh rung facts.
                  const fireFacts = candidate.kind === 'session' ? undefined : observeFacts(await input.readFacts(signal));
                  const fireGuardPolicy = input.readPolicy();
                  const firePolicy = fireGuardPolicy.memoryGuard;
                  const fireCandidate = fireFacts ? planMemory(fireFacts, firePolicy, now()).candidate : candidate;
                  const fireSample = input.vitals.latest();
                  const fireMemory = input.vitals.state().state === 'reporting' && fireSample
                    && fireSample.sampledAt >= Math.floor(now() / 60000) * 60000 && fireSample.memory.reported ? fireSample.memory : null;
                  if (!firePolicy.enabled || firePolicy.pausedUntil !== null && firePolicy.pausedUntil > now()
                    || JSON.stringify(firePolicy) !== JSON.stringify(memoryPolicy)
                    || candidate.kind === 'session' && (sessionWarnings.get(sessionId(candidate)!) !== stoppingWarning
                      || fireGuardPolicy.idleSessions.warnBeforeMs !== policy.idleSessions.warnBeforeMs
                      || stoppingWarning?.rule === 'idle_sessions'
                        && JSON.stringify(fireGuardPolicy.idleSessions) !== JSON.stringify(policy.idleSessions))
                    || !fireMemory || !holds(effectiveMachineMemoryPressureV1(fireMemory)) || !isGuardMemoryScarce(fireMemory)
                    || !isSustainedV1({ records: input.vitals.minutes(now() - firePolicy.sustainMs - 60000), now: now(),
                      sustainMs: firePolicy.sustainMs, holds: record => holds(record.lvl) }).sustained
                    || !fireCandidate || guardTargetRef(fireCandidate) !== guardTargetRef(candidate)
                    || fireCandidate.settledAt !== candidate.settledAt) { await clearWarning(); changed(); continue; }
                  if (signal.aborted) { await clearWarning(); continue; }
                  if (candidate.kind === 'session') sessionWarnings.delete(sessionId(candidate)!);
                  warning = undefined;
                  emit();
                  const result = await input.stop(candidate, signal).catch((error: unknown) => {
                    input.onError(error);
                    return { status: 'failed' as const, reason: 'native_stop_failed' };
                  });
                  if (result.status === 'failed') {
                    if (candidate.kind === 'session') await input.notice(candidate, { kind: 'clear' }, signal).catch(input.onError);
                    await fail(candidate, result.reason); changed(); continue;
                  }
                  verification = { candidate, availableBefore: fireMemory.availableBytes, cooldownMs: memoryPolicy.cooldownMs };
                  publish({ state: 'verifying', since: episode.since, step: candidate.step, expectedReturnBytes: candidate.footprintBytes });
                  changed(); continue;
                }
              }
            }
          }
        } catch (error) {
          if (signal.aborted && error === signal.reason) break;
          input.onError(error);
        }
        if (signal.aborted) break;
        await waitForChangeOrDeadline({ waitForChange: waitingSignal => waitForChange(observed, waitingSignal), signal,
          ...(nextAt === undefined ? {} : { remainingMs: Math.max(0, nextAt - now()) }) });
      }
    } finally {
      releaseFacts?.(); releaseVitals?.(); releasePolicyWork?.(); releasePolicy();
      if (releasePolicyWork) {
        try { await input.policyWork?.deactivate?.(); } catch (error) { input.onError(error); }
      }
      for (const id of [...sessionWarnings.keys()]) await clearSessionWarning(id);
    }
  };
  return {
    run(signal: AbortSignal): Promise<void> { return running ??= loop(signal).finally(() => { running = undefined; }); },
    readEpisode: () => published,
    readPreview: () => preview,
    planMemory,
    observeFacts,
    invalidate: changed,
    readSessionWarning: (id: string): Readonly<{ stopAt: number }> | undefined => {
      const current = sessionWarnings.get(id);
      return current ? { stopAt: current.stopAt } : undefined;
    },
    readKeepRunningAnchor: (id: string) => keepRunningAnchors.get(id),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async keepRunning(id: string): Promise<'kept' | 'not_pending'> {
      const current = sessionWarnings.get(id);
      if (!current) return 'not_pending';
      keepRunningAnchors.set(id, now()); changed(); emit();
      await clearSessionWarning(id);
      if (current.rule === 'memory_guard' && 'step' in current.candidate) await record(entryFor(current.candidate, 'kept_running', 'done'));
      else await input.activity.append(idleEntryFor(current.candidate, 'kept_running', 'done'));
      return 'kept';
    },
  };
}
