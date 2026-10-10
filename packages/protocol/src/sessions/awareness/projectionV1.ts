import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { SessionReportsToV1Schema, SessionReportsV1Schema } from '../relations/sessionReportsToV1.js';
import { SessionOriginKindV1Schema } from '../creation/sessionCreateOriginV1.js';
import { ExecutionRunIdSchema } from '../idsV1.js';

import {
  SessionWorkStateItemKindV1Schema,
  SessionWorkStateStatusV1Schema,
} from '../work/state/sessionWorkStateV1.js';

/**
 * The one bounded, transcript-free current view of a Session (Lane 09A, AWR-01).
 *
 * Awareness answers "what is this Session doing right now", not "should this viewer care".
 * Unread, personal urgency, My Work inclusion, badge eligibility and notification candidacy are
 * a DIFFERENT owner's decision (09B) and are composed BESIDE this result by the presentation
 * host — never folded into it. That separation is why every result schema here is `.strict()`:
 * a viewer-personal field smuggled into an awareness payload is a contract violation, not an
 * additive extension.
 *
 * Transcript-free is not content-free: `title`, `currentWork` and `workspace` can carry private
 * user content, so they are omitted whenever the caller could not open the Session's content.
 */
export const SESSION_AWARENESS_PROJECTION_VERSION_V1 = 1 as const;

/** Whole-Session lifecycle, independent of whether its runtime process is reachable. */
export const SessionAwarenessLifecycleV1Schema = lazyZodSchema(() => z.enum([
  'active',
  'ready',
  'failed',
  'cancelled',
  'archived',
  'unknown',
]));
export type SessionAwarenessLifecycleV1 = z.infer<typeof SessionAwarenessLifecycleV1Schema>;

/**
 * What the Session's runtime is doing. `background_active` is deliberately distinct from
 * `working`: provider background activity must never be presented as an active primary turn
 * (AWI-15). `unknown` means we have no runtime evidence and is never collapsed to `idle`.
 */
export const SessionAwarenessRuntimeV1Schema = lazyZodSchema(() => z.enum([
  'working',
  'background_active',
  'waiting',
  'idle',
  'offline',
  'unknown',
]));
export type SessionAwarenessRuntimeV1 = z.infer<typeof SessionAwarenessRuntimeV1Schema>;

/** How current the runtime evidence itself is, orthogonal to what that evidence says. */
export const SessionAwarenessFreshnessV1Schema = lazyZodSchema(() => z.enum(['live', 'stale', 'offline', 'unknown']));
export type SessionAwarenessFreshnessV1 = z.infer<typeof SessionAwarenessFreshnessV1Schema>;

/**
 * The single operational state a compact surface shows. Concurrent facts survive in `reasons`;
 * this field only says which one wins one row of space.
 */
export const SESSION_AWARENESS_OPERATIONAL_PRIMARY_PRECEDENCE_V1 = [
  'failed',
  'permission_required',
  'action_required',
  'working',
  'ready',
  'pending_input',
  'none',
] as const;
export const SessionAwarenessOperationalPrimaryV1Schema = lazyZodSchema(() => z.enum(
  SESSION_AWARENESS_OPERATIONAL_PRIMARY_PRECEDENCE_V1,
));
export type SessionAwarenessOperationalPrimaryV1 = z.infer<
  typeof SessionAwarenessOperationalPrimaryV1Schema
>;

/** Canonical compact-surface ordering; consumers must not restate this ladder. */
export function readSessionAwarenessOperationalPrimaryRankV1(
  primary: SessionAwarenessOperationalPrimaryV1,
): number {
  return SESSION_AWARENESS_OPERATIONAL_PRIMARY_PRECEDENCE_V1.length
    - SESSION_AWARENESS_OPERATIONAL_PRIMARY_PRECEDENCE_V1.indexOf(primary);
}

/**
 * Closed set of concurrent operational facts. This is a bounded product domain, not a generic
 * `Condition[]` framework: adding a member is a deliberate contract change.
 */
export const SessionOperationalReasonV1Schema = lazyZodSchema(() => z.enum([
  'failed',
  'permission_required',
  'action_required',
  'blocked_input',
  'working',
  'resuming',
  'background_activity',
  'ready',
  'pending_input',
  'runtime_offline',
  'runtime_stale',
  'runtime_unservable',
  'archived',
  'content_locked',
]));
export type SessionOperationalReasonV1 = z.infer<typeof SessionOperationalReasonV1Schema>;

/**
 * Content-key state as reported by the incumbent decryption owner. `ready` may only be supplied
 * by a caller that actually opened the envelope — key presence is not proof of decryption, and a
 * mode/content inconsistency reports `repair_needed` rather than degrading to `plain`.
 */
export const SessionAwarenessEncryptionV1Schema = lazyZodSchema(() => z.enum([
  'plain',
  'ready',
  'preparing',
  'repair_needed',
  'locked',
  'access_pending',
  'setup_required',
  'content_unavailable',
  'unknown',
]));
export type SessionAwarenessEncryptionV1 = z.infer<typeof SessionAwarenessEncryptionV1Schema>;

/** Whether this projection could see everything it describes. */
export const SessionAwarenessAvailabilityV1Schema = lazyZodSchema(() => z.enum(['complete', 'partial', 'locked']));
export type SessionAwarenessAvailabilityV1 = z.infer<typeof SessionAwarenessAvailabilityV1Schema>;

export const SessionAwarenessWorkHeadlineV1Schema = lazyZodSchema(() => z
  .object({
    title: z.string().min(1),
    itemId: z.string().min(1).optional(),
    kind: SessionWorkStateItemKindV1Schema.optional(),
    status: SessionWorkStateStatusV1Schema.optional(),
    activeWorkflowRunCount: z.number().int().nonnegative().optional(),
  })
  .strict());
export type SessionAwarenessWorkHeadlineV1 = z.infer<typeof SessionAwarenessWorkHeadlineV1Schema>;

/**
 * Lineage stays discriminated. A fork origin, a subagent custody record and an intentional
 * inter-Session message provenance are different facts, and collapsing them into `parent` would
 * make a subagent record look like a child Session.
 */
export const SessionAwarenessLineageV1Schema = lazyZodSchema(() => z
  .object({
    relation: z.enum(['fork', 'replay']),
    sourceSessionId: z.string().min(1).optional(),
  })
  .strict());
export type SessionAwarenessLineageV1 = z.infer<typeof SessionAwarenessLineageV1Schema>;

/** Immutable creation provenance is control data, independent of private lineage. */
export const SessionAwarenessOriginV1Schema = lazyZodSchema(() => z.object({
  kind: SessionOriginKindV1Schema,
  runId: ExecutionRunIdSchema.optional(),
}).strict().superRefine((origin, context) => {
  if (origin.runId !== undefined && origin.kind !== 'run_step') {
    context.addIssue({ code: 'custom', path: ['runId'], message: 'Only workflow steps name a server Run' });
  }
}));
export type SessionAwarenessOriginV1 = z.infer<typeof SessionAwarenessOriginV1Schema>;

export const SessionAwarenessWorkspaceV1Schema = lazyZodSchema(() => z
  .object({
    machineId: z.string().min(1).optional(),
    projectName: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    worktreeName: z.string().min(1).optional(),
  })
  .strict());
export type SessionAwarenessWorkspaceV1 = z.infer<typeof SessionAwarenessWorkspaceV1Schema>;

export const SessionAwarenessOperationalV1Schema = lazyZodSchema(() => z
  .object({
    primary: SessionAwarenessOperationalPrimaryV1Schema,
    reasons: z.array(SessionOperationalReasonV1Schema),
  })
  .strict());
export type SessionAwarenessOperationalV1 = z.infer<typeof SessionAwarenessOperationalV1Schema>;

export const SessionAwarenessProjectionV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(SESSION_AWARENESS_PROJECTION_VERSION_V1),
    sessionId: z.string().min(1),
    origin: SessionAwarenessOriginV1Schema.optional(),
    title: z.string().min(1).optional(),
    lifecycle: SessionAwarenessLifecycleV1Schema,
    runtime: SessionAwarenessRuntimeV1Schema,
    freshness: SessionAwarenessFreshnessV1Schema,
    operational: SessionAwarenessOperationalV1Schema,
    currentWork: SessionAwarenessWorkHeadlineV1Schema.optional(),
    lineage: SessionAwarenessLineageV1Schema.optional(),
    workspace: SessionAwarenessWorkspaceV1Schema.optional(),
    encryption: SessionAwarenessEncryptionV1Schema,
    availability: SessionAwarenessAvailabilityV1Schema,
    reportsTo: SessionReportsToV1Schema.optional(),
    reports: SessionReportsV1Schema.optional(),
    pendingReviewRuns: z.number().int().nonnegative().optional(),
  })
  .strict());
export type SessionAwarenessProjectionV1 = z.infer<typeof SessionAwarenessProjectionV1Schema>;
