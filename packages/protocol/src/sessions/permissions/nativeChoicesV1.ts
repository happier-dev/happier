import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';

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

export const NativePermissionChoiceAnswerV1Schema = lazyZodSchema(() => z.strictObject({
  requirementId: z.string().check(z.minLength(1)),
  choiceId: z.string().check(z.minLength(1)),
  feedback: z.optional(z.string()),
}));
export type NativePermissionChoiceAnswerV1 = z.infer<typeof NativePermissionChoiceAnswerV1Schema>;

const responsePayload = {
  reason: z.optional(z.string()),
  answeringClientCategory: z.optional(SessionPermissionAnsweringClientCategoryV1Schema),
  mode: z.optional(z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only'])),
  allowedTools: z.optional(z.array(z.string())),
  decision: z.optional(SessionPermissionRespondDecisionV1Schema),
  execPolicyAmendment: z.optional(z.strictObject({ command: z.array(z.string()) })),
  updatedPermissions: z.optional(z.unknown()),
};
export const SessionPermissionRespondPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  ...responsePayload, approved: z.boolean(),
}));
/** Runtime-authored choices carry the canonical response, never a second vendor payload grammar. */
export const NativePermissionChoiceV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)), label: z.string(),
  decision: SessionPermissionRespondDecisionV1Schema,
  scope: z.enum(['once', 'session', 'localPersistent']),
  rulePreview: z.optional(z.string()), allowsFeedback: z.optional(z.boolean()),
  response: SessionPermissionRespondPayloadV1Schema,
  followUp: z.optional(z.strictObject({ actionId: z.string().check(z.minLength(1)), input: StrictJsonValueSchema })),
}));
export const NativePermissionChoicesV1Schema = lazyZodSchema(() => z.strictObject({
  requirementId: z.string().check(z.minLength(1)),
  source: z.string().check(z.minLength(1)),
  origin: z.optional(z.strictObject({ sessionId: z.string(), subagentId: z.optional(z.string()), subagentLabel: z.optional(z.string()) })),
  choices: z.array(NativePermissionChoiceV1Schema),
}));
type NativePermissionChoiceV1 = z.infer<typeof NativePermissionChoicesV1Schema>['choices'][number];
export type NativePermissionChoicesV1 = Readonly<{
  requirementId: string;
  source: string;
  origin?: Readonly<{ sessionId: string; subagentId?: string; subagentLabel?: string }>;
  choices: readonly Readonly<Omit<NativePermissionChoiceV1, 'response'> & {
    response: NativePermissionChoiceV1['response'];
  }>[];
}>;

/** Caller-specific authority projection; it is never persisted as an offered native fact. */
export const NativePermissionChoiceAvailabilityV1Schema = lazyZodSchema(() => z.strictObject({
  choiceId: z.string(), allowed: z.boolean(), reason: z.optional(z.literal('owner_required')),
}));
export type NativePermissionChoiceAvailabilityV1 = z.infer<typeof NativePermissionChoiceAvailabilityV1Schema>;
