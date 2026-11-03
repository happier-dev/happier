import type { PrimaryTurnStatusV1, SessionRuntimeIssueV1 } from '../control/runtimeIssueV1.js';
import type { SessionUsageLimitRecoveryPresentationV1 } from '../state/valueSchemas/usageLimitRecovery.js';
import type { SessionManagerV1, SessionManagedSessionsV1 } from '../follow/sessionManagerV1.js';
import type { SessionRuntimeActivityState } from '../runtime/activity/sessionRuntimeActivity.js';
import type { SessionWorkStateV1 } from '../work/state/sessionWorkStateV1.js';
import type { SessionWorkDisplayV1 } from '../work/state/sessionWorkStatePrimary.js';
import type { SessionWorkflowActivityHeadlineV1 } from '../work/workflow/sessionWorkflowActivityHeadlineV1.js';
import type {
  SessionAwarenessLineageV1,
  SessionAwarenessOriginV1,
  SessionAwarenessWorkspaceV1,
  SessionRuntimeWorkStatusV1,
} from './projectionV1.js';

/**
 * The typed, already-normalized derivation input for `projectSessionAwarenessV1`.
 *
 * Deliberately NOT a Prisma row, a UI `Session`, or raw metadata JSON: every boundary keeps its
 * own normalizer (server parses DB text/JSON and applies access/privacy/publication policy, UI
 * maps current-device presence and optimistic input, CLI decrypts through its encryption context)
 * so the projector stays a pure function over facts that were already authorized.
 *
 * There is no `nowMs` default and no ambient clock: freshness is decided from an explicit instant
 * so the same facts always produce the same result for every caller (AWI-02).
 */

/**
 * Whether a component's facts were actually observed. `unavailable` is a first-class answer —
 * it becomes `unknown`/`partial` in the result rather than silently reading as "nothing is
 * happening" (AWR-08/AWI-04).
 */
export type SessionAwarenessComponentEvidenceV1 = 'observed' | 'unavailable';

export type SessionAwarenessCurrentnessInputV1 = Readonly<{
  lifecycle: SessionAwarenessComponentEvidenceV1;
  runtime: SessionAwarenessComponentEvidenceV1;
  pending: SessionAwarenessComponentEvidenceV1;
  work?: SessionAwarenessComponentEvidenceV1;
  /** When these facts were observed, for callers that hold a delayed snapshot. */
  observedAtMs?: number | null;
}>;

export type SessionLifecycleAwarenessInputV1 = Readonly<{
  /** Observed process termination, never inferred from absence or a cancelled turn. */
  processTerminalState?: 'stopped' | null;
  archivedAtMs?: number | null;
  latestTurnStatus?: PrimaryTurnStatusV1 | null;
  latestTurnStatusObservedAtMs?: number | null;
  latestReadyEventSeq?: number | null;
  latestReadyEventAtMs?: number | null;
  meaningfulActivityAtMs?: number | null;
}>;

/**
 * Runtime reachability evidence. `presence` is a three-valued fact on purpose: a caller with no
 * presence channel reports `unknown` instead of asserting `offline`.
 */
export type SessionRuntimeAwarenessInputV1 = Readonly<{
  workStatus?: SessionRuntimeWorkStatusV1 | null;
  presence: 'online' | 'offline' | 'unknown';
  active?: boolean | null;
  /** Last instant the runtime was observed at all (the death fact behind stale/offline). */
  lastObservedAtMs?: number | null;
  thinking?: boolean | null;
  thinkingAtMs?: number | null;
  /** Local optimistic "the prompt was accepted" instant; its own short budget. */
  optimisticThinkingAtMs?: number | null;
  resumingAtMs?: number | null;
  activityState?: SessionRuntimeActivityState | null;
  activityActiveCount?: number | null;
  controlServiceability?: 'servable' | 'recoverable_unservable' | null;
}>;

export type SessionPendingAwarenessInputV1 = Readonly<{
  hasPendingPermissionRequests?: boolean | null;
  hasPendingUserActionRequests?: boolean | null;
  pendingRequestObservedAtMs?: number | null;
  queuedInputCount?: number | null;
  blockedInputCount?: number | null;
}>;

/**
 * Content availability evidence supplied by the incumbent decryption owner.
 *
 * Discriminated so a caller cannot fabricate `ready` from key presence: a plain Session has no
 * key state at all, and an E2EE Session reports what actually happened to the envelope.
 */
export type SessionContentAvailabilityInputV1 =
  | Readonly<{ mode: 'plain' }>
  | Readonly<{ mode: 'e2ee'; keyState: 'opened' | 'preparing' | 'missing' | 'inconsistent'
      | 'access_pending' | 'setup_required' | 'content_unavailable' | 'unknown' }>;

export type SessionLineageAwarenessInputV1 = SessionAwarenessLineageV1;
export type SessionWorkspaceAwarenessInputV1 = SessionAwarenessWorkspaceV1;

export type ProjectSessionAwarenessV1Input = Readonly<{
  nowMs: number;
  sessionId: string;
  origin?: SessionAwarenessOriginV1 | null;
  manager?: SessionManagerV1 | null;
  managedSessions?: SessionManagedSessionsV1 | null;
  pendingReviewRuns?: number | null;
  /** Already normalized and privacy-filtered by the acquisition owner. */
  title?: string | null;
  /** Authored explanation only; never evidence for lifecycle or operational state. */
  statusReason?: string | null;
  runtimeIssue?: SessionRuntimeIssueV1 | null;
  usageLimitRecovery?: SessionUsageLimitRecoveryPresentationV1 | null;
  lifecycle: SessionLifecycleAwarenessInputV1;
  runtime: SessionRuntimeAwarenessInputV1;
  pending: SessionPendingAwarenessInputV1;
  content: SessionContentAvailabilityInputV1;
  work?: SessionWorkStateV1 | SessionWorkDisplayV1 | null;
  /** The incumbent runtime-published bounded workflow fact, not a second Agent-activity model. */
  workflowHeadline?: SessionWorkflowActivityHeadlineV1 | null;
  lineage?: SessionLineageAwarenessInputV1 | null;
  workspace?: SessionWorkspaceAwarenessInputV1 | null;
  currentness: SessionAwarenessCurrentnessInputV1;
}>;

export function normalizeAwarenessTimestampV1(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

export function normalizeAwarenessCountV1(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

export function normalizeAwarenessTextV1(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
