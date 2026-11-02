import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';

import {
    MAX_CONVERSATION_RECEIVE_BATCH_ENTRIES,
    MAX_CONVERSATION_RECEIVE_WAIT_MS,
    MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES,
} from '../bounds.js';
import { ConversationIngressObservedEntryV1ProtocolSchema } from '../core/ingress.js';
import { ConversationResolvedEndpointV1ProtocolSchema } from './resolution.js';
import {
    ConversationProviderDiagnosticV1ProtocolSchema,
    ConversationProviderFailureV1ProtocolSchema,
} from '../diagnostics.js';
import {
    ConversationCheckpointV1ProtocolSchema,
} from '../json.js';
import {
    ConversationProviderConnectionInputV1Fields,
} from './connection.js';

/** @internal Relative-only input for the core-owned checkpointed-poll role. */
export const ConversationPollInputV1ProtocolSchema = defineProtocolObject({
    ...ConversationProviderConnectionInputV1Fields,
    bindings: defineProtocolArray(defineProtocolObject({
        endpoint: ConversationResolvedEndpointV1ProtocolSchema,
        /** Replays preserve the endpoint context frozen by their first census. */
        excludedMessageIds: defineProtocolArray(defineProtocolUtf8String({
            minLength: 1,
            maxUtf8Bytes: MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES,
        })).optional(),
        scopedTriggerKind: defineProtocolUnion([defineProtocolLiteral('prComment'), defineProtocolLiteral('ciFailed')]).optional(),
    }, { policy: 'closed' })).optional(),
    checkpoint: ConversationCheckpointV1ProtocolSchema.nullable(),
    limit: defineProtocolNumber({
        integer: true,
        minimum: 1,
        maximum: MAX_CONVERSATION_RECEIVE_BATCH_ENTRIES,
    }),
    waitMs: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: MAX_CONVERSATION_RECEIVE_WAIT_MS,
    }),
}, { policy: 'closed' });

export const ConversationPollInputV1Schema = ConversationPollInputV1ProtocolSchema;
export type ConversationPollInputV1 = ReturnType<typeof ConversationPollInputV1Schema.parse>;
export const ConversationPollInputV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationPollInputV1Schema.jsonSchema)();

const retryHintV1 = defineProtocolObject({
    retryAfterMs: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
}, { policy: 'closed' });

const batchObservationsV1 = defineProtocolArray(
    ConversationIngressObservedEntryV1ProtocolSchema,
    { maxItems: MAX_CONVERSATION_RECEIVE_BATCH_ENTRIES },
);

const conversationPollBatchResultV1 = defineProtocolObject({
    kind: defineProtocolLiteral('batch'),
    observations: batchObservationsV1,
    pullRequestEndpoints: defineProtocolArray(ConversationResolvedEndpointV1ProtocolSchema).optional(),
    checkpointAfterBatch: ConversationCheckpointV1ProtocolSchema,
    retryHint: retryHintV1.optional(),
}, { policy: 'closed' });

const conversationPollCheckpointOnlyResultV1 = defineProtocolObject({
    kind: defineProtocolLiteral('checkpointOnly'),
    pullRequestEndpoints: defineProtocolArray(ConversationResolvedEndpointV1ProtocolSchema).optional(),
    checkpointAfterBatch: ConversationCheckpointV1ProtocolSchema,
    retryHint: retryHintV1.optional(),
}, { policy: 'closed' });

const conversationPollHistoryGapResultV1 = defineProtocolObject({
    kind: defineProtocolLiteral('historyGap'),
    reason: defineProtocolLiteral('providerHistoryUnavailable'),
    diagnostic: ConversationProviderDiagnosticV1ProtocolSchema.optional(),
}, { policy: 'closed' });

/** @internal Relative-only result for one provider polling invocation. */
export const ConversationPollResultV1ProtocolSchema = defineProtocolUnion([
    conversationPollBatchResultV1,
    conversationPollCheckpointOnlyResultV1,
    conversationPollHistoryGapResultV1,
    ConversationProviderFailureV1ProtocolSchema,
]);

export const ConversationPollResultV1Schema = ConversationPollResultV1ProtocolSchema;
export type ConversationPollResultV1 = ReturnType<typeof ConversationPollResultV1Schema.parse>;
export const ConversationPollResultV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationPollResultV1Schema.jsonSchema)();
