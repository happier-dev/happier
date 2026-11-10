import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { StructuredQuestionAnswerDetailsV1Schema, StructuredQuestionAnswersV1Schema, type StructuredQuestionAnswerDetailsV1, type StructuredQuestionAnswersV1 } from '../../tools/structuredQuestionAnswersV1.js';

import { NativePermissionChoiceAnswerV1Schema, SessionPermissionRespondPayloadV1Schema,
  type SessionPermissionRespondActionDecisionV1 } from './nativeChoicesV1.js';
export * from './nativeChoicesV1.js';

const common = {
  ...SessionPermissionRespondPayloadV1Schema.shape,
  id: z.string(), turnId: z.optional(z.string()),
  answers: z.optional(StructuredQuestionAnswersV1Schema),
  answerDetails: z.optional(StructuredQuestionAnswerDetailsV1Schema),
  nativeChoice: z.optional(NativePermissionChoiceAnswerV1Schema),
};
/** Closed mutation carrier; approval authority remains with admission and the runtime. */
export const SessionPermissionRespondRpcParamsV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...common, approved: z.literal(true) }),
  z.strictObject({ ...common, approved: z.literal(false) }),
  z.strictObject({ ...common, approved: z.optional(z.never()), nativeChoice: NativePermissionChoiceAnswerV1Schema }),
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
    decision?: SessionPermissionRespondActionDecisionV1;
    execPolicyAmendment?: unknown;
  }
>): SessionPermissionRespondRpcParamsV1 {
  if (input.nativeChoice) {
    return SessionPermissionRespondRpcParamsV1Schema.parse({
      id: input.id, nativeChoice: input.nativeChoice,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.answeringClientCategory === undefined ? {} : { answeringClientCategory: input.answeringClientCategory }),
    });
  }
  const { decision, ...fields } = input;
  if (decision === undefined) throw new Error('permission_decision_required');
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
    if (values.every((value): value is string => typeof value === 'string')) answers[question] = [...values];
  }
  return answers;
}

/** Preserve explicit native text/comment fields without joining them into choice values. */
export function buildSessionUserActionAnswerDetails(input: unknown): StructuredQuestionAnswerDetailsV1 {
  const details: Record<string, { freeText?: string; note?: string }> = Object.create(null);
  if (!Array.isArray(input)) return details;
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || typeof entry.question !== 'string') continue;
    if (typeof entry.freeText !== 'string' && typeof entry.note !== 'string') continue;
    details[entry.question] = {
      ...(typeof entry.freeText === 'string' ? { freeText: entry.freeText } : {}),
      ...(typeof entry.note === 'string' ? { note: entry.note } : {}),
    };
  }
  return StructuredQuestionAnswerDetailsV1Schema.parse(details);
}

/** Project both parts of a typed answer to the existing per-question Action entries. */
export function buildSessionUserActionAnswerItems(
  answers: StructuredQuestionAnswersV1,
  answerDetails?: StructuredQuestionAnswerDetailsV1,
): readonly Readonly<{ question: string; values: readonly string[]; freeText?: string; note?: string }>[] {
  const questionIds = new Set([...Object.keys(answers), ...Object.keys(answerDetails ?? {})]);
  return [...questionIds].map(question => ({ question, values: [...(answers[question] ?? [])], ...answerDetails?.[question] }));
}
