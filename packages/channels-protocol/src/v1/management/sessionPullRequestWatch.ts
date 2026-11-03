import {
    defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
    defineProtocolString, defineProtocolUnion, ProtocolCollectionOpaqueCursorV1Schema,
    PluginUiResourceIntentV1Schema,
} from '@happier-dev/plugin-sdk/protocol';
import { ActionSessionAddressV1Schema, SessionIdSchema, SessionTargetV1Schema,
    SessionInputForgeEvidenceV1Schema, SessionMessageSendResultV1ProtocolSchema,
    PluginSessionInputAttachmentsV1ProtocolSchema } from '@happier-dev/plugin-sdk/sessions';
import { ConversationBindingIdV1Schema, ConversationCollectionRowRevisionV1ProtocolSchema } from '../identity.js';
import { ConversationPullRequestV1Schema, SessionPullRequestLinkV1Schema } from './sessionPullRequestBindings.js';
import { SessionPullRequestUpdateEventKindV1Schema } from './sessionPullRequestUpdates.js';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1 });
const integer = defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const modes = ['off', 'notify', 'analyse', 'address', 'autoFix'] as const;
export const SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1 = 'session-pull-request-watch-v1';
/** Declared Account Settings ids; Settings owns their effective values/defaults. */
export const SESSION_PULL_REQUEST_WATCH_SETTINGS = {
    defaultMode: 'pr-watch-default-mode', fixAttemptLimit: 'pr-watch-fix-attempt-limit',
    archiveAfterMerge: 'pr-watch-archive-after-merge',
} as const;
export const SessionPullRequestWatchModeV1Schema = defineProtocolUnion([
    defineProtocolLiteral(modes[0]), defineProtocolLiteral(modes[1]), defineProtocolLiteral(modes[2]),
    defineProtocolLiteral(modes[3]), defineProtocolLiteral(modes[4]),
]);
export type SessionPullRequestWatchModeV1 = ReturnType<typeof SessionPullRequestWatchModeV1Schema.parse>;
export const SessionPullRequestFixAttemptLimitV1Schema = defineProtocolNumber({ integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER }).nullable();
export const SessionPullRequestWatchPolicyV1Schema = defineProtocolObject({
    mode: SessionPullRequestWatchModeV1Schema, archiveAfterMerge: boolean,
}, closed);
export type SessionPullRequestWatchPolicyV1 = ReturnType<typeof SessionPullRequestWatchPolicyV1Schema.parse>;
export const SessionPullRequestFixSubjectV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('check'), logicalCheckId: text }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('feedback') }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('configuredFix') }, closed),
]);
export type SessionPullRequestFixSubjectV1 = ReturnType<typeof SessionPullRequestFixSubjectV1Schema.parse>;
/** Retained on the existing binding; accepted-input custody owns per-round replay evidence. */
export const SessionPullRequestFixProgressV1Schema = defineProtocolObject({
    roundsStarted: integer,
    continuationRounds: integer,
    cause: SessionPullRequestFixSubjectV1Schema.optional(),
    sourceHeadSha: text.optional(),
    pendingSequenceEnd: defineProtocolLiteral(true).optional(),
    activeRound: defineProtocolObject({
        obligationId: text, localId: text.optional(), started: boolean,
    }, closed).optional(),
}, closed);
export type SessionPullRequestFixProgressV1 = ReturnType<typeof SessionPullRequestFixProgressV1Schema.parse>;
export const SessionPullRequestWatchBindingV1Schema = defineProtocolObject({
    policy: SessionPullRequestWatchPolicyV1Schema,
    progress: SessionPullRequestFixProgressV1Schema.optional(),
}, closed);
export const SessionPullRequestWatchStateV1Schema = defineProtocolObject({
    policy: SessionPullRequestWatchPolicyV1Schema,
    reason: defineProtocolUnion([defineProtocolLiteral('paused'), defineProtocolLiteral('exhausted'),
        defineProtocolLiteral('credentials'), defineProtocolLiteral('terminal')]).nullable(),
    fixAttemptLimit: SessionPullRequestFixAttemptLimitV1Schema,
    roundsStarted: integer,
    watchingMachine: defineProtocolObject({ serverId: text, machineId: text, label: text }, closed).nullable(),
    progress: SessionPullRequestFixProgressV1Schema.optional(),
}, closed);
export type SessionPullRequestWatchStateV1 = ReturnType<typeof SessionPullRequestWatchStateV1Schema.parse>;
export const SessionPullRequestLatestUpdateV1Schema = defineProtocolObject({
    occurrenceId: text, occurredAtMs: integer, kinds: defineProtocolArray(SessionPullRequestUpdateEventKindV1Schema), summary: defineProtocolString(), summaryTruncated: boolean,
    location: defineProtocolUnion([
        defineProtocolObject({ kind: defineProtocolLiteral('sessionInput'), localId: text }, closed),
        defineProtocolObject({ kind: defineProtocolLiteral('provider'), url: text,
            resource: PluginUiResourceIntentV1Schema.optional() }, closed),
    ]),
}, closed);
/** The same metadata fields compose read projections without exposing private revision grammar. */
export const SessionPullRequestBindingMetadataFieldsV1 = {
    bindingId: ConversationBindingIdV1Schema, revision: ConversationCollectionRowRevisionV1ProtocolSchema,
    link: SessionPullRequestLinkV1Schema, watch: SessionPullRequestWatchStateV1Schema,
    latestUpdate: SessionPullRequestLatestUpdateV1Schema.nullable(),
} as const;
export const SessionPullRequestWatchBindingReadV1Schema = defineProtocolObject(SessionPullRequestBindingMetadataFieldsV1, closed);
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
export const SessionPullRequestConfiguredFixResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('configuredFixResult'), result: SessionMessageSendResultV1ProtocolSchema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('configuredFixHeld'), reason: defineProtocolUnion([
        defineProtocolLiteral('outstanding'), defineProtocolLiteral('exhausted'),
    ]) }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('configuredFixUncertain') }, closed),
]);
export type SessionPullRequestConfiguredFixResultV1 = ReturnType<typeof SessionPullRequestConfiguredFixResultV1Schema.parse>;
export const SessionPullRequestWatchInputV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('get'), sessionId: SessionTargetV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('list'), cursor: ProtocolCollectionOpaqueCursorV1Schema.optional() }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('configure'), ...mutationIdentity, policy: SessionPullRequestWatchPolicyV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('retryFix'), ...mutationIdentity }, closed),
    SessionPullRequestConfiguredFixInputV1Schema,
]);
export type SessionPullRequestWatchInputV1 = ReturnType<typeof SessionPullRequestWatchInputV1Schema.parse>;
export const SessionPullRequestWatchResultV1Schema = defineProtocolUnion([
    SessionPullRequestWatchReadResultV1Schema, SessionPullRequestWatchListResultV1Schema,
    SessionPullRequestConfiguredFixResultV1Schema,
    defineProtocolObject({ kind: defineProtocolLiteral('updated'), bindingId: ConversationBindingIdV1Schema,
        revision: ConversationCollectionRowRevisionV1ProtocolSchema }, closed),
]);
export type SessionPullRequestWatchResultV1 = ReturnType<typeof SessionPullRequestWatchResultV1Schema.parse>;

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
