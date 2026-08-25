import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import { ConversationConnectionIdV1ProtocolSchema } from '../identity.js';
import { ConversationProviderFailureV1ProtocolSchema } from '../diagnostics.js';
import type { ConversationActionDeclarationV1 } from '../actionDeclarations.js';

const positiveSafeInteger = defineProtocolNumber({
    integer: true,
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
});

const conversationConnectionRetestInputV1 = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedRevision: positiveSafeInteger,
    authorityEpoch: positiveSafeInteger,
}, { policy: 'closed' });

const conversationConnectionRetestReadyV1 = defineProtocolObject({
    kind: defineProtocolLiteral('ready'),
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    revision: positiveSafeInteger,
    authorityEpoch: positiveSafeInteger,
}, { policy: 'closed' });

/**
 * Re-probes an already saved connection with the exact facts it retained. It
 * carries no provider setup, credential, transport, or policy input: a retest
 * that could change any of those would be a second connection writer rather
 * than a re-observation of the one the user already has.
 */
export const ConversationConnectionRetestInputV1Schema = conversationConnectionRetestInputV1;
export type ConversationConnectionRetestInputV1 = ReturnType<
    typeof ConversationConnectionRetestInputV1Schema.parse
>;
export const ConversationConnectionRetestInputV1JsonSchema: PluginJsonSchema =
    ConversationConnectionRetestInputV1Schema.jsonSchema;

/**
 * The retest reuses the shared provider-failure vocabulary rather than minting
 * a second health verdict: a still-failing probe is reported verbatim and
 * settles no Account state.
 *
 * A probe that answers `ready` is not automatically readiness. Core still
 * compares the capability the probe restated against the promises its own
 * enabled bindings already made, and a promise the provider can no longer
 * deliver is reported through this same `permissionMissing` arm. Both the
 * ready arm and that arm settle Account state through the one canonical
 * lifecycle owner — clearing the retained readiness attention, or recording it.
 */
export const ConversationConnectionRetestResultV1Schema = defineProtocolUnion([
    conversationConnectionRetestReadyV1,
    ConversationProviderFailureV1ProtocolSchema,
]);
export type ConversationConnectionRetestResultV1 = ReturnType<
    typeof ConversationConnectionRetestResultV1Schema.parse
>;
export const ConversationConnectionRetestResultV1JsonSchema: PluginJsonSchema =
    ConversationConnectionRetestResultV1Schema.jsonSchema;

/** The exact manifest-facing declaration for the present-user retest action. */
export const ConversationConnectionRetestManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationConnectionRetestInputV1Schema.jsonSchema,
    resultSchema: ConversationConnectionRetestResultV1Schema.jsonSchema,
});
