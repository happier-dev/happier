import { COORDINATOR_KEEP_VALUES } from '../../account/settings/accountSettings.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ActionApprovalRequestCreatedResultSchema } from '../../actions/actionExecutionResult.js';
import { FollowRuleSetActionInputV1Schema } from './actions.js';
import { SessionManagerSetRequestV1Schema } from './sessionManagerV1.js';
import { SessionIdSchema } from '../idsV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';

const sessionId = asProtocolZod(SessionIdSchema);

/** The shortcut selects existing rule intents; Follow still owns identity, policy and CAS. */
export const SessionCoordinatorRuleSuggestionV1Schema = lazyZodSchema(() => z.omit(FollowRuleSetActionInputV1Schema, {
  receiver: true, policy: true,
}));
export const SessionCoordinatorEnableInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId,
  roleId: z.string().check(z.minLength(1)),
  keep: z.enum(COORDINATOR_KEEP_VALUES),
  answersWorkerQuestions: z.optional(z.boolean()),
  managedBy: z.optional(SessionManagerSetRequestV1Schema),
  ruleSuggestions: z.array(SessionCoordinatorRuleSuggestionV1Schema),
}));
export type SessionCoordinatorEnableInputV1 = z.infer<typeof SessionCoordinatorEnableInputV1Schema>;

const operation = lazyZodSchema(() => z.enum(['role', 'pin', 'manager', 'rule']));
const identity = { operation, ruleId: z.optional(z.string().check(z.minLength(1))) };
export const SessionCoordinatorEffectV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ ...identity, status: z.literal('accepted'), version: z.optional(z.number().check(z.int(), z.nonnegative())) }),
  z.strictObject({ ...identity, status: z.literal('failed'), errorCode: z.string().check(z.minLength(1)) }),
  z.strictObject({ ...identity, status: z.literal('approval_required'), approval: ActionApprovalRequestCreatedResultSchema }),
  z.strictObject({ ...identity, status: z.literal('not_attempted'), errorCode: z.string().check(z.minLength(1)) }),
]));
export type SessionCoordinatorEffectV1 = z.infer<typeof SessionCoordinatorEffectV1Schema>;
export const SessionCoordinatorEnableResultV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId, status: z.enum(['configured', 'partial']),
  effects: z.array(SessionCoordinatorEffectV1Schema),
}));
export type SessionCoordinatorEnableResultV1 = z.infer<typeof SessionCoordinatorEnableResultV1Schema>;
