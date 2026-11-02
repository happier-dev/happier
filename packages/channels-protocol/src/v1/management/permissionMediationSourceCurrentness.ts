import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolUtf8String,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

/**
 * Exact accepted source witness supplied back to the Channels authority owner.
 * The bounds are copied from the incumbent Session permission source fields;
 * they are transport bounds, not a new Workflow limit.
 */
export const ConversationPermissionMediationSourceCurrentnessInputV1Schema = defineProtocolObject({
    sourceRef: defineProtocolUtf8String({ minLength: 1, maxUtf8Bytes: 256 }),
    sourceRevisionOrEpoch: defineProtocolUtf8String({ minLength: 1, maxUtf8Bytes: 128 }),
    remoteApprovalMaxScope: defineProtocolUnion([
        defineProtocolLiteral('off'),
        defineProtocolLiteral('request'),
        defineProtocolLiteral('session'),
    ]),
}, { policy: 'closed' });
export type ConversationPermissionMediationSourceCurrentnessInputV1 = ReturnType<
    typeof ConversationPermissionMediationSourceCurrentnessInputV1Schema.parse
>;
export const ConversationPermissionMediationSourceCurrentnessInputV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationPermissionMediationSourceCurrentnessInputV1Schema.jsonSchema)();

/** Opaque current/not-current answer; retained binding details never leave the owner. */
export const ConversationPermissionMediationSourceCurrentnessResultV1Schema = defineProtocolObject({
    current: defineProtocolUnion([
        defineProtocolLiteral(true),
        defineProtocolLiteral(false),
    ]),
}, { policy: 'closed' });
export type ConversationPermissionMediationSourceCurrentnessResultV1 = ReturnType<
    typeof ConversationPermissionMediationSourceCurrentnessResultV1Schema.parse
>;
export const ConversationPermissionMediationSourceCurrentnessResultV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationPermissionMediationSourceCurrentnessResultV1Schema.jsonSchema)();
