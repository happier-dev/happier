import { defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

import { TriageSourceFailureV1Schema } from './diagnostics.js';
import { TriageSourceEntryLocalRefV1Schema, TriageTextV1ProtocolSchema } from './identity.js';
import { TriageEntryStateV1ProtocolSchema } from './observations.js';
import { TriagePullRequestRequirementRefV1Schema } from './pullRequestStatus.js';

const presentation = defineProtocolObject({
    title: TriageTextV1ProtocolSchema,
    titleKey: TriageTextV1ProtocolSchema.optional(),
    description: TriageTextV1ProtocolSchema,
    descriptionKey: TriageTextV1ProtocolSchema.optional(),
    tone: defineProtocolUnion([defineProtocolLiteral('secondary'), defineProtocolLiteral('neutral'),
        defineProtocolLiteral('warning'), defineProtocolLiteral('danger')]),
}, { policy: 'closed' });

/** Source-owned native outcome. Host approval/transport settlement is not a native result. */
export const TriageSourceOperationOutcomeV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('applied'),
        effect: defineProtocolUnion([defineProtocolLiteral('changed'), defineProtocolLiteral('alreadySatisfied')]),
        /** Source-local display correspondence only, never credential or mutation authority. */
        confirmedState: TriageEntryStateV1ProtocolSchema.nullable(),
        confirmedEntryRef: TriageSourceEntryLocalRefV1Schema.nullable(),
        presentation,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('refused'), reason: TriageTextV1ProtocolSchema,
        unmetRequirements: defineProtocolArray(TriagePullRequestRequirementRefV1Schema).optional(),
        presentation,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('uncertain'), failure: TriageSourceFailureV1Schema.nullable(), presentation,
    }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('failed'), failure: TriageSourceFailureV1Schema, presentation }, { policy: 'closed' }),
]);
export type TriageSourceOperationOutcomeV1 = ReturnType<typeof TriageSourceOperationOutcomeV1Schema.parse>;

/** The generic consumer admits only the public outcome, not a provider's native union. */
export function readTriageSourceOperationOutcomeV1(result: unknown): TriageSourceOperationOutcomeV1 | null {
    if (typeof result !== 'object' || result === null || !('outcome' in result)) return null;
    const parsed = TriageSourceOperationOutcomeV1Schema.safeParse(result.outcome);
    return parsed.success ? parsed.data : null;
}
