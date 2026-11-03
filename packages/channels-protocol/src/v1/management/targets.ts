import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolString,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolUtf8String,
    defineProtocolUniqueArray,
} from '@happier-dev/plugin-sdk/protocol';
import {
    AgentPermissionIntentV1Schema,
    SessionIdSchema,
} from '@happier-dev/plugin-sdk/sessions';
import { AutomationIdV1Schema } from '@happier-dev/plugin-sdk/automations';

import {
    CONVERSATION_BINDING_INPUT_MODES_V1,
    CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1,
    MAX_CONVERSATION_ACTOR_PRINCIPAL_ID_UTF8_BYTES,
} from '../bounds.js';
import {
    ConversationBindingIdV1ProtocolSchema,
    ConversationConnectionIdV1ProtocolSchema,
} from '../identity.js';
import {
    ConversationJsonObjectV1ProtocolSchema,
    type ConversationJsonObjectV1,
} from '../json.js';
import { ConversationResolvedEndpointV1ProtocolSchema } from '../provider/resolution.js';
import { ConversationPullRequestV1Schema, ConversationScopedPullRequestTriggerV1Schema } from './sessionPullRequestBindings.js';
import { SessionPullRequestWatchBindingV1Schema } from './sessionPullRequestWatch.js';

const positiveSafeInteger = defineProtocolNumber({
    integer: true,
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
});
const nonnegativeSafeInteger = defineProtocolNumber({
    integer: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
});
const protocolBoolean = defineProtocolUnion([
    defineProtocolLiteral(true),
    defineProtocolLiteral(false),
]);
const agentPermissionIntentV1 = AgentPermissionIntentV1Schema;
const sessionIdV1 = SessionIdSchema;
const automationIdV1 = AutomationIdV1Schema;

/** @internal Relative-only immutable principal ID shared by binding selection and persistence schemas. */
export const ConversationPrincipalIdV1ProtocolSchema = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_ACTOR_PRINCIPAL_ID_UTF8_BYTES,
    minLength: 1,
});

/** @internal One set-valued principal allow-list shared with the binding writer. */
export const ConversationAllowedPrincipalIdsV1ProtocolSchema = defineProtocolUniqueArray(
    ConversationPrincipalIdV1ProtocolSchema,
    { minItems: 1 },
);

/** The same allow-list contract is consumed by binding mutations and storage. */
export const ConversationAllowedPrincipalIdsV1Schema = ConversationAllowedPrincipalIdsV1ProtocolSchema;
export const ConversationAllowedPrincipalIdsV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationAllowedPrincipalIdsV1Schema.jsonSchema)();

/** @internal Shared with policy mutations; safe-integer representation is the only ceiling. */
export const ConversationInboundDebounceMsV1ProtocolSchema = nonnegativeSafeInteger;
export const ConversationInboundDebounceMsV1Schema = ConversationInboundDebounceMsV1ProtocolSchema;
export const ConversationInboundDebounceMsV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationInboundDebounceMsV1Schema.jsonSchema)();

const conversationSessionApprovalPolicyV1 = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('off'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('enabled'),
        maximumScope: defineProtocolUnion([
            defineProtocolLiteral('request'),
            defineProtocolLiteral('session'),
        ]),
        principalIds: ConversationAllowedPrincipalIdsV1ProtocolSchema.optional(),
    }, { policy: 'closed' }),
]);

const conversationSessionNewSessionPolicyV1 = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('off'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('enabled'),
        principalIds: ConversationAllowedPrincipalIdsV1ProtocolSchema.optional(),
        recipe: ConversationJsonObjectV1ProtocolSchema,
    }, { policy: 'closed' }),
]);

const conversationSessionBindingPolicyV1 = defineProtocolObject({
    deliveryMode: defineProtocolUnion([
        defineProtocolLiteral('repliesOnly'),
        defineProtocolLiteral('mirrorSession'),
    ]),
    permissionCeiling: agentPermissionIntentV1,
    approvals: conversationSessionApprovalPolicyV1,
    newSession: conversationSessionNewSessionPolicyV1,
}, { policy: 'closed' });

const conversationSessionBindingTargetV1 = defineProtocolObject({
    kind: defineProtocolLiteral('session'),
    sessionId: sessionIdV1,
    pullRequestLink: ConversationPullRequestV1Schema.optional(),
    pullRequestWatch: SessionPullRequestWatchBindingV1Schema.optional(),
    policy: conversationSessionBindingPolicyV1,
}, { policy: 'closed' });

const conversationThreadRouterBindingTargetV1 = defineProtocolObject({
    kind: defineProtocolLiteral('threadRouter'),
    principalGroups: defineProtocolUniqueArray(defineProtocolObject({
        id: defineProtocolString({ minLength: 1 }),
        principalIds: defineProtocolUniqueArray(ConversationPrincipalIdV1ProtocolSchema),
    }, { policy: 'closed' }), { minItems: 1 }),
    routes: defineProtocolArray(defineProtocolObject({
        id: defineProtocolString({ minLength: 1 }),
        when: defineProtocolObject({
            group: defineProtocolString({ minLength: 1 }),
            forwarded: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false), defineProtocolLiteral('any')]),
        }, { policy: 'closed' }),
        recipe: ConversationJsonObjectV1ProtocolSchema,
        policy: conversationSessionBindingPolicyV1,
    }, { policy: 'closed' })),
}, { policy: 'closed' });

const conversationAutomationBindingTargetV1 = defineProtocolObject({
    kind: defineProtocolLiteral('automation'),
    automationId: automationIdV1,
    scopedTrigger: ConversationScopedPullRequestTriggerV1Schema.optional(),
    policy: defineProtocolObject({
        resultDelivery: defineProtocolUnion([
            defineProtocolLiteral('finalResult'),
            defineProtocolLiteral('none'),
        ]),
    }, { policy: 'closed' }),
}, { policy: 'closed' });

/** @internal Relative-only binding target shared by persistence and present-user mutations. */
export const ConversationBindingTargetV1ProtocolSchema = defineProtocolUnion([
    conversationSessionBindingTargetV1,
    conversationAutomationBindingTargetV1,
    conversationThreadRouterBindingTargetV1,
]);

/** The persisted Channels target keeps stable Automation identity, never a mutable recipe generation. */
export const ConversationBindingTargetV1Schema = ConversationBindingTargetV1ProtocolSchema;
export type ConversationBindingTargetV1 = ReturnType<typeof ConversationBindingTargetV1Schema.parse>;
/** The Session arm of the canonical persisted binding-target union. */
export type ConversationSessionBindingTargetV1 = Extract<
    ConversationBindingTargetV1,
    Readonly<{ kind: 'session' }>
>;
export type ConversationThreadRouterBindingTargetV1 = Extract<ConversationBindingTargetV1, Readonly<{ kind: 'threadRouter' }>>;

/** Groups are the router's only sender authority; order follows first membership. */
export function conversationThreadRouterAllowedPrincipalIdsV1(target: ConversationThreadRouterBindingTargetV1): readonly string[] {
    return [...new Set(target.principalGroups.flatMap((group) => group.principalIds))];
}
/** The bounded JSON recipe that Channels validates through the Session owner at dispatch time. */
export type ChannelSessionSpawnRecipeV1 = ConversationJsonObjectV1;

/**
 * Refuses host-only birth facts in author recipes. The Session owner validates
 * the remaining opaque spawn fields at dispatch; stored fields are not stripped.
 */
export function isChannelSessionSpawnRecipeAuthorableV1(recipe: ChannelSessionSpawnRecipeV1): boolean {
    return !Object.prototype.hasOwnProperty.call(recipe, 'attestedContext');
}
export const ConversationBindingTargetV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationBindingTargetV1Schema.jsonSchema)();

const conversationBindingV1CommonFields = {
    v: defineProtocolLiteral(1),
    id: ConversationBindingIdV1ProtocolSchema,
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    parentBindingId: ConversationBindingIdV1ProtocolSchema.optional(),
    endpoint: ConversationResolvedEndpointV1ProtocolSchema,
    target: ConversationBindingTargetV1ProtocolSchema,
    allowedPrincipalIds: ConversationAllowedPrincipalIdsV1ProtocolSchema,
    allowBotSenders: protocolBoolean,
    inputMode: defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_BINDING_INPUT_MODES_V1[0]),
        defineProtocolLiteral(CONVERSATION_BINDING_INPUT_MODES_V1[1]),
        defineProtocolLiteral(CONVERSATION_BINDING_INPUT_MODES_V1[2]),
    ]),
    inboundDebounceMs: ConversationInboundDebounceMsV1ProtocolSchema,
    linkPreviewPolicy: defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1[0]),
        defineProtocolLiteral(CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1[1]),
    ]),
    senderFeedback: defineProtocolUnion([
        defineProtocolLiteral('off'),
        defineProtocolLiteral('eligibleRefusals'),
    ]),
    authorityEpoch: positiveSafeInteger,
    createdAt: nonnegativeSafeInteger,
    updatedAt: nonnegativeSafeInteger,
};

/** @internal Relative-only full binding projection used by create/pairing outcomes. */
export const ConversationBindingV1ProtocolSchema = defineProtocolUnion([
    defineProtocolObject({
        ...conversationBindingV1CommonFields,
        enabled: protocolBoolean,
        deletionState: defineProtocolLiteral('none'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        ...conversationBindingV1CommonFields,
        enabled: defineProtocolLiteral(false),
        deletionState: defineProtocolLiteral('finalizingDelete'),
    }, { policy: 'closed' }),
]);

export const ConversationBindingV1Schema = ConversationBindingV1ProtocolSchema;
export type ConversationBindingV1 = ReturnType<typeof ConversationBindingV1Schema.parse>;
export const ConversationBindingV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationBindingV1Schema.jsonSchema)();
