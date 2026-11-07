import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { StructuredQuestionAnswersV1Schema, type StructuredQuestionAnswersV1 } from '../../tools/structuredQuestionAnswersV1.js';

export const SessionPermissionRespondDecisionV1Schema = lazyZodSchema(() => z.enum([
  'approved', 'approved_for_session', 'approved_execpolicy_amendment', 'denied', 'abort',
]));
/** Released Action callers used allow/deny; current callers use the RPC vocabulary. */
export const SessionPermissionRespondActionDecisionV1Schema = lazyZodSchema(() => z.enum([
  'allow', 'deny', ...SessionPermissionRespondDecisionV1Schema.options,
]));
export type SessionPermissionRespondActionDecisionV1 = z.infer<typeof SessionPermissionRespondActionDecisionV1Schema>;

/** Non-authorizing, executing-client evidence; an Account actor is not a device. */
export const SessionPermissionAnsweringClientCategoryV1Schema = lazyZodSchema(() => z.enum([
  'ios', 'android', 'web', 'desktop',
]));
export type SessionPermissionAnsweringClientCategoryV1 = z.infer<typeof SessionPermissionAnsweringClientCategoryV1Schema>;

const common = {
  id: z.string(), turnId: z.optional(z.string()), reason: z.optional(z.string()),
  answeringClientCategory: z.optional(SessionPermissionAnsweringClientCategoryV1Schema),
  mode: z.optional(z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan'])),
  allowedTools: z.optional(z.array(z.string())),
  decision: z.optional(SessionPermissionRespondDecisionV1Schema),
  execPolicyAmendment: z.optional(z.strictObject({ command: z.array(z.string()) })),
  updatedPermissions: z.optional(z.unknown()), answers: z.optional(StructuredQuestionAnswersV1Schema),
};
/** Closed mutation carrier; approval authority remains with admission and the runtime. */
export const SessionPermissionRespondRpcParamsV1Schema = lazyZodSchema(() => z.discriminatedUnion('approved', [
  z.strictObject({ ...common, approved: z.literal(true) }),
  z.strictObject({ ...common, approved: z.literal(false) }),
]));
export type SessionPermissionRespondRpcParamsV1 = z.infer<typeof SessionPermissionRespondRpcParamsV1Schema>;

/** Passing a question changes its handler without answering or granting permission. */
export const SessionUserActionPassUpRpcParamsV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  disposition: z.literal('pass_up'),
  reason: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export type SessionUserActionPassUpRpcParamsV1 = z.infer<typeof SessionUserActionPassUpRpcParamsV1Schema>;
export const SessionUserActionAnswerRpcParamsV1Schema = lazyZodSchema(() => z.union([
  SessionPermissionRespondRpcParamsV1Schema,
  SessionUserActionPassUpRpcParamsV1Schema,
]));
export type SessionUserActionAnswerRpcParamsV1 = z.infer<typeof SessionUserActionAnswerRpcParamsV1Schema>;

/** One Action-to-RPC compatibility seam, consumed by both first-party hosts. */
export function buildSessionPermissionRespondRpcParamsV1(input: Readonly<
  Omit<SessionPermissionRespondRpcParamsV1, 'approved' | 'decision' | 'execPolicyAmendment'> & {
    decision: SessionPermissionRespondActionDecisionV1;
    execPolicyAmendment?: unknown;
  }
>): SessionPermissionRespondRpcParamsV1 {
  const { decision, ...fields } = input;
  const rpcDecision = decision === 'deny' ? 'denied'
    : decision === 'allow' ? input.execPolicyAmendment ? 'approved_execpolicy_amendment' : undefined
    : decision;
  return SessionPermissionRespondRpcParamsV1Schema.parse({
    ...fields, approved: rpcDecision !== 'denied' && rpcDecision !== 'abort',
    ...(rpcDecision ? { decision: rpcDecision } : {}),
  });
}

/** The Action answer-array to RPC question-map projection, shared by all UI callers. */
export function buildSessionUserActionAnswerMap(input: unknown): StructuredQuestionAnswersV1 {
  const answers = Object.create(null) as Record<string, readonly string[]>;
  if (!Array.isArray(input)) return answers;
  const entries: readonly unknown[] = input;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !('question' in entry) || !('values' in entry)) continue;
    const question = String(entry.question ?? '');
    if (!question.trim() || !Array.isArray(entry.values)) continue;
    const values: readonly unknown[] = entry.values;
    if (values.length > 0 && values.every((value): value is string => typeof value === 'string')) answers[question] = [...values];
  }
  return answers;
}
