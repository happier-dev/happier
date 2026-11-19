import {
  isSessionAwarenessContentReadableV1,
  resolveSessionAwarenessAvailabilityV1,
  resolveSessionAwarenessEncryptionV1,
} from './availability.js';
import {
  normalizeAwarenessTextV1,
  normalizeAwarenessCountV1,
  normalizeAwarenessTimestampV1,
  type ProjectSessionAwarenessV1Input,
  type SessionLifecycleAwarenessInputV1,
} from './inputV1.js';
import {
  SESSION_AWARENESS_PROJECTION_VERSION_V1,
  type SessionAwarenessOperationalPrimaryV1,
  type SessionAwarenessOperationalV1,
  type SessionAwarenessProjectionV1,
  type SessionOperationalReasonV1,
} from './projectionV1.js';
import {
  hasSessionAwarenessReadyEvidenceV1,
  projectSessionAwarenessRuntimeV1,
  resolveSessionAwarenessLifecycleV1,
  type SessionAwarenessRuntimeFactsV1,
} from './runtime.js';
import { projectSessionAwarenessWorkHeadlineV1 } from './work.js';
import { isSessionTaskItemV1, projectSessionWorkDisplayV1, readCurrentSessionGoalItemV1 } from '../work/state/sessionWorkStatePrimary.js';
import { isSessionUsageLimitIssueCurrentV1 } from '../state/valueSchemas/usageLimitRecovery.js';
import { readSessionLiveManagedSessionCountV1 } from '../follow/sessionManagerV1.js';
import { SessionTurnProgressV1Schema } from '../state/valueSchemas/turnProgress.js';

/**
 * The one pure Session-awareness projector (AWR-01).
 *
 * Everything it needs is an explicit input — including `nowMs` — so it performs no I/O, reads no
 * clock, does no localization, chooses no icon or colour, and never decrypts (AWI-07). Two
 * callers holding the same facts therefore cannot disagree, which is the entire point: before
 * this owner existed, the UI, the server list, the CLI mapper, Voice and the compatibility
 * activity Action each re-derived "is this session working" and drifted.
 *
 * What it deliberately does NOT decide: unread, personal urgency, My Work inclusion, badge
 * eligibility, notification candidacy, Session access or Follow. Those are viewer-specific and
 * belong to their own owners; hosts compose them BESIDE this result (AWI-14/AWI-17).
 */
export function projectSessionAwarenessV1(
  input: ProjectSessionAwarenessV1Input,
): SessionAwarenessProjectionV1 {
  const lifecycleUnavailable = input.currentness.lifecycle === 'unavailable';
  const runtimeUnavailable = input.currentness.runtime === 'unavailable';
  const pendingUnavailable = input.currentness.pending === 'unavailable';

  // A component with no evidence contributes nothing rather than a confident default. Reading a
  // missing pending projection as "no requests" is how a surface reports a safe idle session
  // that is actually blocked on a permission prompt.
  const lifecycle = lifecycleUnavailable ? {} : input.lifecycle;
  const pending = pendingUnavailable ? {} : input.pending;

  const runtimeFacts = projectSessionAwarenessRuntimeV1({
    nowMs: input.nowMs,
    lifecycle,
    runtime: input.runtime,
    pending,
    runtimeEvidenceUnavailable: runtimeUnavailable,
    ...(input.currentness.observedAtMs !== undefined
      ? { currentnessObservedAtMs: input.currentness.observedAtMs }
      : {}),
  });

  const encryption = resolveSessionAwarenessEncryptionV1(input.content);
  const contentReadable = isSessionAwarenessContentReadableV1(encryption);
  const availability = resolveSessionAwarenessAvailabilityV1({
    encryption,
    currentness: input.currentness,
  });

  const operational = projectSessionAwarenessOperationalV1({
    runtime: runtimeFacts,
    lifecycle,
    lifecycleEvidenceUnavailable: lifecycleUnavailable,
    runtimeIssue: input.runtimeIssue,
    usageLimitRecovery: input.usageLimitRecovery,
  });
  if (!contentReadable) operational.reasons.push('content_locked');

  const title = contentReadable ? normalizeAwarenessTextV1(input.title) : null;
  const showStatus = contentReadable && !lifecycle.archivedAtMs;
  const statusReason = showStatus ? normalizeAwarenessTextV1(input.statusReason) : null;
  const work = contentReadable && input.currentness.work !== 'unavailable'
    ? projectSessionWorkDisplayV1(input.work) : null;
  const currentWork = projectSessionAwarenessWorkHeadlineV1({
    work,
    workflowHeadline: input.workflowHeadline,
    contentReadable,
    workEvidenceUnavailable: input.currentness.work === 'unavailable',
  });
  const primary = work?.primaryItem;
  const taskTitle = primary?.status === 'active' && isSessionTaskItemV1(primary) ? normalizeAwarenessTextV1(primary.title) : null;
  const goalTitle = normalizeAwarenessTextV1(work?.currentGoalTitle ?? (primary ? readCurrentSessionGoalItemV1([primary])?.title : null));
  const nowLine = showStatus ? statusReason ?? taskTitle ?? goalTitle : null;
  const nowLineKind = nowLine ? statusReason ? 'note' : taskTitle ? 'task' : 'goal' : null;
  const noteSetAt = statusReason ? normalizeAwarenessTimestampV1(input.statusReasonSetAt) : null;
  const turnStatus = lifecycle.latestTurnStatus;
  const turnEndedAt = turnStatus === 'completed' || turnStatus === 'failed' || turnStatus === 'cancelled'
    ? normalizeAwarenessTimestampV1(lifecycle.latestTurnStatusObservedAtMs)
      ?? normalizeAwarenessTimestampV1(lifecycle.latestReadyEventAtMs)
    : normalizeAwarenessTimestampV1(lifecycle.latestReadyEventAtMs);
  const statusReasonSetAt = noteSetAt !== null && turnEndedAt !== null && noteSetAt < turnEndedAt ? noteSetAt : null;
  const reports = input.managedSessions;
  const reportTotal = readSessionLiveManagedSessionCountV1(reports);
  const count = showStatus ? input.statusProgress ?? work?.taskProgress
    ?? (reports && reportTotal > 0 ? { done: reports.finished, total: reportTotal } : null) : null;
  const complete = count !== null && count.done === count.total;
  const progress = count && (!complete || input.viewerUnread === true)
    ? { ...count, complete, dim: operational.primary !== 'working' && !runtimeFacts.backgroundActive } : null;
  const workspace = contentReadable ? normalizeAwarenessWorkspaceV1(input.workspace) : undefined;
  const workStatus = contentReadable && !runtimeUnavailable && runtimeFacts.runtime !== 'offline'
    && lifecycle.processTerminalState !== 'stopped' && !lifecycle.archivedAtMs
    ? input.runtime.workStatus : null;
  const lineage = contentReadable ? input.lineage ?? undefined : undefined;
  const runningWorkCount = normalizeAwarenessCountV1(input.managedSessions?.working)
    + (runtimeFacts.freshness === 'live' ? runtimeFacts.reportedActiveCount : 0);
  const retry = showStatus && operational.primary === 'working' && input.turnRetry != null
    ? SessionTurnProgressV1Schema.safeParse(input.turnRetry) : null;

  return {
    v: SESSION_AWARENESS_PROJECTION_VERSION_V1,
    sessionId: input.sessionId,
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.manager ? { manager: input.manager } : {}),
    ...(input.managedSessions ? { managedSessions: input.managedSessions } : {}),
    ...(input.pendingReviewRuns !== undefined && input.pendingReviewRuns !== null ? { pendingReviewRuns: normalizeAwarenessCountV1(input.pendingReviewRuns) } : {}),
    ...(title ? { title } : {}),
    ...(statusReason ? { statusReason } : {}),
    ...(nowLine ? { nowLine } : {}),
    ...(nowLineKind ? { nowLineKind } : {}),
    ...(statusReasonSetAt !== null ? { statusReasonSetAt } : {}),
    ...(runtimeFacts.freshness === 'stale' && runtimeFacts.lastObservedAtMs !== null
      ? { staleSinceObservationAtMs: runtimeFacts.lastObservedAtMs } : {}),
    ...(progress ? { progress } : {}),
    ...(retry?.success ? { turnRetry: { attempt: retry.data.attempt, reason: retry.data.reason } } : {}),
    lifecycle: resolveSessionAwarenessLifecycleV1(lifecycle, lifecycleUnavailable),
    ...(contentReadable && lifecycle.processTerminalState === 'stopped' ? { processTerminalState: 'stopped' as const } : {}),
    runtime: workStatus ? 'waiting' : runtimeFacts.runtime,
    ...(workStatus ? { workStatus } : {}),
    freshness: runtimeFacts.freshness,
    operational,
    ...(currentWork ? { currentWork } : {}),
    ...(work?.taskProgress ? { taskProgress: work.taskProgress } : {}),
    ...(runningWorkCount > 0 ? { runningWorkCount } : {}),
    ...(lineage ? { lineage } : {}),
    ...(workspace ? { workspace } : {}),
    encryption,
    availability,
  };
}

function normalizeAwarenessWorkspaceV1(
  workspace: ProjectSessionAwarenessV1Input['workspace'],
): SessionAwarenessProjectionV1['workspace'] {
  if (!workspace) return undefined;
  const machineId = normalizeAwarenessTextV1(workspace.machineId);
  const projectName = normalizeAwarenessTextV1(workspace.projectName);
  const path = normalizeAwarenessTextV1(workspace.path);
  const worktreeName = normalizeAwarenessTextV1(workspace.worktreeName);
  if (!machineId && !projectName && !path && !worktreeName) return undefined;
  return {
    ...(machineId ? { machineId } : {}),
    ...(projectName ? { projectName } : {}),
    ...(path ? { path } : {}),
    ...(worktreeName ? { worktreeName } : {}),
  };
}

/** Operational semantics for consumers of runtime facts without private content acquisition. */
export function projectSessionAwarenessOperationalV1(input: Readonly<{
  runtime: SessionAwarenessRuntimeFactsV1;
  lifecycle: SessionLifecycleAwarenessInputV1;
  lifecycleEvidenceUnavailable?: boolean;
  runtimeIssue?: ProjectSessionAwarenessV1Input['runtimeIssue'];
  usageLimitRecovery?: ProjectSessionAwarenessV1Input['usageLimitRecovery'];
}>): SessionAwarenessOperationalV1 {
  const { runtime } = input;
  const lifecycleEvidenceUnavailable = input.lifecycleEvidenceUnavailable === true;
  const lifecycle = lifecycleEvidenceUnavailable ? {} : input.lifecycle;
  const usageLimited = isSessionUsageLimitIssueCurrentV1({
    issue: input.runtimeIssue,
    recovery: input.usageLimitRecovery,
    latestTurnStatus: lifecycle.latestTurnStatus,
    hasActivityAfterRuntimeIssue: input.runtimeIssue != null
      && (lifecycle.meaningfulActivityAtMs ?? 0) > input.runtimeIssue.occurredAt,
  });
  const failed = lifecycle.latestTurnStatus === 'failed' && !usageLimited;
  const actionRequired = runtime.freshActionRequired || runtime.blockedInput;
  const permissionRequired = runtime.freshPermissionRequired;
  // A completed foreground turn is not finished work while reported background activity continues.
  const ready = !runtime.backgroundActive && hasSessionAwarenessReadyEvidenceV1(lifecycle, lifecycleEvidenceUnavailable);

  const primary = ((): SessionAwarenessOperationalPrimaryV1 => {
    if (failed) return 'failed';
    if (permissionRequired) return 'permission_required';
    if (actionRequired) return 'action_required';
    if (usageLimited) return 'usage_limited';
    if (runtime.working) return 'working';
    if (ready) return 'ready';
    if (runtime.queuedInput) return 'pending_input';
    return 'none';
  })();

  // Concurrent facts survive beside the single primary. A failed session that is also holding a
  // permission prompt and three queued messages is all three things at once; only the compact
  // row has to choose.
  const reasons: SessionOperationalReasonV1[] = [];
  if (failed) reasons.push('failed');
  if (usageLimited) reasons.push('usage_limited');
  if (permissionRequired) reasons.push('permission_required');
  if (runtime.freshActionRequired) reasons.push('action_required');
  if (runtime.blockedInput) reasons.push('blocked_input');
  if (runtime.working) reasons.push('working');
  if (runtime.resuming) reasons.push('resuming');
  if (runtime.backgroundActive) reasons.push('background_activity');
  if (ready) reasons.push('ready');
  if (runtime.queuedInput) reasons.push('pending_input');
  if (runtime.unservable) reasons.push('runtime_unservable');
  if (runtime.runtime === 'offline') reasons.push('runtime_offline');
  if (runtime.freshness === 'stale') reasons.push('runtime_stale');
  if (runtime.archived) reasons.push('archived');

  return { primary, reasons };
}
