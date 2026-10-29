import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ACTION_ID_FAMILIES_V1 } from '../../actions/actionIds.js';
import { GetSessionFollowResponseSchema, SetSessionFollowResponseSchema, RemoveSessionFollowResponseSchema, GetOtherAccountFollowResponseV1Schema, SetOtherAccountFollowResponseV1Schema, GetSessionAutoFollowPreferencesRequestSchema, SetSessionAutoFollowPreferencesRequestSchema, SessionAutoFollowPreferencesResponseSchema } from './api.js';
import { SetSessionFollowSourceResponseSchema } from './sessionFollowSourcesApi.js';
import { FollowReceiverRefV1Schema, ChangeDeliveryMuteRequestV1Schema, ChangeDeliveryMuteResponseV1Schema, ListDeliveryMutesResponseV1Schema } from './sessionDeliveryMuteV1.js';
import { FollowSourceRefV1Schema } from './sessionDeliveryMuteV1.js';
import { SessionFollowRuleDefinitionV1Schema, SessionFollowRuleDefinitionStoredReadV1Schema, SessionFollowRuleIdV1Schema, SessionFollowRuleV1Schema, SetSessionFollowRuleRequestV1Schema, RemoveSessionFollowRuleRequestV1Schema, RemoveSessionFollowRuleResponseV1Schema } from './sessionFollowRuleV1.js';
import { FollowPolicyV1Schema } from './sessionFollowPolicyV1.js';
import { PersonalFollowOnceV1Schema, PersonalRunFollowOnceSetV1Schema, AccountFollowRelationV1Schema } from './accountFollow.js';
import { FollowSourceRelationV1Schema } from './sessionFollowSourcesApi.js';
import { SessionListFilterStoredReadV1Schema } from '../listFilter/sessionListFilterV1.js';
import { FollowRulePreviewResultV1Schema } from './sessionFollowRulePreviewV1.js';
import { SessionTargetV1Schema } from '../../actions/sessionTargetV1.js';
import { FollowListPageRequestV1Schema, FollowListRequestV1Schema, FollowListPageResultFieldsV1 } from './sessionFollowListV1.js';
import { isOtherAccountFollowMutationSupportedV1 } from './api.js';

export type SessionFollowActionIdV1 = typeof ACTION_ID_FAMILIES_V1.session_follow[number];
/** Operational receiver intent resolves once at Actions; stored/wire refs remain exact. */
export const FollowActionReceiverV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('account') }),
  z.strictObject({ kind: z.literal('session'), sessionId: SessionTargetV1Schema }),
]));
const muteReceiver = z.strictObject({ receiver: FollowActionReceiverV1Schema });
/** Public authoring never accepts a sealed blob as evidence of a rule's meaning. */
export const FollowRuleAuthoringV1Schema = lazyZodSchema(() => z.omit(SessionFollowRuleDefinitionV1Schema, { policy: true }));
export const OpenedSessionFollowRuleV1Schema = lazyZodSchema(() => z.strictObject({
  ruleId: SessionFollowRuleIdV1Schema,
  receiver: FollowReceiverRefV1Schema,
  version: SessionFollowRuleV1Schema.shape.version,
  sources: SessionFollowRuleV1Schema.shape.sources,
  inception: SessionFollowRuleV1Schema.shape.inception,
  definition: SessionFollowRuleDefinitionStoredReadV1Schema,
}));
export type OpenedSessionFollowRuleV1 = z.infer<typeof OpenedSessionFollowRuleV1Schema>;
const ruleSource = z.strictObject({ kind: z.literal('rule'), ruleId: SessionFollowRuleIdV1Schema });
const followPair = { receiver: FollowActionReceiverV1Schema, source: FollowSourceRefV1Schema };
export const FollowRuleGetActionInputV1Schema = z.strictObject({ receiver: FollowActionReceiverV1Schema, source: ruleSource });
export const FollowRuleSetActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  receiver: FollowActionReceiverV1Schema, source: ruleSource,
  ruleDefinition: FollowRuleAuthoringV1Schema, policy: FollowPolicyV1Schema,
  expectedVersion: SetSessionFollowRuleRequestV1Schema.shape.expectedVersion,
}));
export const FollowRuleRemoveActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  receiver: FollowActionReceiverV1Schema, source: ruleSource,
  expectedVersion: RemoveSessionFollowRuleRequestV1Schema.shape.expectedVersion,
}));
export const FollowRuleGetActionOutputV1Schema = z.strictObject({ rule: z.nullable(OpenedSessionFollowRuleV1Schema) });
export const FollowRuleSetActionOutputV1Schema = z.strictObject({ rule: OpenedSessionFollowRuleV1Schema });
export const FollowRuleRemoveActionOutputV1Schema = RemoveSessionFollowRuleResponseV1Schema;
export type FollowRuleAuthoringV1 = z.infer<typeof FollowRuleAuthoringV1Schema>;
export type FollowRuleGetActionInputV1 = z.infer<typeof FollowRuleGetActionInputV1Schema>;
export type FollowRuleSetActionInputV1 = z.infer<typeof FollowRuleSetActionInputV1Schema>;
export type FollowRuleRemoveActionInputV1 = z.infer<typeof FollowRuleRemoveActionInputV1Schema>;
export type FollowRuleGetActionOutputV1 = z.infer<typeof FollowRuleGetActionOutputV1Schema>;
export type FollowRuleSetActionOutputV1 = z.infer<typeof FollowRuleSetActionOutputV1Schema>;
export type FollowRuleRemoveActionOutputV1 = z.infer<typeof FollowRuleRemoveActionOutputV1Schema>;
const ordinarySource = FollowSourceRefV1Schema.check(z.refine(source => source.kind !== 'rule'));
const ordinaryPair = { receiver: FollowActionReceiverV1Schema, source: ordinarySource };
export const FollowGetActionInputV1Schema = z.strictObject(followPair);
export const FollowSetActionInputV1Schema = lazyZodSchema(() => z.union([
  FollowRuleSetActionInputV1Schema,
  z.strictObject({ ...ordinaryPair, policy: z.optional(FollowPolicyV1Schema),
    once: z.optional(z.nullable(z.union([PersonalFollowOnceV1Schema, PersonalRunFollowOnceSetV1Schema]))),
    clearOnceDeliveries: z.optional(z.literal(true)) })
    .check(z.refine(value => {
      if (value.receiver.kind !== 'account') return value.policy !== undefined && value.once === undefined && value.clearOnceDeliveries === undefined;
      if (value.source.kind === 'session') return (value.policy !== undefined || value.once !== undefined)
        && !Array.isArray(value.once) && value.clearOnceDeliveries === undefined;
      if (value.source.kind === 'execution_run' || value.source.kind === 'workflow_run') {
        return (value.once === undefined || value.once === null || Array.isArray(value.once))
          && isOtherAccountFollowMutationSupportedV1(value.source, { policy: value.policy,
            clearOnceDeliveries: value.clearOnceDeliveries,
            ...(value.once === null || Array.isArray(value.once) ? { once: value.once } : {}) });
      }
      return value.once === undefined && isOtherAccountFollowMutationSupportedV1(value.source,
        { policy: value.policy, clearOnceDeliveries: value.clearOnceDeliveries });
    })),
]));
export const FollowRemoveActionInputV1Schema = z.union([
  FollowRuleRemoveActionInputV1Schema, z.strictObject(ordinaryPair),
]);
export const FollowListActionInputV1Schema = z.union([
  z.strictObject({ direction: z.literal('following'), receiver: FollowActionReceiverV1Schema, ...FollowListRequestV1Schema.shape }),
  z.strictObject({ direction: z.literal('followers'), source: FollowSourceRefV1Schema, ...FollowListPageRequestV1Schema.shape }),
]);
export const FollowListActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  follows: z.array(AccountFollowRelationV1Schema),
  sources: z.array(FollowSourceRelationV1Schema),
  rules: z.array(OpenedSessionFollowRuleV1Schema),
  coverage: z.enum(['complete', 'partial', 'unavailable']),
  peopleCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  ...FollowListPageResultFieldsV1,
}));
export const FollowPreviewActionInputV1Schema = z.strictObject({ receiver: FollowActionReceiverV1Schema, filter: SessionListFilterStoredReadV1Schema });
export type FollowPreviewActionInputV1 = z.output<typeof FollowPreviewActionInputV1Schema>;
export const SessionFollowActionInputSchemasV1 = Object.freeze({
  'follow.get': FollowGetActionInputV1Schema,
  'follow.set': FollowSetActionInputV1Schema,
  'follow.remove': FollowRemoveActionInputV1Schema,
  'follow.list': FollowListActionInputV1Schema,
  'follow.preview': FollowPreviewActionInputV1Schema,
  'follow.preferences.get': GetSessionAutoFollowPreferencesRequestSchema,
  'follow.preferences.set': SetSessionAutoFollowPreferencesRequestSchema,
  'session.delivery.mute.set': z.extend(muteReceiver, ChangeDeliveryMuteRequestV1Schema.shape),
  'session.delivery.mute.remove': z.extend(muteReceiver, ChangeDeliveryMuteRequestV1Schema.shape),
  'session.delivery.mute.list': muteReceiver,
});
export const SessionFollowActionOutputSchemasV1 = Object.freeze({
  'follow.get': z.union([GetSessionFollowResponseSchema, GetOtherAccountFollowResponseV1Schema, z.strictObject({ source: z.nullable(FollowSourceRelationV1Schema) }), FollowRuleGetActionOutputV1Schema]),
  'follow.set': z.union([SetSessionFollowResponseSchema, SetOtherAccountFollowResponseV1Schema, SetSessionFollowSourceResponseSchema, FollowRuleSetActionOutputV1Schema]),
  'follow.remove': z.union([RemoveSessionFollowResponseSchema, FollowRuleRemoveActionOutputV1Schema]),
  'follow.list': FollowListActionOutputV1Schema,
  'follow.preview': FollowRulePreviewResultV1Schema,
  'follow.preferences.get': SessionAutoFollowPreferencesResponseSchema,
  'follow.preferences.set': SessionAutoFollowPreferencesResponseSchema,
  'session.delivery.mute.set': ChangeDeliveryMuteResponseV1Schema,
  'session.delivery.mute.remove': ChangeDeliveryMuteResponseV1Schema,
  'session.delivery.mute.list': ListDeliveryMutesResponseV1Schema,
});
export type SessionFollowActionInputV1 = { [K in SessionFollowActionIdV1]: z.input<typeof SessionFollowActionInputSchemasV1[K]> };
export type SessionFollowActionOutputV1 = { [K in SessionFollowActionIdV1]: z.output<typeof SessionFollowActionOutputSchemasV1[K]> };
export function isSessionFollowActionIdV1(value: string): value is SessionFollowActionIdV1 {
  return (ACTION_ID_FAMILIES_V1.session_follow as readonly string[]).includes(value);
}
