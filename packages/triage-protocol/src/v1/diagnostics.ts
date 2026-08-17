import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import {
    MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1,
    TRIAGE_SOURCE_FAILURE_CLASSES_V1,
} from './bounds.js';
import { TriageIdentifierV1ProtocolSchema } from './identity.js';
import { defineTriageSingleLineStringV1 } from './strings.js';

/** @internal Relative-only closed failure classification. */
export const TriageSourceFailureClassV1ProtocolSchema = defineProtocolUnion([
    defineProtocolLiteral(TRIAGE_SOURCE_FAILURE_CLASSES_V1[0]),
    defineProtocolLiteral(TRIAGE_SOURCE_FAILURE_CLASSES_V1[1]),
    defineProtocolLiteral(TRIAGE_SOURCE_FAILURE_CLASSES_V1[2]),
    defineProtocolLiteral(TRIAGE_SOURCE_FAILURE_CLASSES_V1[3]),
    defineProtocolLiteral(TRIAGE_SOURCE_FAILURE_CLASSES_V1[4]),
    defineProtocolLiteral(TRIAGE_SOURCE_FAILURE_CLASSES_V1[5]),
]);

/**
 * One bounded, non-secret source failure.
 *
 * `retryNotBeforeMs` is an absolute epoch-millisecond fact derived from a
 * provider response and is carried only here (`CONTRACT.md` §5.2). A successful
 * scan page has no place to express a retry deadline, which is why the field
 * lives on the failure rather than on a result envelope. `detail` is bounded
 * non-secret text; `code` is the source's own stable local id.
 */
export const TriageSourceFailureV1Schema = defineProtocolObject({
    class: TriageSourceFailureClassV1ProtocolSchema,
    code: TriageIdentifierV1ProtocolSchema,
    detail: defineTriageSingleLineStringV1(MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1).optional(),
    retryNotBeforeMs: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
}, { policy: 'closed' });
export type TriageSourceFailureV1 = ReturnType<typeof TriageSourceFailureV1Schema.parse>;
export const TriageSourceFailureV1JsonSchema: PluginJsonSchema =
    TriageSourceFailureV1Schema.jsonSchema;
