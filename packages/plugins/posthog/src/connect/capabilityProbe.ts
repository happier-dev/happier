import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
    TriageSourceFailureV1Schema,
    TriageSourceInstanceDraftV1Schema,
} from '@happier-dev/triage-protocol/v1';

export const PosthogCapabilityProbeInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    draft: TriageSourceInstanceDraftV1Schema,
}, { policy: 'closed' });
export type PosthogCapabilityProbeInputV1 = ReturnType<
    typeof PosthogCapabilityProbeInputV1Schema.parse
>;

export const PosthogCapabilityProbeResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('available') }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('unavailable'),
        failure: TriageSourceFailureV1Schema,
    }, { policy: 'closed' }),
]);
export type PosthogCapabilityProbeResultV1 = ReturnType<
    typeof PosthogCapabilityProbeResultV1Schema.parse
>;
