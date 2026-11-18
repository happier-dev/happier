import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { TriageEntryRefV1Schema, TriageIdentifierV1ProtocolSchema, TriageSourceEntryLocalRefV1Schema, TriageTextV1ProtocolSchema } from './identity.js';
import { TriageConfiguredSourceInstanceV1Schema, TriageConfiguredSourceConnectedAccountInstanceV1Schema, TriageConfiguredSourceCredentialInstanceV1Schema } from './instances.js';
import { TriageScanContinuationV1Schema } from './observations.js';
import { TriageSourceFailureV1Schema } from './diagnostics.js';
import type { ProtocolComposableSchema } from '@happier-dev/plugin-sdk/protocol';

function readInput<I, O>(instance: ProtocolComposableSchema<I, O>) {
  return defineProtocolObject({ v: defineProtocolLiteral(1), instance, cursor: TriageScanContinuationV1Schema.optional() }, { policy: 'closed' });
}
export const TriageReadAttentionInputV1Schema = readInput(TriageConfiguredSourceInstanceV1Schema);
export const TriageReadAttentionConnectedAccountInputV1Schema = readInput(TriageConfiguredSourceConnectedAccountInstanceV1Schema);
export const TriageReadAttentionCredentialInputV1Schema = readInput(TriageConfiguredSourceCredentialInstanceV1Schema);
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const attentionFields = {
  reason: defineProtocolUnion([defineProtocolLiteral('reviewRequested'), defineProtocolLiteral('assignment'), defineProtocolLiteral('watchedAlert'), defineProtocolLiteral('review_needs_you')]),
  type: defineProtocolUnion([defineProtocolLiteral('decision'), defineProtocolLiteral('update'), defineProtocolLiteral('mention')]),
  title: TriageTextV1ProtocolSchema,
  resolved: boolean,
};
export const TriageReadAttentionResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('page'),
    items: defineProtocolArray(defineProtocolObject({ localRef: TriageSourceEntryLocalRefV1Schema, ...attentionFields }, { policy: 'closed' })),
    cursor: TriageScanContinuationV1Schema.optional(), nextPage: boolean,
    // Only the source contract may supply a next-poll delay. Missing means no automatic poll.
    pollIntervalMs: defineProtocolNumber({ integer: true, minimum: 1 }).optional(),
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('failed'), failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
]);
export type TriageReadAttentionInputV1 = ReturnType<typeof TriageReadAttentionInputV1Schema.parse>;
export type TriageReadAttentionResultV1 = ReturnType<typeof TriageReadAttentionResultV1Schema.parse>;

/** Verified source ingress sends bounded, source-read facts; Triage owns the destination and notice. */
export const TRIAGE_PUBLISH_ATTENTION_ACTION_REF_V1 = { pluginId: 'happier.triage', localId: 'attention/publish-v1' } as const;
export const TriagePublishAttentionInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1), sourceInstanceId: TriageIdentifierV1ProtocolSchema,
  clientRequestId: TriageTextV1ProtocolSchema, entryRef: TriageEntryRefV1Schema, ...attentionFields,
}, { policy: 'closed' });
export const TriagePublishAttentionResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ v: defineProtocolLiteral(1), kind: defineProtocolLiteral('published'), itemId: TriageTextV1ProtocolSchema }, { policy: 'closed' }),
  defineProtocolObject({ v: defineProtocolLiteral(1), kind: defineProtocolLiteral('rejected'), code: TriageIdentifierV1ProtocolSchema }, { policy: 'closed' }),
]);
