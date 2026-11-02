import type { SessionAwarenessProjectionV1 } from './projectionV1.js';
import { isSessionAwarenessContentReadableV1 } from './availability.js';
import type { SessionManagedSessionsV1 } from '../follow/sessionManagerV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import type { SessionPersonalAttentionReasonV1 } from '../personal/attention.js';

export type SessionAwarenessPresentationFactsV1 = Readonly<{
  runtime: SessionAwarenessProjectionV1['runtime'];
  encryption?: SessionAwarenessProjectionV1['encryption'];
  lifecycle?: SessionAwarenessProjectionV1['lifecycle'];
  freshness?: SessionAwarenessProjectionV1['freshness'];
  processTerminalState?: SessionAwarenessProjectionV1['processTerminalState'];
  archiving?: boolean;
  /** Already admitted by the personal owner; presentation never compares private cursors. */
  viewer?: Readonly<{ attention: Readonly<{ reasons: readonly SessionPersonalAttentionReasonV1[] }> }> | null;
  operational: Readonly<Pick<SessionAwarenessProjectionV1['operational'], 'primary'>> & Readonly<{
    reasons?: readonly SessionAwarenessProjectionV1['operational']['reasons'][number][];
  }>;
}>;

/** Serializable facet vocabulary for the canonical presentation projection below. */
export const SESSION_AWARENESS_PRESENTATION_STATES_V1 = [
  'preparing', 'repair_needed', 'locked', 'access_pending', 'setup_required', 'content_unavailable', 'unknown',
  'failed', 'permission_required', 'action_required', 'usage_limited', 'stopped', 'finished_unseen', 'mentioned', 'unread', 'ready', 'pending_input',
  'archiving',
  'archived', 'recoverable_unservable', 'resuming', 'disconnected', 'stale', 'background_active', 'waiting', 'thinking',
] as const;
export const SessionAwarenessPresentationStateV1Schema = lazyZodSchema(() => z.enum(SESSION_AWARENESS_PRESENTATION_STATES_V1));
export type SessionAwarenessPresentationStateV1 = z.infer<typeof SessionAwarenessPresentationStateV1Schema>;

/** One precedence for localized Session words, Work buckets and tones. No lifecycle is changed. */
export function readSessionAwarenessPresentationV1(awareness: SessionAwarenessPresentationFactsV1): SessionAwarenessPresentationStateV1 {
  if (awareness.lifecycle === 'archived') return 'archived';
  // List hydration has no content verdict yet, but the Home's public inactive fact is known.
  if (awareness.encryption === 'unknown' && awareness.runtime === 'offline') return 'disconnected';
  if (awareness.encryption !== undefined && !isSessionAwarenessContentReadableV1(awareness.encryption)) return awareness.encryption;
  if (awareness.archiving === true) return 'archiving';
  const personal = awareness.viewer?.attention.reasons;
  const reasons = awareness.operational.reasons;
  const primary = awareness.operational.primary;
  // The terminal usage-limit notice is the same occurrence as this specific blocking issue,
  // not a second failure. A genuinely independent primary failure retains its precedence.
  if (personal?.includes('failed') && primary !== 'usage_limited' && !reasons?.includes('usage_limited')) return 'failed';
  if (primary === 'permission_required' || reasons?.includes('permission_required') || personal?.includes('permission_required')) return 'permission_required';
  if (primary === 'action_required' || reasons?.includes('action_required') || reasons?.includes('blocked_input')
    || personal?.includes('user_action_required') || personal?.includes('pending_blocked')) return 'action_required';
  // A blocking usage issue outlives a control acknowledgement or a local thinking signal.
  // The issue owner removes it only when actual later work is observed.
  if (primary === 'usage_limited') return 'usage_limited';
  if (awareness.operational.reasons?.includes('runtime_unservable')) return 'recoverable_unservable';
  if (awareness.operational.reasons?.includes('resuming')) return 'resuming';
  // A completed turn is settled evidence even after its publisher detaches. Process stop,
  // presence loss and observation expiry describe runtime reachability; none reopens that work.
  // Requests, explicit resume and runtime serviceability failures retain their precedence above.
  if (primary !== 'ready') {
    if (awareness.processTerminalState === 'stopped' && primary !== 'working') return 'stopped';
    if (awareness.runtime === 'offline') return 'disconnected';
    // Observation age does not settle reported background work. Keep its shared Work bucket,
    // filter and rank; localized presenters use freshness separately to state uncertainty.
    if (awareness.freshness === 'stale' && awareness.runtime !== 'background_active') return 'stale';
  }
  // Operational evidence and runtime reachability are orthogonal: an active turn or pending
  // request stays meaningful without a presence channel, while no operational fact stays unknown.
  if (primary === 'working') return 'thinking';
  if (awareness.runtime === 'background_active') return 'background_active';
  if (personal?.includes('ready_after_read')) return 'finished_unseen';
  if (personal?.includes('mentioned')) return 'mentioned';
  if (personal?.some(reason => reason === 'unread' || reason === 'unread_discussion' || reason === 'manual' || reason === 'reminder_due')) return 'unread';
  if (awareness.runtime === 'unknown' && primary === 'none') return 'unknown';
  if (primary === 'failed') return personal === undefined ? 'unknown' : 'waiting';
  return primary === 'none' ? 'waiting' : primary;
}

/** The incumbent Session status mapping, shared by Work presentation and input discovery. */
export function readSessionAwarenessWorkStatusV1(input: Readonly<{
  awareness: SessionAwarenessPresentationFactsV1;
  settled?: boolean;
}>): Readonly<{
  state: SessionAwarenessPresentationStateV1;
  bucket: 'needs_you' | 'working' | 'finished' | 'idle' | 'offline';
  tone: 'neutral' | 'attention' | 'danger';
  /** Action-required is either a real request or deliberate Pending input recovery. */
  actionRequiredReason?: 'request' | 'blocked_input';
}> {
  const status = readSessionPresentationStateWorkStatusV1(readSessionAwarenessPresentationV1(input.awareness), input.settled);
  if (status.state !== 'action_required') return status;
  const reasons = input.awareness.operational.reasons;
  const personal = input.awareness.viewer?.attention.reasons;
  // The operational primary also says action_required for blocked input. Concurrent real
  // requests win; an older caller with only the primary retains its existing request meaning.
  const blocked = reasons?.includes('blocked_input') || personal?.includes('pending_blocked');
  const request = reasons?.includes('action_required') || personal?.includes('user_action_required');
  return { ...status, actionRequiredReason: blocked && !request ? 'blocked_input' : 'request' };
}

function readSessionPresentationStateWorkStatusV1(
  state: SessionAwarenessPresentationStateV1,
  settled?: boolean,
): ReturnType<typeof readSessionAwarenessWorkStatusV1> {
  if (state === 'failed') return { state, bucket: 'idle', tone: 'danger' };
  if (state === 'permission_required' || state === 'action_required') return { state, bucket: 'needs_you', tone: 'attention' };
  // A settlement the runtime can no longer stand behind reads offline.
  if (state === 'disconnected' || state === 'recoverable_unservable') return { state, bucket: 'offline', tone: 'neutral' };
  if (state === 'finished_unseen' || settled === true && (state === 'ready' || state === 'waiting')) return { state, bucket: 'finished', tone: 'neutral' };
  return { state, bucket: state === 'thinking' || state === 'background_active' || state === 'archiving' ? 'working' : 'idle', tone: 'neutral' };
}

/** One compact urgency order for rows, Activity and report rollups. */
export function readSessionAwarenessPresentationRankV1(state: SessionAwarenessPresentationStateV1): number {
  switch (state) {
    case 'failed': return 10;
    case 'permission_required': return 9;
    case 'action_required': return 8;
    case 'thinking':
    case 'background_active': return 7;
    case 'usage_limited': return 6;
    case 'stopped': return 5;
    case 'disconnected':
    case 'recoverable_unservable': return 4;
    case 'finished_unseen': return 3;
    case 'mentioned': return 2;
    case 'unread': return 1;
    default: return 0;
  }
}

/**
 * Status filter choices in the Work vocabulary. Each selects every presentation state with that Work status,
 * so a filtered list, a rule and a Work row never disagree. Failed is told apart from waiting-for-you by its
 * tone; Finished needs a settlement fact a stored state cannot carry, so a filter reads it with Idle.
 */
export const SESSION_WORK_STATUS_FILTERS_V1 = ['working', 'needs_you', 'failed', 'idle', 'offline'] as const;
export type SessionWorkStatusFilterV1 = typeof SESSION_WORK_STATUS_FILTERS_V1[number];

/** Shared filter-choice identity for an already-admitted Work presentation, including acknowledged Run failures. */
export function readWorkStatusFilterV1(
  status: Readonly<Pick<ReturnType<typeof readSessionAwarenessWorkStatusV1>, 'bucket' | 'tone'> & { state: string }>,
): SessionWorkStatusFilterV1 {
  if (status.state === 'failed' || status.state === 'dispatch_failed' || status.tone === 'danger') return 'failed';
  return status.bucket === 'finished' ? 'idle' : status.bucket;
}

export function listSessionPresentationStatesForWorkStatusFilterV1(
  choice: SessionWorkStatusFilterV1,
): readonly SessionAwarenessPresentationStateV1[] {
  return SESSION_AWARENESS_PRESENTATION_STATES_V1.filter((state) => {
    const status = readSessionPresentationStateWorkStatusV1(state);
    return readWorkStatusFilterV1(status) === choice;
  });
}

/** Work groups keep idle, finished and offline rows together under Recent. */
export function readSessionWorkStateGroupV1(
  bucket: ReturnType<typeof readSessionAwarenessWorkStatusV1>['bucket'],
): 'needsYou' | 'working' | 'recent' {
  switch (bucket) {
    case 'needs_you': return 'needsYou';
    case 'working': return 'working';
    case 'finished':
    case 'idle':
    case 'offline': return 'recent';
  }
}

/** Compact report counts use the same Work vocabulary as the individual Session rows. */
export function readSessionManagedSessionsPresentationV1(
  reports: Pick<SessionManagedSessionsV1, 'working' | 'needsYou' | 'stalled' | 'finished' | 'attentionPrimary'>,
): Readonly<{
  state: SessionAwarenessPresentationStateV1 | null;
  bucket: ReturnType<typeof readSessionAwarenessWorkStatusV1>['bucket'];
  tone: ReturnType<typeof readSessionAwarenessWorkStatusV1>['tone'];
  /** Exact known bucket count; the projection deliberately carries no failed/unread count. */
  count: number;
  finished: number;
}> {
  if (reports.attentionPrimary === null) return { state: null, bucket: 'idle', tone: 'neutral', count: 0, finished: reports.finished };
  const status = readSessionPresentationStateWorkStatusV1(reports.attentionPrimary);
  const count = status.bucket === 'needs_you' ? reports.needsYou
    : status.bucket === 'working' ? reports.working
      : status.bucket === 'offline' ? reports.stalled
        : status.bucket === 'finished' ? reports.finished : 0;
  return { ...status, count, finished: reports.finished };
}
