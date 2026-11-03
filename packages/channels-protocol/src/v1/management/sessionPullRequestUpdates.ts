import { ForgeCiFailureSummaryV1Schema } from '../ci/failureSummary.js';
import { forgeCiRepositoryIdentityV1Schema } from '../ci/identity.js';
import {
    defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
    defineProtocolString, defineProtocolUnion, defineProtocolUtf8String,
    PluginUiResourceIntentV1Schema,
} from '@happier-dev/plugin-sdk/protocol';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';
import { ConversationBindingIdV1Schema } from '../identity.js';
import { MAX_CONVERSATION_OCCURRENCE_ID_UTF8_BYTES } from '../bounds.js';
import { ConversationPullRequestV1Schema } from './sessionPullRequestBindings.js';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1 });
const body = defineProtocolString();
const time = defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const author = defineProtocolObject({
    principalId: text.nullable(),
    kind: defineProtocolUnion([defineProtocolLiteral('person'), defineProtocolLiteral('bot'),
        defineProtocolLiteral('process'), defineProtocolLiteral('unknown')]),
    label: defineProtocolString().optional(),
}, closed);
const eventFields = { id: text, revision: text, occurredAt: time, url: text.optional(),
    resource: PluginUiResourceIntentV1Schema.optional(), author };
export const SessionPullRequestHeadV1Schema = defineProtocolObject({
    sha: text, ref: text, repository: forgeCiRepositoryIdentityV1Schema.optional(),
}, closed);
export const SessionPullRequestUpdateEventKindV1Schema = defineProtocolUnion([
    defineProtocolLiteral('comment'), defineProtocolLiteral('inlineComment'), defineProtocolLiteral('review'),
    defineProtocolLiteral('check'), defineProtocolLiteral('conflict'), defineProtocolLiteral('push'),
    defineProtocolLiteral('merged'), defineProtocolLiteral('closed'),
]);

/** Original provider evidence. No event can select a mode or grant execution authority. */
export const SessionPullRequestUpdateEventV1Schema = defineProtocolUnion([
    defineProtocolObject({ ...eventFields, kind: defineProtocolLiteral('comment'), body }, closed),
    defineProtocolObject({ ...eventFields, kind: defineProtocolLiteral('inlineComment'), body,
        reviewId: text.optional(), threadId: text.optional(), path: text,
        line: defineProtocolNumber({ integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER }).nullable(),
        diffHunk: body, inReplyToId: text.optional(),
    }, closed),
    defineProtocolObject({ ...eventFields, kind: defineProtocolLiteral('review'), body,
        verdict: defineProtocolUnion([defineProtocolLiteral('approved'), defineProtocolLiteral('changesRequested'),
            defineProtocolLiteral('commented'), defineProtocolLiteral('dismissed'), defineProtocolLiteral('pending')]),
        inlineCommentIds: defineProtocolArray(text),
    }, closed),
    defineProtocolObject({ ...eventFields, kind: defineProtocolLiteral('check'), logicalCheckId: text,
        name: body, state: defineProtocolLiteral('failed'),
        failure: defineProtocolUnion([
            defineProtocolObject({ kind: defineProtocolLiteral('summary'), summary: ForgeCiFailureSummaryV1Schema }, closed),
            defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), reason: text }, closed),
        ]),
    }, closed),
    defineProtocolObject({ ...eventFields, kind: defineProtocolLiteral('check'), logicalCheckId: text,
        name: body, state: defineProtocolUnion([defineProtocolLiteral('passed'), defineProtocolLiteral('finished')]),
    }, closed),
    defineProtocolObject({ ...eventFields, kind: defineProtocolLiteral('conflict'), mergeable: defineProtocolLiteral(false) }, closed),
    defineProtocolObject({ ...eventFields, kind: defineProtocolLiteral('push'), sha: text, ref: text,
        writer: defineProtocolUnion([defineProtocolLiteral('own'), defineProtocolLiteral('other'), defineProtocolLiteral('unknown')]),
    }, closed),
    defineProtocolObject({ ...eventFields, kind: defineProtocolLiteral('merged') }, closed),
    defineProtocolObject({ ...eventFields, kind: defineProtocolLiteral('closed') }, closed),
]);
export type SessionPullRequestUpdateEventV1 = ReturnType<typeof SessionPullRequestUpdateEventV1Schema.parse>;

/** Provider-side single event; Channels supplies frozen binding and Session identity at custody. */
export const ConversationPullRequestUpdateObservationV1Schema = defineProtocolObject({
    head: SessionPullRequestHeadV1Schema, event: SessionPullRequestUpdateEventV1Schema,
}, closed);

/** One classified cycle's frozen members for one exact binding and PR. */
export const SessionPullRequestUpdateContinuationV1Schema = defineProtocolObject({
    firstOccurrenceId: defineProtocolUtf8String({ minLength: 1, maxUtf8Bytes: MAX_CONVERSATION_OCCURRENCE_ID_UTF8_BYTES }),
    hasMore: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]),
}, closed);
export const SessionPullRequestUpdateV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1), bindingId: ConversationBindingIdV1Schema, sessionId: SessionIdSchema,
    pullRequest: ConversationPullRequestV1Schema, head: SessionPullRequestHeadV1Schema,
    events: defineProtocolArray(SessionPullRequestUpdateEventV1Schema, { minItems: 1 }),
    continuation: SessionPullRequestUpdateContinuationV1Schema.optional(),
}, closed);
export type SessionPullRequestUpdateV1 = ReturnType<typeof SessionPullRequestUpdateV1Schema.parse>;

export const SessionPullRequestHeadV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestHeadV1Schema.jsonSchema)();
export const SessionPullRequestUpdateEventKindV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestUpdateEventKindV1Schema.jsonSchema)();
export const SessionPullRequestUpdateEventV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestUpdateEventV1Schema.jsonSchema)();
export const ConversationPullRequestUpdateObservationV1JsonSchema = /* @__PURE__ */ (() => ConversationPullRequestUpdateObservationV1Schema.jsonSchema)();
export const SessionPullRequestUpdateContinuationV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestUpdateContinuationV1Schema.jsonSchema)();
export const SessionPullRequestUpdateV1JsonSchema = /* @__PURE__ */ (() => SessionPullRequestUpdateV1Schema.jsonSchema)();
