import { z } from 'zod';
import { SessionIdSchema } from '../idsV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';

const SessionIdV1Schema = asProtocolZod(SessionIdSchema);

/** V1 identity and mutation envelopes are closed; relation membership grants no rights. */
export const SessionReportsToV1Schema = z.object({ sessionId: SessionIdV1Schema }).strict();
export type SessionReportsToV1 = z.infer<typeof SessionReportsToV1Schema>;

export const SessionReportsV1Schema = z.object({
  total: z.number().int().nonnegative(),
  working: z.number().int().nonnegative(),
  needsYou: z.number().int().nonnegative(),
  stalled: z.number().int().nonnegative(),
}).strict();
export type SessionReportsV1 = z.infer<typeof SessionReportsV1Schema>;

export const SessionReportsToSetRequestV1Schema = z.object({
  leadSessionId: SessionIdV1Schema.nullable(),
  expectedLeadSessionId: SessionIdV1Schema.nullable(),
}).strict();
export type SessionReportsToSetRequestV1 = z.infer<typeof SessionReportsToSetRequestV1Schema>;

export const SessionReportsToSetActionInputV1Schema = SessionReportsToSetRequestV1Schema.extend({
  sessionId: SessionIdV1Schema,
}).strict();
export type SessionReportsToSetActionInputV1 = z.infer<typeof SessionReportsToSetActionInputV1Schema>;

export const SessionReportsToSetResultV1Schema = z.union([
  z.object({
    ok: z.literal(true), sessionId: SessionIdV1Schema,
    leadSessionId: SessionIdV1Schema,
    attachedAt: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    ok: z.literal(true), sessionId: SessionIdV1Schema,
    leadSessionId: z.null(), attachedAt: z.null(),
  }).strict(),
  z.object({ ok: z.literal(false), error: z.literal('reports_to_cycle') }).strict(),
  z.object({ ok: z.literal(false), error: z.literal('reports_to_cas_conflict') }).strict(),
  z.object({
    ok: z.literal(false), error: z.literal('reports_to_forbidden'),
    reason: z.enum(['read', 'input', 'pairwise']),
  }).strict(),
]);
export type SessionReportsToSetResultV1 = z.infer<typeof SessionReportsToSetResultV1Schema>;

/** Read-only, request-scoped admission evidence; it never grants write authority. */
export const SessionReportsToOptionsRequestV1Schema = z.object({
  candidateSessionIds: z.array(SessionIdV1Schema),
}).strict();
export const SessionReportsToEligibilityV1Schema = z.union([
  z.object({ sessionId: SessionIdV1Schema, allowed: z.literal(true) }).strict(),
  z.object({ sessionId: SessionIdV1Schema, allowed: z.literal(false), reason: z.enum(['read', 'input', 'pairwise', 'cycle']) }).strict(),
]);
export const SessionReportsToOptionsV1Schema = z.object({
  sessionId: SessionIdV1Schema,
  currentLeadSessionId: SessionIdV1Schema.nullable(),
  candidates: z.array(SessionReportsToEligibilityV1Schema),
}).strict();
export type SessionReportsToOptionsV1 = z.infer<typeof SessionReportsToOptionsV1Schema>;
