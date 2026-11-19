import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    defineProtocolUtf8String,
} from './protocolFacade.js';

// Shared V1 provider outcomes for Channels and Email Transports.
export const MAX_CONVERSATION_ENDPOINT_STABLE_ID_UTF8_BYTES = 512;

export const MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS = 256;

export const MAX_CONVERSATION_PROVIDER_DIAGNOSTIC_UTF8_BYTES = 1024;

export const MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES = 512;

export const CONVERSATION_ENDPOINT_AUDIENCES_V1 = [
    'direct',
    'shared',
] as const;

export const CONVERSATION_PROVIDER_FAILURE_REASONS_V1 = [
    'credentialInvalid',
    'permissionMissing',
    'network',
    'rateLimited',
    'providerConflict',
    'unsupported',
    'invalidConfiguration',
] as const;

export const CONVERSATION_DELIVERY_RETRY_KINDS_V1 = [
    'safe',
    'after',
    'never',
] as const;

export const CONVERSATION_DELIVERY_ARCHIVE_RECOVERY_KINDS_V1 = [
    'unarchiveAndRetry',
    'ownerMustUnarchiveOrRebind',
] as const;

export const ConversationProviderDiagnosticV1ProtocolSchema = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_PROVIDER_DIAGNOSTIC_UTF8_BYTES,
    minLength: 1,
});

const conversationProviderFailureReasonV1 = defineProtocolUnion([
    defineProtocolLiteral(CONVERSATION_PROVIDER_FAILURE_REASONS_V1[0]),
    defineProtocolLiteral(CONVERSATION_PROVIDER_FAILURE_REASONS_V1[1]),
    defineProtocolLiteral(CONVERSATION_PROVIDER_FAILURE_REASONS_V1[2]),
    defineProtocolLiteral(CONVERSATION_PROVIDER_FAILURE_REASONS_V1[3]),
    defineProtocolLiteral(CONVERSATION_PROVIDER_FAILURE_REASONS_V1[4]),
    defineProtocolLiteral(CONVERSATION_PROVIDER_FAILURE_REASONS_V1[5]),
    defineProtocolLiteral(CONVERSATION_PROVIDER_FAILURE_REASONS_V1[6]),
]);

export const ConversationProviderFailureV1ProtocolSchema = defineProtocolObject({
    kind: defineProtocolLiteral('notReady'),
    reason: conversationProviderFailureReasonV1,
    retryAfterMs: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
    }).optional(),
    diagnostic: ConversationProviderDiagnosticV1ProtocolSchema.optional(),
}, { policy: 'closed' });

export const ConversationPullRequestV1Fields = {
    repository: defineProtocolString({ minLength: 1, pattern: '^[^\\s/]+/[^\\s/]+$' }),
    number: defineProtocolNumber({ integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
} as const;
export const ConversationPullRequestV1Schema = defineProtocolObject(ConversationPullRequestV1Fields, { policy: 'closed' });

/** Current-head source evidence; unknown or incomplete evidence cannot end a fix sequence. */
export const ConversationPullRequestFixResolutionV1Schema = defineProtocolObject({
    headRevision: defineProtocolString({ minLength: 1 }),
    resolved: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]),
    incomplete: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]),
}, { policy: 'closed' });

export const ConversationPullRequestStateV1Fields = {
    state: defineProtocolUnion([defineProtocolLiteral('open'), defineProtocolLiteral('merged'), defineProtocolLiteral('closed'), defineProtocolLiteral('unknown')]),
    observedAt: defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    fixResolution: ConversationPullRequestFixResolutionV1Schema.optional(),
} as const;
export const ConversationPullRequestStateV1Schema = defineProtocolObject(ConversationPullRequestStateV1Fields, { policy: 'closed' });

export const ConversationEndpointStableIdV1ProtocolSchema = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_ENDPOINT_STABLE_ID_UTF8_BYTES,
    minLength: 1,
});

export const ConversationEndpointDisplayLabelV1ProtocolSchema = defineProtocolString({
    minLength: 1,
    maxLength: MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS,
});

export const ConversationEndpointAudienceV1ProtocolSchema = defineProtocolUnion([
    defineProtocolLiteral(CONVERSATION_ENDPOINT_AUDIENCES_V1[0]),
    defineProtocolLiteral(CONVERSATION_ENDPOINT_AUDIENCES_V1[1]),
]);

const endpointFields = {
    id: ConversationEndpointStableIdV1ProtocolSchema,
    parentId: ConversationEndpointStableIdV1ProtocolSchema.optional(),
    label: ConversationEndpointDisplayLabelV1ProtocolSchema.optional(),
    parentLabel: ConversationEndpointDisplayLabelV1ProtocolSchema.optional(),
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
    audience: ConversationEndpointAudienceV1ProtocolSchema,
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
    pullRequest: ConversationPullRequestV1Schema.optional(),
    pullRequestState: ConversationPullRequestStateV1Schema.optional(),
}, { policy: 'closed' });

export const ConversationResolvedEndpointV1ProtocolSchema = defineProtocolUnion([
    conversationResolvedDirectEndpointV1,
    conversationResolvedSharedEndpointV1,
    conversationResolvedThreadEndpointV1,
    conversationResolvedGithubIssueEndpointV1,
    conversationResolvedGithubPullRequestEndpointV1,
]);

export const ConversationProviderMessageIdV1ProtocolSchema = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES,
    minLength: 1,
});

const conversationProviderMessageIdsV1 = defineProtocolArray(
    ConversationProviderMessageIdV1ProtocolSchema,
);

const conversationDeliveredV1 = defineProtocolObject({
    kind: defineProtocolLiteral('delivered'),
    providerMessageIds: conversationProviderMessageIdsV1,
    endpoint: ConversationResolvedEndpointV1ProtocolSchema.optional(),
}, { policy: 'closed' });

const conversationPartialDeliveryV1 = defineProtocolObject({
    kind: defineProtocolLiteral('partial'),
    providerMessageIds: conversationProviderMessageIdsV1,
    failedChunk: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
}, { policy: 'closed' });

const conversationNotDeliveredV1 = defineProtocolObject({
    kind: defineProtocolLiteral('notDelivered'),
    retry: defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_DELIVERY_RETRY_KINDS_V1[0]),
        defineProtocolLiteral(CONVERSATION_DELIVERY_RETRY_KINDS_V1[1]),
        defineProtocolLiteral(CONVERSATION_DELIVERY_RETRY_KINDS_V1[2]),
    ]),
    retryAfterMs: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
    }).optional(),
}, { policy: 'closed' });

const conversationEndpointArchivedV1 = defineProtocolObject({
    kind: defineProtocolLiteral('endpointArchived'),
    recovery: defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_DELIVERY_ARCHIVE_RECOVERY_KINDS_V1[0]),
        defineProtocolLiteral(CONVERSATION_DELIVERY_ARCHIVE_RECOVERY_KINDS_V1[1]),
    ]),
}, { policy: 'closed' });

const conversationOutcomeUnknownV1 = defineProtocolObject({
    kind: defineProtocolLiteral('outcomeUnknown'),
    providerMessageIds: conversationProviderMessageIdsV1.optional(),
    endpoint: ConversationResolvedEndpointV1ProtocolSchema.optional(),
}, { policy: 'closed' });

export const ConversationDeliveryResultV1ProtocolSchema = defineProtocolUnion([
    ConversationProviderFailureV1ProtocolSchema,
    conversationDeliveredV1,
    conversationPartialDeliveryV1,
    conversationNotDeliveredV1,
    conversationEndpointArchivedV1,
    conversationOutcomeUnknownV1,
]);
