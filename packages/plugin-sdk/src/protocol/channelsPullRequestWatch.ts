import { PLUGIN_COLLECTION_REVISION_MAX } from '@happier-dev/protocol/plugins/data/collectionLimitsV1';
import { ScmHostingProviderKindProtocolSchema } from '@happier-dev/protocol/scm/pullRequests';

import {
    ConversationPullRequestStateV1Fields,
    ConversationPullRequestV1Fields,
} from './conversationDelivery.js';
import {
    defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
    defineProtocolString, defineProtocolUnion,
} from './protocolFacade.js';
import { PluginUiResourceIntentV1Schema } from './resourceIntent.js';

export const MAX_CONVERSATION_CHANNEL_RELATION_ID_ASCII_BYTES = 96;

/** Printable ASCII keeps the character and UTF-8 byte limits identical. */
export const CONVERSATION_CHANNEL_RELATION_ID_PRINTABLE_ASCII_PATTERN_V1 = '^[\\x21-\\x7E]+$';

export const ConversationChannelRelationIdV1ProtocolSchema = defineProtocolString({
    minLength: 1,
    maxLength: MAX_CONVERSATION_CHANNEL_RELATION_ID_ASCII_BYTES,
    pattern: CONVERSATION_CHANNEL_RELATION_ID_PRINTABLE_ASCII_PATTERN_V1,
});

/**
 * Witness of one exact Account Collection row revision.
 *
 * Binding, obligation, frontier, and delivery-custody revision witnesses name
 * that row's `PluginCollectionRow.revision`. Connection management instead
 * projects its logical configuration revision, initialized by migration from
 * the physical row revision and advanced only by semantic connection changes.
 * It cannot advance faster than the physical row. Their ceiling therefore
 * belongs to the Collection owner's persisted `Int` column, not to a Channels
 * policy number: admitting a wider value would let a caller name an exact-CAS
 * revision only the SQLite provider can ever reproduce.
 *
 * Authority epochs and Channels-owned payload counters are separate spaces that
 * this package advances itself, and they keep their own safe-integer bound.
 */
export const ConversationCollectionRowRevisionV1ProtocolSchema = defineProtocolNumber({
    integer: true,
    minimum: 1,
    maximum: PLUGIN_COLLECTION_REVISION_MAX,
});

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1 });
const integer = defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const modes = ['off', 'notify', 'analyse', 'address', 'autoFix'] as const;

export const SessionPullRequestLinkV1Schema = defineProtocolObject({
    provider: ScmHostingProviderKindProtocolSchema,
    ...ConversationPullRequestV1Fields,
    url: defineProtocolString({ minLength: 1 }),
    state: ConversationPullRequestStateV1Fields.state.optional(),
    observedAt: ConversationPullRequestStateV1Fields.observedAt.optional(),
  }, { policy: 'closed' });

export const SessionPullRequestUpdateEventKindV1Schema = defineProtocolUnion([
    defineProtocolLiteral('comment'), defineProtocolLiteral('inlineComment'), defineProtocolLiteral('review'),
    defineProtocolLiteral('check'), defineProtocolLiteral('conflict'), defineProtocolLiteral('push'),
    defineProtocolLiteral('merged'), defineProtocolLiteral('closed'),
]);

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
    bindingId: ConversationChannelRelationIdV1ProtocolSchema, revision: ConversationCollectionRowRevisionV1ProtocolSchema,
    link: SessionPullRequestLinkV1Schema, watch: SessionPullRequestWatchStateV1Schema,
    latestUpdate: SessionPullRequestLatestUpdateV1Schema.nullable(),
} as const;
export const SessionPullRequestWatchBindingReadV1Schema = defineProtocolObject(SessionPullRequestBindingMetadataFieldsV1, closed);
