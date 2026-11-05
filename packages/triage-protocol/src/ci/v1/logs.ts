import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, defineProtocolUniqueArray } from '@happier-dev/plugin-sdk/protocol';
import { ForgeCiIdV1Schema, ForgeCiJobRefV1Schema } from './identity.js';
import { ForgeCiBooleanV1Schema } from './runs.js';

const count = defineProtocolNumber({ integer: true, minimum: 0 });
const line = defineProtocolNumber({ integer: true, minimum: 1 });
export const ForgeCiLogSelectionV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('all') }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('tail'), lines: line }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('steps'), stepIds: defineProtocolUniqueArray(ForgeCiIdV1Schema, { minItems: 1 }) }, { policy: 'closed' }),
]);
export type ForgeCiLogSelectionV1 = ReturnType<typeof ForgeCiLogSelectionV1Schema.parse>;
export const ForgeCiExcerptRequestV1Schema = defineProtocolObject({
    contextLines: count,
    tailLines: count,
    failedOnly: ForgeCiBooleanV1Schema,
    stepIds: defineProtocolUniqueArray(ForgeCiIdV1Schema, { minItems: 1 }).optional(),
}, { policy: 'closed' });
export type ForgeCiExcerptRequestV1 = ReturnType<typeof ForgeCiExcerptRequestV1Schema.parse>;
export const ForgeCiLogFragmentV1Schema = defineProtocolObject({ text: defineProtocolString(), startLine: line, startByte: count }, { policy: 'closed' });
export type ForgeCiLogFragmentV1 = ReturnType<typeof ForgeCiLogFragmentV1Schema.parse>;
const available = {
    kind: defineProtocolLiteral('available'),
    job: ForgeCiJobRefV1Schema,
    logId: ForgeCiIdV1Schema,
    startLine: line,
    startByte: count,
    // Native EOF reached. Loaded completeness also requires original byte-zero,
    // line-one coverage without gaps; a final carrier page alone is not complete.
    complete: ForgeCiBooleanV1Schema,
    continuation: defineProtocolString({ minLength: 1 }).nullable(),
};
export const ForgeCiLogV1Schema = defineProtocolUnion([
    defineProtocolObject({ ...available, text: defineProtocolString() }, { policy: 'closed' }),
    defineProtocolObject({ ...available, fragments: defineProtocolArray(ForgeCiLogFragmentV1Schema, { minItems: 1 }) }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('pending'), job: ForgeCiJobRefV1Schema }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('expired'), job: ForgeCiJobRefV1Schema }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('unsupported'), job: ForgeCiJobRefV1Schema }, { policy: 'closed' }),
]);
export type ForgeCiLogV1 = ReturnType<typeof ForgeCiLogV1Schema.parse>;
