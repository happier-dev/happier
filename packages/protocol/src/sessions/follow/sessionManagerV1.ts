import * as zMini from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { SessionIdSchema } from '../idsV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionFollowSourceKeyPreparationResultV1Schema, type SessionFollowSourceKeyPreparationResultV1 } from './sessionFollowSourceKeyPreparationV1.js';
import { SessionAwarenessPresentationStateV1Schema } from '../awareness/presentationV1.js';

const SessionIdV1Schema = asProtocolZod(SessionIdSchema);

/** V1 identity and mutation envelopes are closed; relation membership grants no rights. */
export const SessionManagerV1Schema = lazyZodSchema(() => z.strictObject({ sessionId: SessionIdV1Schema }));
export type SessionManagerV1 = z.infer<typeof SessionManagerV1Schema>;

export const SessionManagedSessionsV1Schema = lazyZodSchema(() => z.strictObject({
  total: z.number().check(z.int(), z.nonnegative()),
  working: z.number().check(z.int(), z.nonnegative()),
  needsYou: z.number().check(z.int(), z.nonnegative()),
  stalled: z.number().check(z.int(), z.nonnegative()),
  /** Completed settlements among live authorized direct reports; never completion by subtraction. */
  finished: z.number().check(z.int(), z.nonnegative()),
  /** Strongest live report display state; failure attention is independent of the Needs-you count. */
  attentionPrimary: z.nullable(SessionAwarenessPresentationStateV1Schema),
  /** How many of `total` are archived: still the lead's record, no longer sub-sessions anyone is running. */
  archived: zMini.optional(z.number().check(z.int(), z.nonnegative())),
}));
export type SessionManagedSessionsV1 = z.infer<typeof SessionManagedSessionsV1Schema>;

/** Sub-sessions a lead still has: `total` without the archived reports. The one reader behind every "N sub-sessions" count. */
export function readSessionLiveManagedSessionCountV1(reports: Readonly<{ total: number; archived?: number }> | null | undefined): number {
  return reports ? Math.max(0, reports.total - (reports.archived ?? 0)) : 0;
}

export const SessionManagerSetRequestV1Schema = lazyZodSchema(() => z.strictObject({
  managerSessionId: zMini.nullable(SessionIdV1Schema),
  expectedManagerSessionId: zMini.nullable(SessionIdV1Schema),
}));
export type SessionManagerSetRequestV1 = z.infer<typeof SessionManagerSetRequestV1Schema>;

export const SessionManagerSetActionInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionManagerSetRequestV1Schema, {
  sessionId: SessionIdV1Schema,
})));
export type SessionManagerSetActionInputV1 = z.infer<typeof SessionManagerSetActionInputV1Schema>;

export const SessionManagerSetResultV1Schema = lazyZodSchema(() => z.union([
  (<T extends zMini.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(z.strictObject({
    ok: z.literal(true), sessionId: SessionIdV1Schema,
    managerSessionId: SessionIdV1Schema,
    attachedAt: z.number().check(z.int(), z.nonnegative()),
    sourceKeyPreparation: zMini.optional(SessionFollowSourceKeyPreparationResultV1Schema),
  })),
  z.strictObject({
    ok: z.literal(true), sessionId: SessionIdV1Schema,
    managerSessionId: z.null(), attachedAt: z.null(),
    sourceKeyPreparation: zMini.optional(SessionFollowSourceKeyPreparationResultV1Schema),
  }),
  z.strictObject({ ok: z.literal(false), error: z.literal('manager_cycle') }),
  z.strictObject({ ok: z.literal(false), error: z.literal('manager_cas_conflict') }),
  z.strictObject({
    ok: z.literal(false), error: z.literal('manager_forbidden'),
    reason: z.enum(['read', 'input', 'pairwise']),
  }),
]));
export type SessionManagerSetResultV1 = z.infer<typeof SessionManagerSetResultV1Schema>;

/** Key readiness is retryable delivery state, never a refusal of an already committed relation. */
export function projectSessionManagerSourceKeyPreparationV1(
  committed: Extract<SessionManagerSetResultV1, Readonly<{ ok: true }>>,
  preparation: SessionFollowSourceKeyPreparationResultV1,
): Extract<SessionManagerSetResultV1, Readonly<{ ok: true }>> {
  return preparation.kind === 'waiting' ? { ...committed, sourceKeyPreparation: preparation } : committed;
}

/** Read-only, request-scoped admission evidence; it never grants write authority. */
export const SessionManagerOptionsRequestV1Schema = lazyZodSchema(() => z.strictObject({
  candidateSessionIds: z.array(SessionIdV1Schema),
}));
export const SessionManagerEligibilityV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ sessionId: SessionIdV1Schema, allowed: z.literal(true) }),
  z.strictObject({ sessionId: SessionIdV1Schema, allowed: z.literal(false), reason: z.enum(['read', 'input', 'pairwise', 'cycle']) }),
]));
export const SessionManagerOptionsV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionIdV1Schema,
  currentManagerSessionId: zMini.nullable(SessionIdV1Schema),
  candidates: z.array(SessionManagerEligibilityV1Schema),
}));
export type SessionManagerOptionsV1 = z.infer<typeof SessionManagerOptionsV1Schema>;

/** Read identity from the admitted Session projection; membership grants no authority. */
export function readSessionManagerSessionIdV1(session: Readonly<{ manager?: Readonly<{ sessionId: string }> | null }> | null | undefined): string | null {
  return session?.manager?.sessionId ?? null;
}

