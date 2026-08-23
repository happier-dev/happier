import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import { ConversationProviderFailureV1ProtocolSchema } from '../diagnostics.js';
import {
    ConversationEndpointDisplayLabelV1ProtocolSchema,
    ConversationEndpointStableIdV1ProtocolSchema,
} from './resolution.js';
import {
    ConversationConnectionTestInputV1Schema,
    ConversationConnectionTestInputV1JsonSchema,
    ConversationProviderConnectionInputV1Fields,
    ConversationProviderConnectionInputV1Schema,
    ConversationProviderConnectionKeyV1ProtocolSchema,
    ConversationSharedEndpointInputModesV1ProtocolSchema,
} from './connection.js';

export {
    ConversationConnectionTestInputV1Schema,
    ConversationConnectionTestInputV1JsonSchema,
    ConversationProviderConnectionInputV1Schema,
};
export type {
    ConversationConnectionTestInputV1,
    ConversationProviderConnectionInputV1,
} from './connection.js';

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationIntegrationPrincipalV1ProtocolSchema = defineProtocolObject({
    id: ConversationEndpointStableIdV1ProtocolSchema,
    label: ConversationEndpointDisplayLabelV1ProtocolSchema.optional(),
}, { policy: 'closed' });

const conversationConnectionReadyV1 = defineProtocolObject({
    kind: defineProtocolLiteral('ready'),
    integrationPrincipal: ConversationIntegrationPrincipalV1ProtocolSchema,
    providerConnectionKey: ConversationProviderConnectionKeyV1ProtocolSchema,
    /**
     * The CURRENT shared-endpoint delivery capability, re-authenticated by this
     * probe. Setup states this once when a connection is created; a platform
     * can narrow it afterwards (a Telegram bot whose BotFather group privacy is
     * re-enabled stops receiving ordinary supergroup messages entirely). A
     * provider that can observe the capability restates it here so the saved
     * bindings that depend on it cannot stay apparently ready while their
     * messages are impossible to observe. Omitted means the same thing it means
     * in setup: this provider asserts no shared-endpoint delivery restriction.
     */
    sharedEndpointInputModes: ConversationSharedEndpointInputModesV1ProtocolSchema.optional(),
}, { policy: 'closed' });

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationConnectionTestResultV1ProtocolSchema = defineProtocolUnion([
    conversationConnectionReadyV1,
    ConversationProviderFailureV1ProtocolSchema,
]);

/** Provider connection-test result; selected-transport request input remains EU24-held. */
export const ConversationConnectionTestResultV1Schema = ConversationConnectionTestResultV1ProtocolSchema;
export type ConversationConnectionTestResultV1 = ReturnType<
    typeof ConversationConnectionTestResultV1Schema.parse
>;
export const ConversationConnectionTestResultV1JsonSchema: PluginJsonSchema =
    ConversationConnectionTestResultV1Schema.jsonSchema;

/** @internal Relative-only input for optional provider stop operations. */
export const ConversationProviderConnectionStopInputV1ProtocolSchema = defineProtocolObject({
    ...ConversationProviderConnectionInputV1Fields,
    authorityEpoch: defineProtocolNumber({
        integer: true,
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
    reason: defineProtocolUnion([
        defineProtocolLiteral('disable'),
        defineProtocolLiteral('delete'),
        defineProtocolLiteral('transfer'),
    ]),
}, { policy: 'closed' });

export const ConversationProviderConnectionStopInputV1Schema = ConversationProviderConnectionStopInputV1ProtocolSchema;
export type ConversationProviderConnectionStopInputV1 = ReturnType<
    typeof ConversationProviderConnectionStopInputV1Schema.parse
>;
export const ConversationProviderConnectionStopInputV1JsonSchema: PluginJsonSchema =
    ConversationProviderConnectionStopInputV1Schema.jsonSchema;

const conversationProviderConnectionStoppedV1 = defineProtocolObject({
    kind: defineProtocolUnion([
        defineProtocolLiteral('stopped'),
        defineProtocolLiteral('notRunning'),
    ]),
}, { policy: 'closed' });

const conversationProviderConnectionStopPendingV1 = defineProtocolObject({
    kind: defineProtocolLiteral('pending'),
}, { policy: 'closed' });

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationProviderConnectionStopResultV1ProtocolSchema = defineProtocolUnion([
    conversationProviderConnectionStoppedV1,
    conversationProviderConnectionStopPendingV1,
    ConversationProviderFailureV1ProtocolSchema,
]);

/** Provider stop evidence; its connection-bearing request input remains EU24-held. */
export const ConversationProviderConnectionStopResultV1Schema = ConversationProviderConnectionStopResultV1ProtocolSchema;
export type ConversationProviderConnectionStopResultV1 = ReturnType<
    typeof ConversationProviderConnectionStopResultV1Schema.parse
>;
export const ConversationProviderConnectionStopResultV1JsonSchema: PluginJsonSchema =
    ConversationProviderConnectionStopResultV1Schema.jsonSchema;
