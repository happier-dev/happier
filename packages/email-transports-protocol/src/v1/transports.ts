import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { QualifiedConnectedAccountRefSchema, type QualifiedConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import { ConversationDeliveryResultV1ProtocolSchema, ConversationProviderFailureV1ProtocolSchema, defineProtocolArray, defineProtocolJsonValue, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolComposableSchema } from '@happier-dev/plugin-sdk/protocol';

const text = defineProtocolString({ minLength: 1 });
const ConversationCheckpointV1Schema = defineProtocolJsonValue();
const ConversationProviderConfigV1Schema = defineProtocolJsonValue();
// Preserve the public declaration closure; the SDK canonical parser still owns acceptance.
const accountRef: ProtocolComposableSchema<QualifiedConnectedAccountRef> = QualifiedConnectedAccountRefSchema;
const common = { credentialRef: accountRef.nullable(), config: ConversationProviderConfigV1Schema };
export const EmailTransportConnectionInputV1Schema = defineProtocolObject(common, { policy: 'closed' });
export const EmailTransportListSinceInputV1Schema = defineProtocolObject({ ...common, checkpoint: ConversationCheckpointV1Schema.nullable(), waitMs: defineProtocolNumber({ integer: true, minimum: 0 }), limit: defineProtocolNumber({ integer: true, minimum: 1 }) }, { policy: 'closed' });
export const EmailTransportListSinceResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('batch'), refs: defineProtocolArray(text), checkpointAfterBatch: ConversationCheckpointV1Schema }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('historyGap'), reason: defineProtocolLiteral('providerHistoryUnavailable') }, { policy: 'closed' }),
  ConversationProviderFailureV1ProtocolSchema,
]);
export const EmailTransportFetchRawInputV1Schema = defineProtocolObject({ ...common, ref: text }, { policy: 'closed' });
export const EmailTransportFetchRawResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('raw'), mimeBase64: text,
    receivedAtMs: defineProtocolNumber({ integer: true, minimum: 0 }) }, { policy: 'closed' }), ConversationProviderFailureV1ProtocolSchema,
]);
export const EmailTransportSubmitRawInputV1Schema = defineProtocolObject({
  ...common, mimeBase64: text, messageId: text,
  envelope: defineProtocolObject({ from: text, to: defineProtocolArray(text, { minItems: 1 }) }, { policy: 'closed' }),
}, { policy: 'closed' });
export const EmailTransportConnectionTestResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('ready'), mailbox: text }, { policy: 'closed' }), ConversationProviderFailureV1ProtocolSchema,
]);
export const EmailTransportFindSentInputV1Schema = defineProtocolObject({ ...common, messageId: text }, { policy: 'closed' });
export const EmailTransportFindSentResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('found'), messageId: text }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('notFound') }, { policy: 'closed' }), ConversationProviderFailureV1ProtocolSchema,
]);

/** Raw MIME and transport facts only. Email identity, shaping and recipients remain target-owned. */
export const EmailTransportsContributionProtocolV1 = defineContributionProtocol({
  id: 'happier.channel.email/transports', version: 1,
  operations: {
    listSince: { required: true, input: { kind: 'protocolDefined', schema: EmailTransportListSinceInputV1Schema }, resultSchema: EmailTransportListSinceResultV1Schema, action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
    fetchRaw: { required: true, input: { kind: 'protocolDefined', schema: EmailTransportFetchRawInputV1Schema }, resultSchema: EmailTransportFetchRawResultV1Schema, action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
    submitRaw: { required: true, input: { kind: 'protocolDefined', schema: EmailTransportSubmitRawInputV1Schema }, resultSchema: ConversationDeliveryResultV1ProtocolSchema, action: { surfaces: ['plugin'], dangerLevel: 'writesRemote' } },
    connectionTest: { required: true, input: { kind: 'protocolDefined', schema: EmailTransportConnectionInputV1Schema }, resultSchema: EmailTransportConnectionTestResultV1Schema, action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
    findSent: { required: false, input: { kind: 'protocolDefined', schema: EmailTransportFindSentInputV1Schema }, resultSchema: EmailTransportFindSentResultV1Schema, action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
  },
});
export type EmailTransportConnectionInputV1 = ReturnType<typeof EmailTransportConnectionInputV1Schema.parse>;
export type EmailTransportListSinceInputV1 = ReturnType<typeof EmailTransportListSinceInputV1Schema.parse>;
export type EmailTransportListSinceResultV1 = ReturnType<typeof EmailTransportListSinceResultV1Schema.parse>;
export type EmailTransportFetchRawInputV1 = ReturnType<typeof EmailTransportFetchRawInputV1Schema.parse>;
export type EmailTransportFetchRawResultV1 = ReturnType<typeof EmailTransportFetchRawResultV1Schema.parse>;
export type EmailTransportSubmitRawInputV1 = ReturnType<typeof EmailTransportSubmitRawInputV1Schema.parse>;
export type EmailTransportConnectionTestResultV1 = ReturnType<typeof EmailTransportConnectionTestResultV1Schema.parse>;
export type EmailTransportFindSentInputV1 = ReturnType<typeof EmailTransportFindSentInputV1Schema.parse>;
export type EmailTransportFindSentResultV1 = ReturnType<typeof EmailTransportFindSentResultV1Schema.parse>;
