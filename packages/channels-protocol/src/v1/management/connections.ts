import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
    PluginTargetedContributionSelectionV1Schema,
} from '@happier-dev/plugin-sdk/contributions';
import {
    PluginContributionIdentityV1Schema,
    PluginIdSchema,
} from '@happier-dev/plugin-sdk/manifest';
import { PluginWebhookEndpointIdV1JsonSchema } from '@happier-dev/plugin-sdk/webhooks';

import {
    MAX_CONVERSATION_CONNECTION_ID_ASCII_BYTES,
} from '../bounds.js';
import { ConversationProviderFailureV1ProtocolSchema } from '../diagnostics.js';
import {
    ConversationCollectionRowRevisionV1ProtocolSchema,
    ConversationConnectionIdV1ProtocolSchema,
} from '../identity.js';
import { ConversationJsonValueV1ProtocolSchema } from '../json.js';
import { ConversationQualifiedConnectedAccountRefV1ProtocolSchema } from '../provider/connection.js';
import { ConversationMaximumObservationAgeV1ProtocolSchema } from '../provider/setup.js';

/**
 * A Channels-owned authority epoch. It is advanced by this package rather
 * than persisted as a Collection row revision, so it keeps the wide
 * safe-integer bound instead of the Collection column ceiling.
 */
const authorityEpochV1 = defineProtocolNumber({
    integer: true,
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
});
/** Logical connection configuration revision; physical storage CAS is private. */
const configurationRevision = ConversationCollectionRowRevisionV1ProtocolSchema;
const observationAgeV1 = ConversationMaximumObservationAgeV1ProtocolSchema;
const protocolBoolean = defineProtocolUnion([
    defineProtocolLiteral(true),
    defineProtocolLiteral(false),
]);

/** The one Channels-owned source identity derivation for a connection webhook. */
export const CONVERSATION_CONNECTION_WEBHOOK_SOURCE_INSTANCE_ID_PREFIX_V1 =
    'channels.connection.' as const;

export function conversationConnectionWebhookSourceInstanceIdV1(
    connectionId: string,
): string {
    const canonicalConnectionId = ConversationConnectionIdV1ProtocolSchema.parse(connectionId);
    return ConversationConnectionWebhookSourceInstanceIdV1ProtocolSchema.parse(
        `${CONVERSATION_CONNECTION_WEBHOOK_SOURCE_INSTANCE_ID_PREFIX_V1}${canonicalConnectionId}`,
    );
}

/** @internal Relative-only Channels-owned webhook source-instance derivation. */
export const ConversationConnectionWebhookSourceInstanceIdV1ProtocolSchema = defineProtocolString({
    minLength: CONVERSATION_CONNECTION_WEBHOOK_SOURCE_INSTANCE_ID_PREFIX_V1.length + 1,
    maxLength: CONVERSATION_CONNECTION_WEBHOOK_SOURCE_INSTANCE_ID_PREFIX_V1.length
        + MAX_CONVERSATION_CONNECTION_ID_ASCII_BYTES,
    pattern: `^channels\\.connection\\.[A-Za-z0-9._:-]{1,${MAX_CONVERSATION_CONNECTION_ID_ASCII_BYTES}}$`,
});

/** @internal Exact generic endpoint-ensure idempotency-key grammar. */
export const ConversationConnectionWebhookEndpointEnsureIdempotencyKeyV1ProtocolSchema =
    defineProtocolString({
        minLength: 16,
        maxLength: 128,
        pattern: '^[A-Za-z0-9._:-]+$',
    });
/**
 * The transport selector shared by connection transfer. Any current transport
 * may select any admitted transport, so `connection/transfer-v1` stays the one
 * origin/transport replacement Action. Selecting `durablePush` runs the
 * strict endpoint-ensure journey through the generic webhook owner before the
 * transfer CAS; moving away from `durablePush` detaches only the Channels
 * reference and never disables, revokes, or deletes the generic endpoint.
 */
export const CONVERSATION_CONNECTION_SELECTABLE_TRANSPORTS_V1 = [
    'checkpointedPull',
    'socket',
    'durablePush',
] as const;
export const ConversationConnectionSelectableTransportV1ProtocolSchema = defineProtocolUnion([
    defineProtocolLiteral(CONVERSATION_CONNECTION_SELECTABLE_TRANSPORTS_V1[0]),
    defineProtocolLiteral(CONVERSATION_CONNECTION_SELECTABLE_TRANSPORTS_V1[1]),
    defineProtocolLiteral(CONVERSATION_CONNECTION_SELECTABLE_TRANSPORTS_V1[2]),
]);
export type ConversationConnectionSelectableTransportV1 = ReturnType<
    typeof ConversationConnectionSelectableTransportV1ProtocolSchema.parse
>;

export function isConversationConnectionSelectableTransportV1(
    value: unknown,
): value is ConversationConnectionSelectableTransportV1 {
    return CONVERSATION_CONNECTION_SELECTABLE_TRANSPORTS_V1.some((transport) => transport === value);
}

/**
 * The transports connection creation can select. Durable push is admitted
 * only through the strict endpoint-ensure continuation: the core preallocates
 * the final connection identity, the present-user UI ensures the generic
 * webhook endpoint through the existing host Action, and the continuation
 * proves host-derived correspondence before any connection row exists.
 */
export const CONVERSATION_CONNECTION_CREATE_SELECTABLE_TRANSPORTS_V1 = [
    ...CONVERSATION_CONNECTION_SELECTABLE_TRANSPORTS_V1,
] as const;
export const ConversationConnectionCreateSelectableTransportV1ProtocolSchema = defineProtocolUnion([
    defineProtocolLiteral(CONVERSATION_CONNECTION_CREATE_SELECTABLE_TRANSPORTS_V1[0]),
    defineProtocolLiteral(CONVERSATION_CONNECTION_CREATE_SELECTABLE_TRANSPORTS_V1[1]),
    defineProtocolLiteral(CONVERSATION_CONNECTION_CREATE_SELECTABLE_TRANSPORTS_V1[2]),
]);
export type ConversationConnectionCreateSelectableTransportV1 = ReturnType<
    typeof ConversationConnectionCreateSelectableTransportV1ProtocolSchema.parse
>;

export function isConversationConnectionCreateSelectableTransportV1(
    value: unknown,
): value is ConversationConnectionCreateSelectableTransportV1 {
    return CONVERSATION_CONNECTION_CREATE_SELECTABLE_TRANSPORTS_V1.some(
        (transport) => transport === value,
    );
}

/** The canonical endpoint identity projected into the closed setup result. */
export const ConversationWebhookEndpointIdRelayV1ProtocolSchema = defineProtocolString({
    minLength: PluginWebhookEndpointIdV1JsonSchema.minLength,
    maxLength: PluginWebhookEndpointIdV1JsonSchema.maxLength,
    pattern: PluginWebhookEndpointIdV1JsonSchema.pattern,
});

/** @internal Portable materialization facts relayed to the generic webhook owner. */
export const ConversationConnectionWebhookTargetMaterializationV1ProtocolSchema =
    defineProtocolObject({
        pluginId: PluginIdSchema,
        machineId: defineProtocolString({ minLength: 1, maxLength: 256 }),
        materializationId: defineProtocolString({ minLength: 1, maxLength: 256 }),
    }, { policy: 'closed' });

/** @internal The one endpoint setup arm owned by present-user connection creation. */
export const ConversationConnectionWebhookEndpointEnsureSetupV1ProtocolSchema =
    defineProtocolObject({
        kind: defineProtocolLiteral('accountEndpointV1'),
        credential: defineProtocolLiteral('serverGenerated'),
    }, { policy: 'closed' });

const targetedContributionSelectionV1 = PluginTargetedContributionSelectionV1Schema;

const conversationConnectionMutationResultV1 = defineProtocolObject({
    kind: defineProtocolUnion([
        defineProtocolLiteral('updated'),
        defineProtocolLiteral('unchanged'),
    ]),
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    revision: configurationRevision,
    authorityEpoch: authorityEpochV1,
}, { policy: 'closed' });

const conversationConnectionEndpointRequiredResultV1 = defineProtocolObject({
    kind: defineProtocolLiteral('endpointRequired'),
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    webhookContribution: PluginContributionIdentityV1Schema,
    targetMaterialization: ConversationConnectionWebhookTargetMaterializationV1ProtocolSchema,
    sourceInstanceId: ConversationConnectionWebhookSourceInstanceIdV1ProtocolSchema,
    webhookEndpointSetup: ConversationConnectionWebhookEndpointEnsureSetupV1ProtocolSchema,
    webhookEndpointIdempotencyKey:
        ConversationConnectionWebhookEndpointEnsureIdempotencyKeyV1ProtocolSchema,
}, { policy: 'closed' });

/**
 * A durable-push endpoint exists but the provider has not yet proved that it
 * can deliver to it. These are presentation facts only: the server-owned
 * endpoint remains the source of truth and no Channels connection is written
 * until a later create/transfer call observes `ready`.
 *
 * `publicUrl` deliberately carries only the generic string envelope here. The
 * canonical webhook ensure Action already admitted the URL with its owner
 * schema; Channels must not create a narrower second URL grammar.
 */
const conversationConnectionWebhookEndpointSetupRequiredResultV1 = defineProtocolObject({
    kind: defineProtocolLiteral('webhookEndpointSetupRequired'),
    webhookEndpointId: ConversationWebhookEndpointIdRelayV1ProtocolSchema,
    publicUrl: defineProtocolString({ minLength: 1, maxLength: 2_048 }),
    readiness: defineProtocolUnion([
        defineProtocolLiteral('providerConfirmationRequired'),
        defineProtocolLiteral('credentialDisclosureLost'),
    ]),
    oneTimeGeneratedSecret: defineProtocolString({ minLength: 1, maxLength: 512 }).optional(),
}, { policy: 'closed' });

const conversationConnectionCreateResultV1 = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('created'),
        connectionId: ConversationConnectionIdV1ProtocolSchema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('rejoined'),
        connectionId: ConversationConnectionIdV1ProtocolSchema,
    }, { policy: 'closed' }),
    conversationConnectionEndpointRequiredResultV1,
    conversationConnectionWebhookEndpointSetupRequiredResultV1,
    ConversationProviderFailureV1ProtocolSchema,
]);

const conversationConnectionTransferResultV1 = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolUnion([
            defineProtocolLiteral('transferred'),
            defineProtocolLiteral('rejoined'),
            defineProtocolLiteral('transferPendingOldStop'),
        ]),
        connectionId: ConversationConnectionIdV1ProtocolSchema,
        revision: configurationRevision,
        authorityEpoch: authorityEpochV1,
    }, { policy: 'closed' }),
    conversationConnectionEndpointRequiredResultV1,
    conversationConnectionWebhookEndpointSetupRequiredResultV1,
    ConversationProviderFailureV1ProtocolSchema,
]);

const conversationConnectionDeleteResultV1 = defineProtocolObject({
    kind: defineProtocolUnion([
        defineProtocolLiteral('deletePending'),
        defineProtocolLiteral('deleteFinalizing'),
        defineProtocolLiteral('rejoined'),
    ]),
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    revision: configurationRevision,
    authorityEpoch: authorityEpochV1,
    acceptedPossibleLoss: protocolBoolean,
}, { policy: 'closed' });

/**
 * The create contract for every selectable transport. Durable-push endpoint
 * authority remains entirely inside the generic host Action: the mounted UI
 * may relay only the strict endpoint id returned by that Action, never a raw
 * URL, secret, source identity, or ensure identity.
 */
const conversationConnectionCreateInputV1 = defineProtocolObject({
    providerSelection: targetedContributionSelectionV1,
    providerSetupInput: ConversationJsonValueV1ProtocolSchema,
    credentialRef: ConversationQualifiedConnectedAccountRefV1ProtocolSchema.nullable(),
    selectedTransport: ConversationConnectionCreateSelectableTransportV1ProtocolSchema,
    maximumObservationAgeMs: observationAgeV1,
    endpointContinuation: defineProtocolObject({
        connectionId: ConversationConnectionIdV1ProtocolSchema,
        webhookEndpointId: ConversationWebhookEndpointIdRelayV1ProtocolSchema,
    }, { policy: 'closed' }).optional(),
}, { policy: 'closed' });

/**
 * The present-user create contract. The admitted selection is the only
 * setup-role identity; every endpoint and connection authority stays outside
 * this object.
 */
export const ConversationConnectionCreateInputV1Schema = conversationConnectionCreateInputV1;
export type ConversationConnectionCreateInputV1 = ReturnType<
    typeof ConversationConnectionCreateInputV1Schema.parse
>;
export const ConversationConnectionCreateInputV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationConnectionCreateInputV1Schema.jsonSchema)();

/**
 * A transfer selects a newly admitted provider contribution and setup contract
 * for one existing connection revision. It deliberately omits policy fields,
 * caller-owned origins, and durable-push endpoint authority. A transfer onto
 * `durablePush` carries the same strict endpoint continuation as creation:
 * the core preallocated identity is the transferred connection itself, and
 * the continuation only relays the endpoint the present-user UI ensured
 * through the existing generic host Action.
 */
export const ConversationConnectionTransferInputV1Schema = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedRevision: configurationRevision,
    expectedAuthorityEpoch: authorityEpochV1,
    providerSelection: targetedContributionSelectionV1,
    providerSetupInput: ConversationJsonValueV1ProtocolSchema,
    credentialRef: ConversationQualifiedConnectedAccountRefV1ProtocolSchema.nullable(),
    selectedTransport: ConversationConnectionSelectableTransportV1ProtocolSchema,
    endpointContinuation: defineProtocolObject({
        connectionId: ConversationConnectionIdV1ProtocolSchema,
        webhookEndpointId: ConversationWebhookEndpointIdRelayV1ProtocolSchema,
    }, { policy: 'closed' }).optional(),
}, { policy: 'closed' });
export type ConversationConnectionTransferInputV1 = ReturnType<
    typeof ConversationConnectionTransferInputV1Schema.parse
>;
export const ConversationConnectionTransferInputV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationConnectionTransferInputV1Schema.jsonSchema)();

export const ConversationConnectionUpdateInputV1Schema = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedRevision: configurationRevision,
    enabled: protocolBoolean,
    maximumObservationAgeMs: observationAgeV1,
}, { policy: 'closed' });
export type ConversationConnectionUpdateInputV1 = ReturnType<
    typeof ConversationConnectionUpdateInputV1Schema.parse
>;
export const ConversationConnectionUpdateInputV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationConnectionUpdateInputV1Schema.jsonSchema)();

export const ConversationConnectionUpdateResultV1Schema = conversationConnectionMutationResultV1;
export type ConversationConnectionUpdateResultV1 = ReturnType<
    typeof ConversationConnectionUpdateResultV1Schema.parse
>;
export const ConversationConnectionUpdateResultV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationConnectionUpdateResultV1Schema.jsonSchema)();

export const ConversationConnectionDeleteInputV1Schema = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedRevision: configurationRevision,
}, { policy: 'closed' });
export type ConversationConnectionDeleteInputV1 = ReturnType<
    typeof ConversationConnectionDeleteInputV1Schema.parse
>;
export const ConversationConnectionDeleteInputV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationConnectionDeleteInputV1Schema.jsonSchema)();

export const ConversationConnectionDeleteResultV1Schema = conversationConnectionDeleteResultV1;
export type ConversationConnectionDeleteResultV1 = ReturnType<
    typeof ConversationConnectionDeleteResultV1Schema.parse
>;
export const ConversationConnectionDeleteResultV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationConnectionDeleteResultV1Schema.jsonSchema)();

export const ConversationConnectionCreateResultV1Schema = conversationConnectionCreateResultV1;
export type ConversationConnectionCreateResultV1 = ReturnType<
    typeof ConversationConnectionCreateResultV1Schema.parse
>;
export const ConversationConnectionCreateResultV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationConnectionCreateResultV1Schema.jsonSchema)();

export type ConversationConnectionWebhookEndpointSetupRequiredResultV1 = Extract<
    ConversationConnectionCreateResultV1,
    Readonly<{ kind: 'webhookEndpointSetupRequired' }>
>;

export type ConversationConnectionEndpointRequiredResultV1 = Extract<
    ConversationConnectionCreateResultV1,
    Readonly<{ kind: 'endpointRequired' }>
>;

export const ConversationConnectionTransferResultV1Schema = conversationConnectionTransferResultV1;
export type ConversationConnectionTransferResultV1 = ReturnType<
    typeof ConversationConnectionTransferResultV1Schema.parse
>;
export const ConversationConnectionTransferResultV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationConnectionTransferResultV1Schema.jsonSchema)();
