import type { MachineGuardViewV1, MachineGuardWatchInputV1, MachineGuardWatchResultV1 } from '@happier-dev/protocol/machines/guard/guardRpcV1';
import type { MachineGuardStateV1 } from '@happier-dev/protocol/machines/guard/guardStateV1';
import type { MachineVitalsSampler } from '../../vitals/createMachineVitalsSampler';
import type { MachineResourcesPolicyRuntime } from '../../resources/machineResourcesPolicy';
import type { createProcessOwnershipRuntime } from '../../processes/ownership/processOwnershipRuntime';
import type { GuardFacts, GuardOwnership } from '../guardPlanner';
import type { ActivityLog } from '../activityLog';
import { projectGuardActivityRowsForRequester } from '../activityLog';
import { createParkWatch } from '../../lifecycle/parkWatch';
import { waitForChangeOrDeadline } from '../../lifecycle/waitForChangeOrDeadline';
import { projectGuardLadderV1, type GuardTarget } from '../guardPlanner';
import type { RequesterWorkAttributionV1 } from '../../lifecycle/requesterWorkAttribution';
import type { createGuardRuntime } from '../guardRuntime';
import type { MachineGuardPolicyV1 } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import { attributeMachineUsage } from '@happier-dev/protocol/machines/resources/machineUsageAttribution';
import { processTotals } from '../../processes/view/projectMachineProcesses';

export type GuardTerminalPreview = Readonly<{
  terminalId: string; terminalKey: string; label: string; idleMs: number; eligible: boolean;
  commandRunning: boolean | null; status: 'eligible' | 'stops_at' | 'not_yet'; stopAt?: number;
  reasons: readonly ('foreground_unknown' | 'finite_work' | 'stop_pending' | 'native_owner_unknown' | 'not_yet' | 'warning_unavailable' | 'wrong_target')[];
  attribution: RequesterWorkAttributionV1 | Readonly<{ kind: 'unknown' }>;
}>;

export type GuardViewRequester = Readonly<{ serverId: string; accountId: string; isCustodian: boolean; machineId?: string; installationId?: string }>;
export type GuardWatchInput = Readonly<{
  policy: Pick<MachineResourcesPolicyRuntime, 'read' | 'subscribe'>;
  sampler: Pick<MachineVitalsSampler, 'latest' | 'demand' | 'subscribe' | 'samplesSince'>;
  ownership: Pick<ReturnType<typeof createProcessOwnershipRuntime>, 'readOwners'>;
  readFacts(ownership: GuardOwnership, signal?: AbortSignal): Promise<GuardFacts>;
  readState(): MachineGuardStateV1;
  readTarget(): Readonly<{ serverId: string; machineId: string; installationId: string }>;
  activityLog: Pick<ActivityLog, 'list' | 'subscribe'>;
  readLeftBehind(ownership: GuardOwnership): MachineGuardViewV1['leftBehind'];
  sessionState: Pick<ReturnType<typeof createGuardRuntime>, 'readSessionWarning' | 'readKeepRunningAnchor' | 'observeFacts' | 'planMemory'>;
  terminalState?: Readonly<{ readPreview(input: Readonly<{ ownership: GuardOwnership; policy: MachineGuardPolicyV1; now: number }>): readonly GuardTerminalPreview[] | undefined }>;
  subscribe(listener: () => void): () => void;
  readManagedRetentionRef?: () => string | undefined;
  platform?: NodeJS.Platform;
  nowMs?: () => number;
}>;
export class GuardViewUnavailableError extends Error {
  constructor(public readonly reason: 'policy_unavailable' | 'stopped' | 'cancelled' | 'wrong_target' | 'read_failed') {
    super(reason); this.name = 'GuardViewUnavailableError';
  }
}
export function createGuardWatch(input: GuardWatchInput) {
  const nowMs = input.nowMs ?? Date.now;
  type Read = Readonly<{ facts: GuardFacts; view: MachineGuardViewV1; since: number; now: number; terminalRows?: readonly GuardTerminalPreview[] }>;
  type Watcher = { requester: GuardViewRequester; view: MachineGuardViewV1; since: number;
    error?: unknown; notify: () => void };
  const watchers = new Set<Watcher>();
  const lifetime = new AbortController();
  let stopped = false;
  // Only the comparison value survives an answer; no census table or planner facts are resident.
  let fingerprint: string | undefined;
  let since = 0;
  let releases: Array<() => void> = [];
  let observation: AbortController | undefined;
  let refreshing: Promise<void> | null = null;
  let refreshAgain = false;
  const comparison = (view: MachineGuardViewV1) => JSON.stringify({ ...view,
    // Elapsed display time is not an owner change and must not prevent a watch from parking.
    idle: view.idle.map(({ idleMs: _idleMs, ...row }) => row),
    idleTerminals: view.idleTerminals?.map(({ idleMs: _idleMs, ...row }) => row),
  });

  const assertAvailable = (signal?: AbortSignal) => {
    if (stopped) throw new GuardViewUnavailableError('stopped');
    if (signal?.aborted) throw new GuardViewUnavailableError('cancelled');
  };
  const targetAttribution = (target: GuardTarget, facts: GuardFacts) => {
    if (target.kind === 'service' && target.scope === 'project') return target.attribution;
    const ownerRef = target.kind === 'session' ? target.tracked : target.ownerRef;
    return facts.inventory.items.find(item => item.ownerRef === ownerRef)?.attribution
      ?? (target.kind === 'session' ? target.tracked.requesterWorkAttributionV1 : undefined);
  };
  const visible = (attribution: RequesterWorkAttributionV1 | Readonly<{ kind: 'unknown' }> | undefined,
    requester: GuardViewRequester) => {
    if (requester.isCustodian) return true;
    const target = input.readTarget();
    return attribution !== undefined && 'accountId' in attribution
      && attribution.serverId === requester.serverId && attribution.serverId === target.serverId
      && attribution.accountId === requester.accountId && attribution.machineId === target.machineId
      && attribution.installationId === target.installationId;
  };
  const projectLadder = (facts: GuardFacts, policy: MachineGuardViewV1['policy'], state: MachineGuardStateV1, now: number) => {
    const ladder = projectGuardLadderV1(input.sessionState.planMemory(facts, policy.memoryGuard, now).ladder);
    if (state.episode?.state === 'acting' || state.episode?.state === 'verifying') {
      ladder.steps = ladder.steps.map((step, index) => state.episode?.step === index + 1 ? { ...step, status: 'run' } : step);
    }
    return ladder;
  };
  const project = (read: Pick<Read, 'view' | 'facts' | 'now' | 'terminalRows'>, requester: GuardViewRequester): MachineGuardViewV1 => {
    if (requester.serverId !== input.readTarget().serverId) throw new GuardViewUnavailableError('wrong_target');
    if (requester.isCustodian) return read.view;
    const targets = read.facts.targets.filter(target => visible(targetAttribution(target, read.facts), requester));
    const sessionIds = new Set(targets.flatMap(target => target.kind === 'session'
      && target.tracked.happySessionId ? [target.tracked.happySessionId] : []));
    const activity = projectGuardActivityRowsForRequester(read.view.recentActivity, {
      ...input.readTarget(), accountId: requester.accountId, serverId: requester.serverId,
    });
    const terminals = read.terminalRows?.filter(terminal => visible(terminal.attribution, requester));
    // The canonical planner projects own bytes; native OS aggregates and global coverage remain machine facts.
    return { ...read.view, ladder: projectLadder({ ...read.facts, targets }, read.view.policy, read.view.state, read.now),
      idle: read.view.idle.filter(item => sessionIds.has(item.sessionRef)), recentActivity: activity.entries,
      ...(terminals ? { idleTerminals: terminals.map(({ attribution: _attribution, ...terminal }) => ({ ...terminal, reasons: [...terminal.reasons] })) } : {}),
      recentActivityOthers: activity.others, othersWorkCount: read.facts.targets.length - targets.length
        + (read.terminalRows?.length ?? 0) - (terminals?.length ?? 0),
      leftBehind: { ...read.view.leftBehind, footprintBytes: null } };
  };
  const read = async (signal?: AbortSignal): Promise<Read> => {
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    assertAvailable(combined);
    let result!: Read;
    await waitForChangeOrDeadline({ signal: combined, waitForChange: async () => {
      if (input.policy.read().status !== 'ready') throw new GuardViewUnavailableError('policy_unavailable');
      const ownership = await input.ownership.readOwners({ freshness: 'shared' });
      // The shared native read stays live, but a cancelled observer must not start its successor.
      assertAvailable(combined);
      const [capturedFacts, activity] = await Promise.all([input.readFacts(ownership, combined), input.activityLog.list({ range: 'today' })]);
      assertAvailable(combined);
      const policy = input.policy.read();
      if (policy.status !== 'ready') throw new GuardViewUnavailableError('policy_unavailable');
      let facts = input.sessionState.observeFacts(capturedFacts);
      const memory = input.sampler.latest()?.memory;
      if (memory?.reported && ownership.status === 'ok') {
        const native = new Map(ownership.snapshot.rows.map(row => [row.pid, row]));
        const totals = (rows: typeof ownership.rows) => processTotals(rows.map(row => ({ memoryBytes: native.get(row.pid)?.memory?.bytes ?? null })));
        const inUseBytes = memory.totalBytes - memory.availableBytes;
        const usage = attributeMachineUsage({
          happier: totals(ownership.rows.filter(row => row.owner && (row.level === 'proven' || row.level === 'likely' || row.level === 'unknown'))),
          leftBehind: totals(ownership.rows.filter(row => row.level === 'left_behind')),
        }, { usedMemoryBytes: inUseBytes, cpuBusyPercent: null });
        facts = { ...facts, memoryUsage: { inUseBytes, notHappiersBytes: usage.everythingElse.memoryBytes } };
      }
      const now = nowMs();
      const state = input.readState();
      const ladder = projectLadder(facts, policy.policy.guard, state, now);
      const idle: MachineGuardViewV1['idle'] = facts.targets.flatMap(target => {
        if (target.kind !== 'session' || !target.tracked.happySessionId) return [];
        const sessionRef = target.tracked.happySessionId;
        const session = target.tracked;
        const metadata = session.happySessionMetadataFromLocalWebhook;
        const settledAt = target.eligibility.eligible ? target.eligibility.settledAt
          : facts.inventory.items.find(item => item.ownerRef === session && item.category === 'session')?.settledAt;
        const keptAt = input.sessionState.readKeepRunningAnchor(sessionRef);
        const anchor = settledAt === undefined ? undefined : Math.max(settledAt, keptAt ?? 0);
        const keptRunning = keptAt !== undefined && settledAt !== undefined && keptAt >= settledAt;
        const reason = target.eligibility.eligible ? undefined : target.eligibility.reasons[0]?.kind ?? 'activity_unknown';
        // A countdown is a live runtime warning, never a preview promise from a configured rule.
        const stopAt = input.sessionState.readSessionWarning(sessionRef)?.stopAt;
        return [{ sessionRef, title: target.label, agentId: metadata?.flavor ?? '',
          status: reason || keptRunning && stopAt === undefined ? 'kept' as const
            : stopAt === undefined ? 'not_yet' as const : 'stops_at' as const,
          ...(reason ? { reason } : keptRunning && stopAt === undefined ? { reason: 'kept_running' as const } : {}),
          ...(stopAt === undefined ? {} : { stopAt }), idleMs: anchor === undefined ? 0 : Math.max(0, now - anchor) }];
      });
      const retentionRef = input.readManagedRetentionRef?.();
      const terminalRows = input.terminalState?.readPreview({ ownership, policy: policy.policy.guard, now });
      const view: MachineGuardViewV1 = { policy: policy.policy.guard, policyRevision: policy.revision, state, ladder, idle,
        ...(terminalRows ? { idleTerminals: terminalRows.map(({ attribution: _attribution, ...terminal }) => ({ ...terminal, reasons: [...terminal.reasons] })) } : {}),
        leftBehind: input.readLeftBehind(ownership), keepAwake: { holding: state.keepAwakeHolding, workingSessions: ladder.summary.workingSessions },
        ...(retentionRef ? { managed: { retentionRef } } : {}), recentActivity: activity.entries, recentActivityOthers: 0,
        othersWorkCount: 0 };
      const next = comparison(view);
      if (next !== fingerprint) { fingerprint = next; since++; }
      result = { facts, view, since, now, terminalRows };
    } });
    // With no deadline, a non-cancelled wait returns only after the whole read assigned its result.
    assertAvailable(combined);
    return result;
  };
  const otherMemoryGuards = (facts: GuardFacts): NonNullable<MachineGuardViewV1['otherMemoryGuards']> => {
    if ((input.platform ?? process.platform) !== 'linux' || facts.ownership.status !== 'ok') return [];
    // Names supply this information line only; they never supply process ownership or eligibility.
    const names = new Set(facts.ownership.snapshot.rows.map(row => row.name));
    return (['systemd-oomd', 'earlyoom'] as const).filter(name => names.has(name));
  };
  const releaseObservation = () => {
    observation?.abort(); observation = undefined;
    for (const release of releases.splice(0)) release();
  };
  const refresh = () => {
    if (stopped || !watchers.size) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = (async () => {
      do {
        refreshAgain = false;
        const signal = observation?.signal;
        if (!signal) return;
        try {
          const next = await read(signal);
          if (signal.aborted) continue;
          for (const watcher of watchers) {
            const view = { ...project(next, watcher.requester), otherMemoryGuards: watcher.view.otherMemoryGuards };
            if (next.since > watcher.since) {
              watcher.view = view; watcher.since = next.since; watcher.notify();
            }
          }
        } catch (error) {
          if (stopped) return;
          if (signal.aborted) continue;
          for (const watcher of watchers) { watcher.error = error; watcher.notify(); }
        }
      } while (refreshAgain && watchers.size && !stopped);
    })().finally(() => { refreshing = null; });
  };
  // A committed journal change can alter a longer Activity query while Today stays identical.
  // Keep only this invalidation across parked-watch gaps; it never starts work without a viewer.
  const releaseActivity = input.activityLog.subscribe(() => { fingerprint = undefined; refresh(); });
  const park = createParkWatch({ onWatcherCountChanged(count) {
    if (!count) { releaseObservation(); return; }
    if (releases.length) return;
    observation = new AbortController();
    let sampleCursor = input.sampler.latest()?.sampledAt ?? 0;
    // Subscribe before the gap-closing read so owner changes cannot be missed.
    // Viewed previews share the sampler's summary clock and the canonical census.
    releases = [input.sampler.demand('summary'), input.sampler.subscribe(() => {
      const sample = input.sampler.samplesSince(sampleCursor, 'summary').at(-1);
      if (!sample) return;
      sampleCursor = sample.sampledAt;
      refresh();
    }),
      input.policy.subscribe(refresh), input.subscribe(refresh)];
    refresh();
  } });
  return {
    async readView(requester: GuardViewRequester, signal?: AbortSignal): Promise<MachineGuardViewV1> {
      const next = await read(signal);
      assertAvailable(signal);
      return { ...project(next, requester), otherMemoryGuards: otherMemoryGuards(next.facts) };
    },
    async watch(request: MachineGuardWatchInputV1, requester: GuardViewRequester, signal?: AbortSignal): Promise<MachineGuardWatchResultV1> {
      if (signal?.aborted || stopped) return { changed: false };
      const target = input.readTarget();
      if (request.machineId !== target.machineId || request.serverId !== undefined && request.serverId !== target.serverId) {
        throw new GuardViewUnavailableError('wrong_target');
      }
      let next: Read;
      try { next = await read(signal); }
      catch (error) {
        if (signal?.aborted || stopped) return { changed: false };
        throw error;
      }
      const watcher: Watcher = { requester, since: next.since,
        view: { ...project(next, requester), otherMemoryGuards: otherMemoryGuards(next.facts) }, notify: () => {} };
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      const result = await park.parkWatch({ signal: combined,
        isNewer: () => watcher.error !== undefined || request.since === undefined || watcher.since > request.since,
        read: () => { if (watcher.error) throw watcher.error; return { view: watcher.view, since: watcher.since }; },
        subscribe: listener => { watcher.notify = listener; watchers.add(watcher); return () => { watchers.delete(watcher); }; },
      });
      return result.changed ? { changed: true, ...result.snapshot } : result;
    },
    dispose() { if (stopped) return; stopped = true; lifetime.abort(); releaseObservation(); releaseActivity(); },
  };
}
