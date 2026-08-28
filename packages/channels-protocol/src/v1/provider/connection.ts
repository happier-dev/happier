import type {
    PluginJsonSchema,
    ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolUniqueArray,
    defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';
import {
    QualifiedConnectedAccountRefSchema,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    PluginContributionIdentity,
} from '@happier-dev/plugin-sdk/manifest';

import {
    CONVERSATION_BINDING_INPUT_MODES_V1,
    CONVERSATION_TRANSPORT_KINDS_V1,
    MAX_CONVERSATION_PROVIDER_CONNECTION_KEY_UTF8_BYTES,
} from '../bounds.js';
import {
    ConversationConnectionIdV1ProtocolSchema,
} from '../identity.js';
import {
    ConversationProviderConfigV1ProtocolSchema,
} from '../json.js';

/**
 * The account reference every connection-bearing role carries.
 *
 * The canonical runtime schema stays the host's `QualifiedConnectedAccountRefSchema`;
 * only its declaration-facing name is restated here in public SDK vocabulary. The
 * SDK's own `QualifiedConnectedAccountRef` alias still resolves to a private
 * host-Protocol type name, and TypeScript reproduces that name inside every
 * inferred schema this module composes — which would make this package's published
 * declarations unusable without that private dependency. `sdkSchemaClosure.test.ts`
 * enforces the closure.
 */
export type ConversationQualifiedConnectedAccountRefV1 = Readonly<{
    service: PluginContributionIdentity;
    accountId: string;
}>;

/** @internal Canonical structural account reference used by every connection operation. */
export const ConversationQualifiedConnectedAccountRefV1ProtocolSchema:
    ProtocolComposableSchema<ConversationQualifiedConnectedAccountRefV1> =
        QualifiedConnectedAccountRefSchema;

/** @internal Relative-only provider identity shared by connection-bearing roles. */
export const ConversationProviderConnectionKeyV1ProtocolSchema = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_PROVIDER_CONNECTION_KEY_UTF8_BYTES,
    minLength: 1,
});

const conversationTransportKindV1 = defineProtocolUnion([
    defineProtocolLiteral(CONVERSATION_TRANSPORT_KINDS_V1[0]),
    defineProtocolLiteral(CONVERSATION_TRANSPORT_KINDS_V1[1]),
    defineProtocolLiteral(CONVERSATION_TRANSPORT_KINDS_V1[2]),
]);
const protocolBoolean = defineProtocolUnion([
    defineProtocolLiteral(true),
    defineProtocolLiteral(false),
]);

/**
 * The input modes a provider can actually deliver on a SHARED endpoint,
 * authenticated against the integration's own account.
 *
 * A provider that omits this asserts no delivery restriction. A provider that
 * knows one must declare it: an integration whose platform withholds ordinary
 * shared-conversation messages (a Telegram bot with group privacy enabled, for
 * example) can never satisfy `allAllowedMessages`, and offering it would
 * persist a binding policy the platform will silently never honour.
 *
 * Direct endpoints are deliberately outside this capability: an integration
 * addressed in a one-to-one conversation receives every message by definition.
 *
 * It lives on the shared connection base because it is one connection-level
 * capability observed by two roles — `setup` states it when the connection is
 * created or transferred, and `connectionTest` restates the CURRENT value so a
 * later platform-side narrowing cannot leave a saved binding apparently ready
 * while its messages are impossible to observe.
 */
export const ConversationSharedEndpointInputModesV1ProtocolSchema = defineProtocolUniqueArray(
    defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_BINDING_INPUT_MODES_V1[0]),
        defineProtocolLiteral(CONVERSATION_BINDING_INPUT_MODES_V1[1]),
        defineProtocolLiteral(CONVERSATION_BINDING_INPUT_MODES_V1[2]),
    ]),
    { minItems: 1, maxItems: CONVERSATION_BINDING_INPUT_MODES_V1.length },
);

/** @internal Relative-only fields shared by strict connection-bearing schemas. */
export const ConversationProviderConnectionInputV1Fields = {
    v: defineProtocolLiteral(1),
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    providerConnectionKey: ConversationProviderConnectionKeyV1ProtocolSchema,
    providerConfigVersion: defineProtocolLiteral(1),
    providerConfig: ConversationProviderConfigV1ProtocolSchema,
    credentialRef: ConversationQualifiedConnectedAccountRefV1ProtocolSchema.nullable(),
} as const;

/** @internal Relative-only input for composed Channels provider schemas. */
export const ConversationProviderConnectionInputV1ProtocolSchema = defineProtocolObject({
    ...ConversationProviderConnectionInputV1Fields,
}, { policy: 'closed' });

/** The immutable connection snapshot supplied by the Channels core to a provider role. */
export const ConversationProviderConnectionInputV1Schema = ConversationProviderConnectionInputV1ProtocolSchema;
export type ConversationProviderConnectionInputV1 = ReturnType<
    typeof ConversationProviderConnectionInputV1Schema.parse
>;
export const ConversationProviderConnectionInputV1JsonSchema: PluginJsonSchema =
    ConversationProviderConnectionInputV1Schema.jsonSchema;

/** @internal Relative-only input for the provider connection-test role. */
export const ConversationConnectionTestInputV1ProtocolSchema = defineProtocolObject({
    ...ConversationProviderConnectionInputV1Fields,
    selectedTransport: conversationTransportKindV1,
}, { policy: 'closed' });

export const ConversationConnectionTestInputV1Schema = ConversationConnectionTestInputV1ProtocolSchema;
export type ConversationConnectionTestInputV1 = ReturnType<
    typeof ConversationConnectionTestInputV1Schema.parse
>;
export const ConversationConnectionTestInputV1JsonSchema: PluginJsonSchema =
    ConversationConnectionTestInputV1Schema.jsonSchema;

const positiveSafeInteger = defineProtocolNumber({
    integer: true,
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
});
const reconciliationSnapshotFields = {
    ...ConversationProviderConnectionInputV1Fields,
    authorityEpoch: positiveSafeInteger,
    requiresFullSharedMessageContent: protocolBoolean,
} as const;

/** @internal Relative-only reconciliation projection returned only by core list/read Actions. */
export const ConversationProviderConnectionReconciliationSnapshotV1ProtocolSchema = defineProtocolUnion([
    defineProtocolObject({
        ...reconciliationSnapshotFields,
        enabled: protocolBoolean,
        deletionState: defineProtocolLiteral('none'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        ...reconciliationSnapshotFields,
        enabled: defineProtocolLiteral(false),
        deletionState: defineProtocolUnion([
            defineProtocolLiteral('pendingStopReconciliation'),
            defineProtocolLiteral('finalizingDelete'),
        ]),
    }, { policy: 'closed' }),
]);

export const ConversationProviderConnectionReconciliationSnapshotV1Schema = ConversationProviderConnectionReconciliationSnapshotV1ProtocolSchema;
export type ConversationProviderConnectionReconciliationSnapshotV1 = ReturnType<
    typeof ConversationProviderConnectionReconciliationSnapshotV1Schema.parse
>;
export const ConversationProviderConnectionReconciliationSnapshotV1JsonSchema: PluginJsonSchema =
    ConversationProviderConnectionReconciliationSnapshotV1Schema.jsonSchema;

/** @internal Relative-only map used by both caller-filtered reconciliation reads. */
export const ConversationProviderConnectionsSnapshotV1ProtocolSchema = defineProtocolObject(
    {},
    {
        policy: 'additive-open/preserve',
        additionalProperties: ConversationProviderConnectionReconciliationSnapshotV1ProtocolSchema,
    },
);

export const ConversationProviderConnectionsSnapshotV1Schema = ConversationProviderConnectionsSnapshotV1ProtocolSchema;
export type ConversationProviderConnectionsSnapshotV1 = ReturnType<
    typeof ConversationProviderConnectionsSnapshotV1Schema.parse
>;
export const ConversationProviderConnectionsSnapshotV1JsonSchema: PluginJsonSchema =
    ConversationProviderConnectionsSnapshotV1Schema.jsonSchema;

/**
 * Matches the caller-filtered current connection authority returned by the
 * core list/read Actions. Provider source setup uses this one decision instead
 * of independently deciding whether a retained, disabled, or deleting row can
 * actually observe the selected credential identity.
 */
export function hasCurrentConversationProviderConnectionV1(input: Readonly<{
    connections: ConversationProviderConnectionsSnapshotV1;
    providerConnectionKey: string;
    credentialRef: ConversationQualifiedConnectedAccountRefV1 | null;
}>): boolean {
    return Object.values(input.connections).some((connection) => {
        if (
            !connection.enabled
            || connection.deletionState !== 'none'
            || connection.providerConnectionKey !== input.providerConnectionKey
        ) return false;
        const actual = connection.credentialRef;
        const expected = input.credentialRef;
        return actual === null || expected === null
            ? actual === expected
            : actual.accountId === expected.accountId
                && actual.service.pluginId === expected.service.pluginId
                && actual.service.localId === expected.service.localId;
    });
}

/** Empty by design: host-stamped caller provenance supplies the reconciliation scope. */
export const ConversationProviderConnectionsListInputV1Schema = defineProtocolObject({}, { policy: 'closed' });
export type ConversationProviderConnectionsListInputV1 = ReturnType<
    typeof ConversationProviderConnectionsListInputV1Schema.parse
>;
export const ConversationProviderConnectionsListInputV1JsonSchema: PluginJsonSchema =
    ConversationProviderConnectionsListInputV1Schema.jsonSchema;

/** The list result is the same caller-filtered connection-ID map. */
export const ConversationProviderConnectionsListResultV1Schema =
    ConversationProviderConnectionsSnapshotV1Schema;
export type ConversationProviderConnectionsListResultV1 = ConversationProviderConnectionsSnapshotV1;
export const ConversationProviderConnectionsListResultV1JsonSchema: PluginJsonSchema =
    ConversationProviderConnectionsSnapshotV1JsonSchema;

export const ConversationProviderConnectionReadInputV1Schema = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
}, { policy: 'closed' });
export type ConversationProviderConnectionReadInputV1 = ReturnType<
    typeof ConversationProviderConnectionReadInputV1Schema.parse
>;
export const ConversationProviderConnectionReadInputV1JsonSchema: PluginJsonSchema =
    ConversationProviderConnectionReadInputV1Schema.jsonSchema;

/** An empty map covers absent and caller-ineligible connections without an oracle. */
export const ConversationProviderConnectionReadResultV1Schema =
    ConversationProviderConnectionsSnapshotV1Schema;
export type ConversationProviderConnectionReadResultV1 = ConversationProviderConnectionsSnapshotV1;
export const ConversationProviderConnectionReadResultV1JsonSchema: PluginJsonSchema =
    ConversationProviderConnectionsSnapshotV1JsonSchema;
