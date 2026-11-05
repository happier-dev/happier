import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolString,
    type ProtocolComposableSchema,
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
 *
 * A source reports what its provider said and applies no horizon of its own: how
 * far ahead a stated deadline may push a refresh is one pacing policy owned by
 * the aggregate that honours it, so a skewed or rewritten header is bounded once
 * for every source rather than in each of them, differently.
 */
export const TriageSourceFailureV1Schema = defineProtocolObject({
    class: TriageSourceFailureClassV1ProtocolSchema,
    code: TriageIdentifierV1ProtocolSchema,
    detail: defineTriageSingleLineStringV1(MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1).optional(),
    retryNotBeforeMs: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
}, { policy: 'closed' });
export type TriageSourceFailureV1 = ReturnType<typeof TriageSourceFailureV1Schema.parse>;

/** Invocation diagnostics only; arbitrary exception messages/data never cross this wire. */
export const TriageListInvocationErrorV1Schema = defineProtocolObject({
    code: TriageIdentifierV1ProtocolSchema,
    retryable: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]).optional(),
    requestId: TriageIdentifierV1ProtocolSchema.optional(),
}, { policy: 'closed' });
export type TriageListInvocationErrorV1 = ReturnType<typeof TriageListInvocationErrorV1Schema.parse>;

/** One failure/read envelope for the domain-versioned protocol subpaths. */
export const TriageReadUnavailableV1Schema = defineProtocolObject({
    kind: defineProtocolLiteral('unavailable'), failure: TriageSourceFailureV1Schema,
}, { policy: 'closed' });

export function defineTriageValueResultV1<T>(value: ProtocolComposableSchema<T>) {
    return defineProtocolUnion([
        defineProtocolObject({ kind: defineProtocolLiteral('value'), value }, { policy: 'closed' }),
        TriageReadUnavailableV1Schema,
    ]);
}

export function defineTriageConditionalReadV1<T>(value: ProtocolComposableSchema<T>) {
    const validator = defineProtocolString().optional();
    return defineProtocolUnion([
        defineProtocolObject({ kind: defineProtocolLiteral('value'), value, validator }, { policy: 'closed' }),
        defineProtocolObject({ kind: defineProtocolLiteral('notModified'), validator }, { policy: 'closed' }),
        TriageReadUnavailableV1Schema,
    ]);
}
