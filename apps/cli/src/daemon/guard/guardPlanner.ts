import type { MachineGuardPolicyV1 } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import type { MachineGuardActivityEntryV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import type { createProcessOwnershipRuntime } from '../processes/ownership/processOwnershipRuntime';
import { equalProcessStart, processOwnerKey, type HappierProcessRoot } from '../processes/ownership/types';
import { processRef } from '../processes/view/processRef';
import type { LiveWorkInventoryV1 } from '../lifecycle/managedActivity';
import type { TrackedSession } from '../types';
import type { SessionEligibility, SessionEligibilityReason } from './sessionEligibility';
import { readSessionActivityEligibility } from './sessionEligibility';
import type { MachineGuardLadderV1 } from '@happier-dev/protocol/machines/guard/guardViewV1';
import { isSustainedV1 } from '@happier-dev/protocol/machines/vitals/isSustainedV1';

export type GuardOwnership = Awaited<ReturnType<ReturnType<typeof createProcessOwnershipRuntime>['readOwners']>>;
export type GuardRung = 'browsers' | 'devServers' | 'idleSessions';
export type GuardConnectionMinute = Readonly<{ t: number; quiet: boolean | null; quietSince?: number }>;
type TargetBase = Readonly<{ root: HappierProcessRoot;
  wayBack?: MachineGuardActivityEntryV1['wayBack'] }>;
/** Facts are projected by the incumbent launch/Service/Session owners, never inferred from names. */
export type GuardTarget = TargetBase & (
  | Readonly<{ kind: 'browser'; label: string; ownerRef: unknown; idle: boolean | null; settledAt?: number }>
  | Readonly<{ kind: 'service'; label: string; ownerRef: unknown; scope?: 'project' | 'session'; workspacePath?: string;
    workspaceIdle?: boolean | null; attribution?: MachineGuardActivityEntryV1['attribution'];
    connectionMinutes?: readonly GuardConnectionMinute[];
    listeners: readonly Readonly<{ establishedConnections: number | null }>[] }>
  | Readonly<{ kind: 'session'; label: string | null; tracked: TrackedSession; eligibility: SessionEligibility }>
);
export type GuardCandidate = Readonly<{ kind: GuardTarget['kind']; rung: GuardRung; step: 1 | 2 | 3;
  root: HappierProcessRoot; target: GuardTarget; footprintBytes: number; settledAt: number;
  attribution: MachineGuardActivityEntryV1['attribution'] }>;
export type GuardExclusionReason = SessionEligibilityReason['kind'] | 'identity_changed' | 'ownership_unknown'
  | 'not_happier' | 'footprint_unknown' | 'browser_in_use' | 'connections_unknown' | 'visitors'
  | 'unsupported_target' | 'stop_failed';
export type GuardLadderPreview = Readonly<{
  steps: readonly Readonly<{ rung: GuardRung; enabled: boolean; status: 'next' | 'skip' | 'off';
    freesAboutBytes: number; candidates: readonly GuardCandidate[] }>[];
  excluded: readonly Readonly<{ target: GuardTarget; reason: GuardExclusionReason; footprintBytes: number | null }>[];
  summary: Readonly<{ candidatesBytes: number; inUseBytes: number; workingBytes: number;
    workingSessions: number; notHappiersBytes: number; leftAloneSessions: number }>;
}>;
export type GuardFacts = Readonly<{ ownership: GuardOwnership; inventory: LiveWorkInventoryV1; targets: readonly GuardTarget[];
  /** Machine facts, not the requester's stop-eligible subset or summed process RSS. */
  memoryUsage?: Readonly<{ inUseBytes: number; notHappiersBytes: number | null }> }>;
export type IdleSessionCandidate = Readonly<{
  kind: 'session'; root: HappierProcessRoot; target: Extract<GuardTarget, { kind: 'session' }>;
  settledAt: number; footprintBytes?: number; attribution: MachineGuardActivityEntryV1['attribution'];
}>;
export type IdleSessionDecision = Readonly<{ candidate: IdleSessionCandidate; anchor: number;
  warnAt: number; stopAt: number; signature: string }>;

/** Identity, ownership and optional measured footprint have one projection for both rules. */
function createTargetCustodyReader(ownership: GuardOwnership) {
  const nativeByPid = ownership.status === 'ok' ? new Map(ownership.snapshot.rows.map(row => [row.pid, row])) : null;
  const ownershipByPid = ownership.status === 'ok' ? new Map(ownership.rows.map(row => [row.pid, row])) : null;
  return { nativeByPid, read: (target: GuardTarget) => {
    const root = target.root;
    const native = nativeByPid?.get(root.pid);
    const owned = ownershipByPid?.get(root.pid);
    const key = processOwnerKey(root.owner);
    const sameOwnerRoots = ownership.status === 'ok' ? ownership.roots.filter(item => processOwnerKey(item.owner) === key && item.live) : [];
    // A session host's process is shared by its hosted Sessions: a hosted Session owns its own
    // Agent tree, not the host process, which stays running for the others.
    const sharedHost = ownership.status === 'ok' && ownership.roots.some(item => item.live && item.pid === root.pid
      && processOwnerKey(item.owner) !== key);
    const members = ownership.status === 'ok' ? ownership.rows.filter(row => row.owner && processOwnerKey(row.owner) === key
      && (target.kind === 'session' && sameOwnerRoots.length <= 1 || row.chain.some(item => item.pid === root.pid))) : [];
    const memories = members.map(row => nativeByPid?.get(row.pid)?.memory?.bytes);
    const footprintBytes = memories.length && memories.every((bytes): bytes is number => bytes !== undefined && Number.isFinite(bytes) && bytes >= 0)
      ? memories.reduce((sum, bytes) => sum + bytes, 0) : null;
    let reason: GuardExclusionReason | undefined;
    if (!root.live || !native || !equalProcessStart(root.start, native.start)) reason = 'identity_changed';
    else if (!sharedHost && owned?.level === 'not_happier') reason = 'not_happier';
    else if (!sharedHost && (!owned?.owner || processOwnerKey(owned.owner) !== key || owned.ownerEnded
      || owned.level !== 'proven' && owned.level !== 'likely')
      || members.some(member => member.level !== 'proven' && member.level !== 'likely')) reason = 'ownership_unknown';
    return { reason, footprintBytes };
  } };
}

/** The idle timer consumes canonical eligibility, not pressure or the memory ladder's RSS requirement. */
export function planIdleSessions(input: GuardFacts & Readonly<{ policy: MachineGuardPolicyV1['idleSessions']; now: number;
  keepRunningAnchors: ReadonlyMap<string, number>; blocked?: ReadonlyMap<string, Readonly<{ signature: string }>> }>): Readonly<{
    items: readonly IdleSessionDecision[]; nextAt?: number;
  }> {
  if (!input.policy.enabled) return { items: [] };
  const custody = createTargetCustodyReader(input.ownership);
  const items: IdleSessionDecision[] = [];
  for (const target of input.targets) {
    if (target.kind !== 'session' || !target.eligibility.eligible || target.root.owner.kind !== 'session'
      || target.root.owner.sessionId !== target.tracked.happySessionId) continue;
    const facts = custody.read(target);
    const activity = readSessionActivityEligibility(target.tracked, input.inventory);
    if (facts.reason || !activity.eligible) continue;
    const settledAt = Math.max(target.eligibility.settledAt, activity.settledAt);
    const anchor = Math.max(settledAt, input.keepRunningAnchors.get(target.tracked.happySessionId!) ?? 0);
    if (!Number.isFinite(anchor) || anchor < 0 || anchor > input.now) continue;
    const stopAt = anchor + input.policy.afterMs;
    const warnAt = stopAt - input.policy.warnBeforeMs;
    const signature = `${guardTargetRef(target)}:${anchor}:${JSON.stringify(input.policy)}`;
    if (input.blocked?.get(target.tracked.happySessionId!)?.signature === signature) continue;
    items.push({ candidate: { kind: 'session', root: target.root, target, settledAt,
      attribution: input.inventory.items.find(item => item.ownerRef === target.tracked)?.attribution ?? { kind: 'unknown' },
      ...(facts.footprintBytes === null ? {} : { footprintBytes: facts.footprintBytes }) }, anchor, warnAt, stopAt, signature });
  }
  items.sort((a, b) => a.stopAt - b.stopAt || a.candidate.root.pid - b.candidate.root.pid);
  const deadlines = items.flatMap(item => item.warnAt > input.now ? [item.warnAt] : item.stopAt > input.now ? [item.stopAt] : []);
  return { items, ...(deadlines.length ? { nextAt: Math.min(...deadlines) } : {}) };
}

/** Read-only ref; any later Action re-admits its own exact target independently. */
export function guardTargetRef(target: Pick<GuardTarget, 'root'>): string {
  return processRef(target.root.pid, target.root.start);
}
export function projectGuardLadderV1(ladder: GuardLadderPreview): MachineGuardLadderV1 {
  return { steps: ladder.steps.map(step => ({ ...step, candidates: step.candidates.map(candidate => ({
    ref: guardTargetRef(candidate), processRef: processRef(candidate.root.pid, candidate.root.start),
    kind: candidate.kind, label: candidate.target.label, qualifier: 'idle',
    footprintBytes: candidate.footprintBytes, ...(candidate.target.wayBack ? { wayBack: candidate.target.wayBack } : {}),
  })) })), excluded: ladder.excluded.map(item => ({ ref: guardTargetRef(item.target),
    processRef: processRef(item.target.root.pid, item.target.root.start), kind: item.target.kind,
    label: item.target.label, reason: item.reason, footprintBytes: item.footprintBytes })), summary: ladder.summary };
}

/** One ladder supplies both the read preview and the next execution decision. */
export function planGuard(input: GuardFacts & Readonly<{ policy: MachineGuardPolicyV1['memoryGuard']; now: number;
  failedTargets?: ReadonlySet<string> }>):
  Readonly<{ candidate?: GuardCandidate; ladder: GuardLadderPreview }> {
  const candidates: GuardCandidate[] = [];
  const excluded: Array<GuardLadderPreview['excluded'][number]> = [];
  const ownership = input.ownership;
  const custody = createTargetCustodyReader(ownership);
  let workingBytes = 0;
  let workingSessions = 0;
  let leftAloneSessions = 0;
  for (const target of input.targets) {
    const root = target.root;
    const owned = custody.read(target);
    const footprintBytes = owned.footprintBytes;
    let reason = input.failedTargets?.has(guardTargetRef(target)) ? 'stop_failed' as const : owned.reason;
    if (!reason && footprintBytes === null) reason = 'footprint_unknown';
    if (!reason && target.kind !== 'session' && (!root.stop || !target.wayBack?.some(action =>
      action.label === (target.kind === 'browser' ? 'reopen' : 'start_again')))) reason = 'unsupported_target';
    let settledAt: number | undefined;
    const ownerRef = target.kind === 'session' ? target.tracked : target.ownerRef;
    const ownerItems = input.inventory.items.filter(item => item.ownerRef === ownerRef);
    if (!reason && target.kind !== 'session'
      && (input.inventory.coverage !== 'complete' || input.inventory.items.some(item => item.state === 'unknown'))) reason = 'activity_unknown';
    if (!reason && target.kind === 'browser') {
      if (root.owner.kind !== 'browser_sidecar') reason = 'unsupported_target';
      else if (target.idle === null || target.settledAt === undefined) reason = 'activity_unknown';
      else if (!target.idle) reason = 'browser_in_use';
      else settledAt = target.settledAt;
    } else if (!reason && target.kind === 'service') {
      if (root.owner.kind !== 'service' || target.scope !== 'project') reason = 'unsupported_target';
      else if (target.workspaceIdle === false) reason = 'working';
      else if (target.workspaceIdle !== true) reason = 'activity_unknown';
      else if (!target.listeners.length || target.listeners.some(listener => listener.establishedConnections === null)) reason = 'connections_unknown';
      else if (target.listeners.some(listener => listener.establishedConnections! > 0)) reason = 'visitors';
      else {
        const quiet = isSustainedV1({ records: target.connectionMinutes ?? [], now: input.now,
          sustainMs: input.policy.sustainMs, holds: record => record.quiet === true });
        const actualSince = target.connectionMinutes?.at(-1)?.quietSince;
        if (!quiet.sustained || actualSince === undefined || !Number.isFinite(actualSince)
          || actualSince < 0 || input.now - actualSince < input.policy.sustainMs) reason = 'connections_unknown';
        else settledAt = actualSince;
      }
    } else if (!reason && target.kind === 'session') {
      if (root.owner.kind !== 'session' || root.owner.sessionId !== target.tracked.happySessionId) reason = 'unsupported_target';
      else if (!target.eligibility.eligible) reason = target.eligibility.reasons[0]?.kind ?? 'activity_unknown';
      else {
        const activity = readSessionActivityEligibility(target.tracked, input.inventory);
        if (!activity.eligible) reason = activity.reasons[0]?.kind ?? 'activity_unknown';
        else settledAt = Math.max(target.eligibility.settledAt, activity.settledAt);
      }
    }
    if (!reason && (settledAt === undefined || !Number.isFinite(settledAt) || settledAt < 0 || settledAt > input.now)) reason = 'activity_unknown';
    if (reason || footprintBytes === null || settledAt === undefined) {
      excluded.push({ target, reason: reason ?? 'activity_unknown', footprintBytes });
      if (reason === 'working' || reason === 'waiting_for_you' || reason === 'subagents_running') {
        workingBytes += footprintBytes ?? 0;
        if (target.kind === 'session') workingSessions += 1;
      }
      if (target.kind === 'session') leftAloneSessions += 1;
      continue;
    }
    candidates.push({ kind: target.kind, rung: target.kind === 'browser' ? 'browsers' : target.kind === 'service' ? 'devServers' : 'idleSessions',
      step: target.kind === 'browser' ? 1 : target.kind === 'service' ? 2 : 3, root, target, footprintBytes, settledAt,
      attribution: target.kind === 'service' ? target.attribution ?? { kind: 'unknown' }
        : ownerItems[0]?.attribution ?? { kind: 'unknown' } });
  }
  candidates.sort((a, b) => a.step - b.step || b.footprintBytes - a.footprintBytes || a.settledAt - b.settledAt || a.root.pid - b.root.pid);
  const candidate = candidates.find(item => input.policy.steps[item.rung]);
  const steps = (['browsers', 'devServers', 'idleSessions'] as const).map(rung => {
    const items = candidates.filter(item => item.rung === rung);
    const enabled = input.policy.steps[rung];
    return { rung, enabled, status: !enabled ? 'off' as const : candidate?.rung === rung ? 'next' as const : 'skip' as const,
      freesAboutBytes: enabled ? items.reduce((sum, item) => sum + item.footprintBytes, 0) : 0, candidates: items };
  });
  return { ...(candidate ? { candidate } : {}), ladder: { steps, excluded, summary: {
    candidatesBytes: steps.reduce((sum, step) => sum + step.freesAboutBytes, 0), inUseBytes: input.memoryUsage?.inUseBytes ?? 0, workingBytes,
    workingSessions, notHappiersBytes: input.memoryUsage?.notHappiersBytes ?? 0, leftAloneSessions,
  } } };
}
