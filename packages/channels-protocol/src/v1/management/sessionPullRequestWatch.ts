import {
    defineProtocolArray, defineProtocolLiteral, defineProtocolObject,
    defineProtocolString, defineProtocolUnion, ProtocolCollectionOpaqueCursorV1Schema,
} from '@happier-dev/plugin-sdk/protocol';
import type { ProtocolComposableSchema, ProtocolSchemaInput, ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { ActionSessionAddressV1Schema, SessionIdSchema, SessionTargetV1Schema,
    SessionInputForgeEvidenceV1Schema, SessionMessageSendResultV1ProtocolSchema,
    PluginSessionInputAttachmentsV1ProtocolSchema } from '@happier-dev/plugin-sdk/sessions';
import { ConversationBindingIdV1Schema, ConversationCollectionRowRevisionV1ProtocolSchema } from '../identity.js';
import { ConversationPullRequestV1Schema } from './sessionPullRequestBindings.js';

import {
    SessionPullRequestFixAttemptLimitV1Schema,
    SessionPullRequestFixProgressV1Schema,
    SessionPullRequestFixSubjectV1Schema,
    SessionPullRequestLatestUpdateV1Schema,
    SessionPullRequestWatchBindingReadV1Schema,
    SessionPullRequestWatchBindingV1Schema,
    SessionPullRequestWatchModeV1Schema,
    SessionPullRequestWatchPolicyV1Schema,
    SessionPullRequestWatchStateV1Schema,
} from '@happier-dev/plugin-sdk/protocol';

export {
    SessionPullRequestBindingMetadataFieldsV1,
    SessionPullRequestFixAttemptLimitV1Schema,
    SessionPullRequestFixProgressV1Schema,
    SessionPullRequestFixSubjectV1Schema,
    SessionPullRequestLatestUpdateV1Schema,
    SessionPullRequestWatchBindingReadV1Schema,
    SessionPullRequestWatchBindingV1Schema,
    SessionPullRequestWatchModeV1Schema,
    SessionPullRequestWatchPolicyV1Schema,
    SessionPullRequestWatchStateV1Schema,
} from '@happier-dev/plugin-sdk/protocol';
export type {
    SessionPullRequestFixProgressV1,
    SessionPullRequestFixSubjectV1,
    SessionPullRequestWatchModeV1,
    SessionPullRequestWatchPolicyV1,
    SessionPullRequestWatchStateV1,
} from '@happier-dev/plugin-sdk/protocol';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1 });
export const SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1 = 'session-pull-request-watch-v1';
/** Declared Account Settings ids; Settings owns their effective values/defaults. */
export const SESSION_PULL_REQUEST_WATCH_SETTINGS = {
    defaultMode: 'pr-watch-default-mode', fixAttemptLimit: 'pr-watch-fix-attempt-limit',
    archiveAfterMerge: 'pr-watch-archive-after-merge',
} as const;
const bindings = defineProtocolArray(SessionPullRequestWatchBindingReadV1Schema);
const unavailableReason = defineProtocolUnion([defineProtocolLiteral('locked'), defineProtocolLiteral('unavailable'), defineProtocolLiteral('sessionUnavailable')]);
export const SessionPullRequestWatchReadResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('ready'), sessionId: SessionIdSchema, bindings }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), sessionId: SessionIdSchema, reason: unavailableReason }, closed),
]);
export type SessionPullRequestWatchReadResultV1 = ReturnType<typeof SessionPullRequestWatchReadResultV1Schema.parse>;
export const SessionPullRequestWatchListResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('ready'), sessions: defineProtocolArray(defineProtocolObject({
        session: ActionSessionAddressV1Schema, bindings,
    }, closed)), nextCursor: ProtocolCollectionOpaqueCursorV1Schema.nullable() }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), reason: unavailableReason }, closed),
]);
const mutationIdentity = { sessionId: SessionTargetV1Schema, bindingId: ConversationBindingIdV1Schema,
    expectedRevision: ConversationCollectionRowRevisionV1ProtocolSchema };
/** Source preparation stays with the caller; only the final send enters Watch custody. */
export const SessionPullRequestConfiguredFixInputV1Schema = defineProtocolObject({
    kind: defineProtocolLiteral('deliverConfiguredFix'), ...mutationIdentity,
    pullRequest: ConversationPullRequestV1Schema, expectedHeadSha: text,
    delivery: defineProtocolObject({ idempotencyKey: text, text: defineProtocolString(),
        attachments: PluginSessionInputAttachmentsV1ProtocolSchema.optional(),
        forgeEvidence: SessionInputForgeEvidenceV1Schema.optional(),
    }, closed),
}, closed);
export type SessionPullRequestConfiguredFixInputV1 = ReturnType<typeof SessionPullRequestConfiguredFixInputV1Schema.parse>;
type ConfiguredFixResult<TSendResult> =
    | { kind: 'configuredFixResult'; result: TSendResult }
    | { kind: 'configuredFixHeld'; reason: 'outstanding' | 'exhausted' }
    | { kind: 'configuredFixUncertain' };
export type SessionPullRequestConfiguredFixResultV1 = ConfiguredFixResult<ProtocolSchemaOutput<typeof SessionMessageSendResultV1ProtocolSchema>>;
export const SessionPullRequestConfiguredFixResultV1Schema: ProtocolComposableSchema<
    ConfiguredFixResult<ProtocolSchemaInput<typeof SessionMessageSendResultV1ProtocolSchema>>,
    SessionPullRequestConfiguredFixResultV1
> = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('configuredFixResult'), result: SessionMessageSendResultV1ProtocolSchema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('configuredFixHeld'), reason: defineProtocolUnion([
        defineProtocolLiteral('outstanding'), defineProtocolLiteral('exhausted'),
    ]) }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('configuredFixUncertain') }, closed),
]);
export const SessionPullRequestWatchInputV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('get'), sessionId: SessionTargetV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('list'), cursor: ProtocolCollectionOpaqueCursorV1Schema.optional() }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('configure'), ...mutationIdentity, policy: SessionPullRequestWatchPolicyV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('retryFix'), ...mutationIdentity }, closed),
    SessionPullRequestConfiguredFixInputV1Schema,
]);
export type SessionPullRequestWatchInputV1 = ReturnType<typeof SessionPullRequestWatchInputV1Schema.parse>;
type WatchUpdatedResult = {
    kind: 'updated'; bindingId: ProtocolSchemaOutput<typeof ConversationBindingIdV1Schema>;
    revision: ProtocolSchemaOutput<typeof ConversationCollectionRowRevisionV1ProtocolSchema>;
};
export type SessionPullRequestWatchResultV1 = SessionPullRequestWatchReadResultV1
    | ProtocolSchemaOutput<typeof SessionPullRequestWatchListResultV1Schema>
    | SessionPullRequestConfiguredFixResultV1 | WatchUpdatedResult;
export const SessionPullRequestWatchResultV1Schema: ProtocolComposableSchema<
    ProtocolSchemaInput<typeof SessionPullRequestWatchReadResultV1Schema>
    | ProtocolSchemaInput<typeof SessionPullRequestWatchListResultV1Schema>
    | ProtocolSchemaInput<typeof SessionPullRequestConfiguredFixResultV1Schema> | WatchUpdatedResult,
    SessionPullRequestWatchResultV1
> = defineProtocolUnion([
    SessionPullRequestWatchReadResultV1Schema, SessionPullRequestWatchListResultV1Schema,
    SessionPullRequestConfiguredFixResultV1Schema,
    defineProtocolObject({ kind: defineProtocolLiteral('updated'), bindingId: ConversationBindingIdV1Schema,
        revision: ConversationCollectionRowRevisionV1ProtocolSchema }, closed),
]);

export const SessionPullRequestWatchModeV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestWatchModeV1Schema.jsonSchema)();
export const SessionPullRequestFixAttemptLimitV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestFixAttemptLimitV1Schema.jsonSchema)();
export const SessionPullRequestWatchPolicyV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestWatchPolicyV1Schema.jsonSchema)();
export const SessionPullRequestFixSubjectV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestFixSubjectV1Schema.jsonSchema)();
export const SessionPullRequestFixProgressV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestFixProgressV1Schema.jsonSchema)();
export const SessionPullRequestWatchBindingV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestWatchBindingV1Schema.jsonSchema)();
export const SessionPullRequestWatchStateV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestWatchStateV1Schema.jsonSchema)();
export const SessionPullRequestLatestUpdateV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestLatestUpdateV1Schema.jsonSchema)();
export const SessionPullRequestWatchBindingReadV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestWatchBindingReadV1Schema.jsonSchema)();
export const SessionPullRequestWatchReadResultV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestWatchReadResultV1Schema.jsonSchema)();
export const SessionPullRequestWatchListResultV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestWatchListResultV1Schema.jsonSchema)();
export const SessionPullRequestConfiguredFixInputV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestConfiguredFixInputV1Schema.jsonSchema)();
export const SessionPullRequestConfiguredFixResultV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestConfiguredFixResultV1Schema.jsonSchema)();
export const SessionPullRequestWatchInputV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestWatchInputV1Schema.jsonSchema)();
export const SessionPullRequestWatchResultV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestWatchResultV1Schema.jsonSchema)();
