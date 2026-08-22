import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    defineProtocolUtf8String,
    defineProtocolUniqueArray,
} from '@happier-dev/plugin-sdk/protocol';

import {
    CONVERSATION_ENDPOINT_AUDIENCES_V1,
    CONVERSATION_ENDPOINT_KINDS_V1,
    MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS,
    MAX_CONVERSATION_ENDPOINT_RESOLUTION_INPUT_UTF8_BYTES,
    MAX_CONVERSATION_ENDPOINT_STABLE_ID_UTF8_BYTES,
    MAX_CONVERSATION_RESOLUTION_CANDIDATES,
} from '../bounds.js';
import { ConversationProviderFailureV1ProtocolSchema } from '../diagnostics.js';
import { ConversationProviderConnectionInputV1Fields } from './connection.js';

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationEndpointStableIdV1ProtocolSchema = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_ENDPOINT_STABLE_ID_UTF8_BYTES,
    minLength: 1,
});

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationEndpointDisplayLabelV1ProtocolSchema = defineProtocolString({
    minLength: 1,
    maxLength: MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS,
});

const endpointAudienceV1 = defineProtocolUnion([
    defineProtocolLiteral(CONVERSATION_ENDPOINT_AUDIENCES_V1[0]),
    defineProtocolLiteral(CONVERSATION_ENDPOINT_AUDIENCES_V1[1]),
]);

const endpointFields = {
    id: ConversationEndpointStableIdV1ProtocolSchema,
    parentId: ConversationEndpointStableIdV1ProtocolSchema.optional(),
    label: ConversationEndpointDisplayLabelV1ProtocolSchema.optional(),
    parentLabel: ConversationEndpointDisplayLabelV1ProtocolSchema.optional(),
};

const endpointIdentityFields = {
    id: ConversationEndpointStableIdV1ProtocolSchema,
    parentId: ConversationEndpointStableIdV1ProtocolSchema.optional(),
};

const conversationResolvedDirectEndpointV1 = defineProtocolObject({
    kind: defineProtocolLiteral('direct'),
    audience: defineProtocolLiteral('direct'),
    ...endpointFields,
}, { policy: 'closed' });

const conversationResolvedSharedEndpointV1 = defineProtocolObject({
    kind: defineProtocolLiteral('shared'),
    audience: defineProtocolLiteral('shared'),
    ...endpointFields,
}, { policy: 'closed' });

const conversationResolvedThreadEndpointV1 = defineProtocolObject({
    kind: defineProtocolLiteral('thread'),
    audience: endpointAudienceV1,
    ...endpointFields,
}, { policy: 'closed' });

const conversationResolvedGithubIssueEndpointV1 = defineProtocolObject({
    kind: defineProtocolLiteral('githubIssue'),
    audience: defineProtocolLiteral('shared'),
    ...endpointFields,
}, { policy: 'closed' });

const conversationResolvedGithubPullRequestEndpointV1 = defineProtocolObject({
    kind: defineProtocolLiteral('githubPullRequest'),
    audience: defineProtocolLiteral('shared'),
    ...endpointFields,
}, { policy: 'closed' });

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationResolvedEndpointV1ProtocolSchema = defineProtocolUnion([
    conversationResolvedDirectEndpointV1,
    conversationResolvedSharedEndpointV1,
    conversationResolvedThreadEndpointV1,
    conversationResolvedGithubIssueEndpointV1,
    conversationResolvedGithubPullRequestEndpointV1,
]);

/** The bounded provider-authenticated endpoint shape used across Channels V1. */
export const ConversationResolvedEndpointV1Schema = ConversationResolvedEndpointV1ProtocolSchema;
export type ConversationResolvedEndpointV1 = ReturnType<typeof ConversationResolvedEndpointV1Schema.parse>;
export const ConversationResolvedEndpointV1JsonSchema: PluginJsonSchema = ConversationResolvedEndpointV1Schema.jsonSchema;

const conversationEndpointIdentityDirectV1 = defineProtocolObject({
    kind: defineProtocolLiteral('direct'),
    audience: defineProtocolLiteral('direct'),
    ...endpointIdentityFields,
}, { policy: 'closed' });

const conversationEndpointIdentitySharedV1 = defineProtocolObject({
    kind: defineProtocolLiteral('shared'),
    audience: defineProtocolLiteral('shared'),
    ...endpointIdentityFields,
}, { policy: 'closed' });

const conversationEndpointIdentityThreadV1 = defineProtocolObject({
    kind: defineProtocolLiteral('thread'),
    audience: endpointAudienceV1,
    ...endpointIdentityFields,
}, { policy: 'closed' });

const conversationEndpointIdentityGithubIssueV1 = defineProtocolObject({
    kind: defineProtocolLiteral('githubIssue'),
    audience: defineProtocolLiteral('shared'),
    ...endpointIdentityFields,
}, { policy: 'closed' });

const conversationEndpointIdentityGithubPullRequestV1 = defineProtocolObject({
    kind: defineProtocolLiteral('githubPullRequest'),
    audience: defineProtocolLiteral('shared'),
    ...endpointIdentityFields,
}, { policy: 'closed' });

/** @internal Relative-only endpoint identity selection input for composed Channels schemas. */
export const ConversationEndpointIdentityV1ProtocolSchema = defineProtocolUnion([
    conversationEndpointIdentityDirectV1,
    conversationEndpointIdentitySharedV1,
    conversationEndpointIdentityThreadV1,
    conversationEndpointIdentityGithubIssueV1,
    conversationEndpointIdentityGithubPullRequestV1,
]);

/** Immutable endpoint identity; display labels are intentionally excluded. */
export const ConversationEndpointIdentityV1Schema = ConversationEndpointIdentityV1ProtocolSchema;
export type ConversationEndpointIdentityV1 = ReturnType<typeof ConversationEndpointIdentityV1Schema.parse>;
export const ConversationEndpointIdentityV1JsonSchema: PluginJsonSchema =
    ConversationEndpointIdentityV1Schema.jsonSchema;

/** Compares only the provider-authenticated endpoint identity, never presentation labels. */
export function areConversationEndpointIdentitiesEqual(
    left: ConversationEndpointIdentityV1 | ConversationResolvedEndpointV1,
    right: ConversationEndpointIdentityV1 | ConversationResolvedEndpointV1,
): boolean {
    return left.kind === right.kind
        && left.audience === right.audience
        && left.id === right.id
        && left.parentId === right.parentId;
}

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationResolvedPrincipalV1ProtocolSchema = defineProtocolObject({
    id: ConversationEndpointStableIdV1ProtocolSchema,
    label: ConversationEndpointDisplayLabelV1ProtocolSchema.optional(),
    kind: defineProtocolUnion([
        defineProtocolLiteral('human'),
        defineProtocolLiteral('integration'),
        defineProtocolLiteral('bot'),
    ]),
}, { policy: 'closed' });

/** The bounded immutable provider principal returned by provider resolution. */
export const ConversationResolvedPrincipalV1Schema = ConversationResolvedPrincipalV1ProtocolSchema;
export type ConversationResolvedPrincipalV1 = ReturnType<typeof ConversationResolvedPrincipalV1Schema.parse>;
export const ConversationResolvedPrincipalV1JsonSchema: PluginJsonSchema = ConversationResolvedPrincipalV1Schema.jsonSchema;

/** @internal Relative-only bounded query shared by provider and management resolution schemas. */
export const ConversationResolutionQueryV1ProtocolSchema = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_ENDPOINT_RESOLUTION_INPUT_UTF8_BYTES,
    minLength: 1,
});

/** @internal Relative-only endpoint-kind selection shared by provider and management resolution schemas. */
export const ConversationEndpointResolveKindsV1ProtocolSchema = defineProtocolUniqueArray(
    defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_ENDPOINT_KINDS_V1[0]),
        defineProtocolLiteral(CONVERSATION_ENDPOINT_KINDS_V1[1]),
        defineProtocolLiteral(CONVERSATION_ENDPOINT_KINDS_V1[2]),
        defineProtocolLiteral(CONVERSATION_ENDPOINT_KINDS_V1[3]),
        defineProtocolLiteral(CONVERSATION_ENDPOINT_KINDS_V1[4]),
    ]),
    { minItems: 1, maxItems: CONVERSATION_ENDPOINT_KINDS_V1.length },
);

/** @internal Relative-only input for the optional endpoint-resolution role. */
export const ConversationEndpointResolveInputV1ProtocolSchema = defineProtocolObject({
    ...ConversationProviderConnectionInputV1Fields,
    query: ConversationResolutionQueryV1ProtocolSchema,
    kinds: ConversationEndpointResolveKindsV1ProtocolSchema.optional(),
}, { policy: 'closed' });

export const ConversationEndpointResolveInputV1Schema = ConversationEndpointResolveInputV1ProtocolSchema;
export type ConversationEndpointResolveInputV1 = ReturnType<
    typeof ConversationEndpointResolveInputV1Schema.parse
>;
export const ConversationEndpointResolveInputV1JsonSchema: PluginJsonSchema =
    ConversationEndpointResolveInputV1Schema.jsonSchema;

/** @internal Relative-only input for the optional principal-resolution role. */
export const ConversationPrincipalResolveInputV1ProtocolSchema = defineProtocolObject({
    ...ConversationProviderConnectionInputV1Fields,
    endpoint: ConversationResolvedEndpointV1ProtocolSchema,
    query: ConversationResolutionQueryV1ProtocolSchema,
}, { policy: 'closed' });

export const ConversationPrincipalResolveInputV1Schema = ConversationPrincipalResolveInputV1ProtocolSchema;
export type ConversationPrincipalResolveInputV1 = ReturnType<
    typeof ConversationPrincipalResolveInputV1Schema.parse
>;
export const ConversationPrincipalResolveInputV1JsonSchema: PluginJsonSchema =
    ConversationPrincipalResolveInputV1Schema.jsonSchema;

/** Compares provider and management resolution candidates by canonical `(label, id)` order. */
export function compareCanonicalConversationResolutionCandidatesV1<
    TCandidate extends Readonly<{ id: string; label?: string }>,
>(
    left: TCandidate,
    right: TCandidate,
): number {
    const leftLabel = left.label ?? '';
    const rightLabel = right.label ?? '';
    if (leftLabel === rightLabel) {
        if (left.id === right.id) return 0;
        return left.id > right.id ? 1 : -1;
    }
    return leftLabel > rightLabel ? 1 : -1;
}

/** Checks provider and management resolution results for canonical order and unique IDs. */
export function hasCanonicalConversationResolutionCandidateOrderV1<
    TCandidate extends Readonly<{ id: string; label?: string }>,
>(
    candidates: readonly TCandidate[],
): boolean {
    const ids = new Set<string>();
    let previous: TCandidate | undefined;

    for (const candidate of candidates) {
        if (ids.has(candidate.id)) return false;
        ids.add(candidate.id);
        if (previous !== undefined) {
            if (compareCanonicalConversationResolutionCandidatesV1(previous, candidate) > 0) return false;
        }
        previous = candidate;
    }

    return true;
}

/** @internal Relative-only bounded endpoint candidate set shared with the management resolver. */
export const ConversationResolvedEndpointCandidatesV1ProtocolSchema = defineProtocolUniqueArray(
    ConversationResolvedEndpointV1ProtocolSchema,
    { maxItems: MAX_CONVERSATION_RESOLUTION_CANDIDATES },
);

/** @internal Relative-only bounded principal candidate set shared with the management resolver. */
export const ConversationResolvedPrincipalCandidatesV1ProtocolSchema = defineProtocolUniqueArray(
    ConversationResolvedPrincipalV1ProtocolSchema,
    { maxItems: MAX_CONVERSATION_RESOLUTION_CANDIDATES },
);

const conversationEndpointResolveResolvedV1 = defineProtocolObject({
    kind: defineProtocolLiteral('resolved'),
    candidates: ConversationResolvedEndpointCandidatesV1ProtocolSchema,
}, { policy: 'closed' });

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationEndpointResolveResultV1ProtocolSchema = defineProtocolUnion([
    conversationEndpointResolveResolvedV1,
    ConversationProviderFailureV1ProtocolSchema,
]);

/** Provider endpoint-resolution result; connection-bearing request input remains EU24-held. */
export const ConversationEndpointResolveResultV1Schema = ConversationEndpointResolveResultV1ProtocolSchema;
export type ConversationEndpointResolveResultV1 = ReturnType<
    typeof ConversationEndpointResolveResultV1Schema.parse
>;
export const ConversationEndpointResolveResultV1JsonSchema: PluginJsonSchema =
    ConversationEndpointResolveResultV1Schema.jsonSchema;

const conversationPrincipalResolveResolvedV1 = defineProtocolObject({
    kind: defineProtocolLiteral('resolved'),
    candidates: ConversationResolvedPrincipalCandidatesV1ProtocolSchema,
}, { policy: 'closed' });

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationPrincipalResolveResultV1ProtocolSchema = defineProtocolUnion([
    conversationPrincipalResolveResolvedV1,
    ConversationProviderFailureV1ProtocolSchema,
]);

/** Provider principal-resolution result; connection-bearing request input remains EU24-held. */
export const ConversationPrincipalResolveResultV1Schema = ConversationPrincipalResolveResultV1ProtocolSchema;
export type ConversationPrincipalResolveResultV1 = ReturnType<
    typeof ConversationPrincipalResolveResultV1Schema.parse
>;
export const ConversationPrincipalResolveResultV1JsonSchema: PluginJsonSchema =
    ConversationPrincipalResolveResultV1Schema.jsonSchema;
