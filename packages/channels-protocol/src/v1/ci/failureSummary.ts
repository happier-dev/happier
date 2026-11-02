import { defineProtocolArray, defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { ForgeCiAnnotationV1Schema } from './annotations.js';
import { ForgeCiIdV1Schema, ForgeCiJobRefV1Schema, ForgeCiSelectionV1Schema, forgeCiRepositoryIdentityV1Schema } from './identity.js';
import { ForgeCiStateV1Schema } from './state.js';

const line = defineProtocolNumber({ integer: true, minimum: 1 });
const byte = defineProtocolNumber({ integer: true, minimum: 0 });
export const ForgeCiFailureExcerptV1Schema = defineProtocolObject({
    job: ForgeCiJobRefV1Schema,
    startLine: line,
    endLine: line,
    startByte: byte.optional(),
    endByte: byte.optional(),
    text: defineProtocolString(),
}, { policy: 'closed' });
export type ForgeCiFailureExcerptV1 = ReturnType<typeof ForgeCiFailureExcerptV1Schema.parse>;
export const ForgeCiFailureSummaryV1Schema = defineProtocolObject({
    repository: forgeCiRepositoryIdentityV1Schema,
    selection: ForgeCiSelectionV1Schema,
    headSha: ForgeCiIdV1Schema.optional(),
    workflowPath: defineProtocolString().optional(),
    webUrl: defineProtocolString().optional(),
    jobs: defineProtocolArray(defineProtocolObject({
        job: ForgeCiJobRefV1Schema,
        name: defineProtocolString(),
        state: ForgeCiStateV1Schema,
        steps: defineProtocolArray(defineProtocolObject({
            stepId: ForgeCiIdV1Schema,
            name: defineProtocolString(),
            state: ForgeCiStateV1Schema,
        }, { policy: 'closed' })),
    }, { policy: 'closed' })),
    annotations: defineProtocolArray(ForgeCiAnnotationV1Schema),
    excerpts: defineProtocolArray(ForgeCiFailureExcerptV1Schema),
    missing: defineProtocolArray(defineProtocolString()),
    ambiguous: defineProtocolArray(defineProtocolString()),
    omitted: defineProtocolArray(defineProtocolString()),
    continuation: defineProtocolString({ minLength: 1 }).nullable(),
}, { policy: 'closed' });
export type ForgeCiFailureSummaryV1 = ReturnType<typeof ForgeCiFailureSummaryV1Schema.parse>;
export const ForgeCiFailureExcerptV1JsonSchema = /* @__PURE__ */ (() => ForgeCiFailureExcerptV1Schema.jsonSchema)();
export const ForgeCiFailureSummaryV1JsonSchema = /* @__PURE__ */ (() => ForgeCiFailureSummaryV1Schema.jsonSchema)();
