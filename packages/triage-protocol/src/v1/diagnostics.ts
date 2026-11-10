import { triageListSourceSchemasV1 } from './listSourceSchemaInstances.js';
import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    type ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';

import { TriageIdentifierV1ProtocolSchema } from './identity.js';

/** @internal Relative-only closed failure classification. */
export const { TriageSourceFailureClassV1ProtocolSchema } = triageListSourceSchemasV1;
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
export const { TriageSourceFailureV1Schema } = triageListSourceSchemasV1;
export type TriageSourceFailureV1 = ReturnType<typeof TriageSourceFailureV1Schema.parse>;

/** Invocation diagnostics only; arbitrary exception messages/data never cross this wire. */
export const { TriageListInvocationErrorV1Schema } = triageListSourceSchemasV1;
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

export function defineTriageConditionalReadV1<T, TSuccessFields extends Readonly<Record<string, ProtocolComposableSchema<unknown>>> = Record<never, never>>(
    value: ProtocolComposableSchema<T>, successFields?: TSuccessFields,
) {
    const validator = defineProtocolString().optional();
    return defineProtocolUnion([
        defineProtocolObject({ ...successFields, kind: defineProtocolLiteral('value'), value, validator }, { policy: 'closed' }),
        defineProtocolObject({ ...successFields, kind: defineProtocolLiteral('notModified'), validator }, { policy: 'closed' }),
        TriageReadUnavailableV1Schema,
    ]);
}
