import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolObject,
} from '@happier-dev/plugin-sdk/protocol';

import { MAX_TRIAGE_KINDS_V1 } from './bounds.js';
import {
    TriageIdentifierV1ProtocolSchema,
    TriageSourceWorkflowSubjectV1Schema,
    TriageTextV1ProtocolSchema,
} from './identity.js';

/**
 * @internal One declared source-local entry kind. Kind entries are closed: a
 * kind carries routing and admission authority because every emitted local ref
 * is validated against this declared vocabulary (`CONTRACT.md` §3).
 */
export const TriageSourceKindDescriptorV1ProtocolSchema = defineProtocolObject({
    id: TriageIdentifierV1ProtocolSchema,
    workflowSubject: TriageSourceWorkflowSubjectV1Schema,
    displayName: TriageTextV1ProtocolSchema,
    pluralDisplayName: TriageTextV1ProtocolSchema.optional(),
}, { policy: 'closed' });

/**
 * The source's presentation, declared Connected Account purpose, and
 * source-local kind vocabulary.
 *
 * The outer object is `additive-open/drop`: an unknown outer property is
 * bounded presentation and is dropped rather than rejected (`CONTRACT.md` §8).
 * The nested kind entries stay closed because they carry admission authority.
 * `kinds[].id` uniqueness is a keyed invariant the target enforces over the
 * parsed value (`CONTRACT.md` §2.4); the public algebra has no keyed helper.
 */
export const TriageSourceDescriptorV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    purpose: TriageIdentifierV1ProtocolSchema,
    displayName: TriageTextV1ProtocolSchema,
    kinds: defineProtocolArray(TriageSourceKindDescriptorV1ProtocolSchema, {
        minItems: 1,
        maxItems: MAX_TRIAGE_KINDS_V1,
    }),
}, { policy: 'additive-open/drop' });
export type TriageSourceDescriptorV1 = ReturnType<typeof TriageSourceDescriptorV1Schema.parse>;
