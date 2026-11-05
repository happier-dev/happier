import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { ForgeCiIdV1Schema } from './identity.js';
import { ForgeCiBooleanV1Schema } from './runs.js';

const value = defineProtocolUnion([defineProtocolString(), ForgeCiBooleanV1Schema, defineProtocolNumber()]);
// Native input names are the declared record keys, not unknown metadata.
export const ForgeCiTriggerValuesV1Schema = defineProtocolObject({}, { policy: 'additive-open/preserve', additionalProperties: value });
export type ForgeCiTriggerValuesV1 = ReturnType<typeof ForgeCiTriggerValuesV1Schema.parse>;
export const ForgeCiTriggerInputV1Schema = defineProtocolObject({ name: ForgeCiIdV1Schema, type: defineProtocolUnion([defineProtocolLiteral('string'), defineProtocolLiteral('boolean'), defineProtocolLiteral('number'), defineProtocolLiteral('choice'), defineProtocolLiteral('environment')]), description: defineProtocolString().optional(), required: ForgeCiBooleanV1Schema.optional(), default: value.optional(), options: defineProtocolArray(defineProtocolString()).optional() }, { policy: 'closed' });
export type ForgeCiTriggerInputV1 = ReturnType<typeof ForgeCiTriggerInputV1Schema.parse>;
/** Supplied definition facts only; no expression evaluation or matrix expansion. */
export const ForgeCiWorkflowJobV1Schema = defineProtocolObject({
    id: ForgeCiIdV1Schema,
    needs: defineProtocolArray(ForgeCiIdV1Schema),
    runsOn: defineProtocolUnion([
        defineProtocolArray(defineProtocolString()),
        defineProtocolLiteral('dynamic'),
    ]),
}, { policy: 'closed' });
export type ForgeCiWorkflowJobV1 = ReturnType<typeof ForgeCiWorkflowJobV1Schema.parse>;
export const ForgeCiTriggerDefinitionV1Schema = defineProtocolObject({
    workflowId: ForgeCiIdV1Schema,
    ref: ForgeCiIdV1Schema,
    revision: ForgeCiIdV1Schema,
    inputs: defineProtocolArray(ForgeCiTriggerInputV1Schema),
    dispatchable: ForgeCiBooleanV1Schema,
    description: defineProtocolString().optional(),
    triggers: defineProtocolArray(defineProtocolString()).optional(),
    path: defineProtocolString().optional(),
    /** Omitted means unobserved; an empty array is an observed empty definition. */
    jobs: defineProtocolArray(ForgeCiWorkflowJobV1Schema).optional(),
}, { policy: 'closed' });
export type ForgeCiTriggerDefinitionV1 = ReturnType<typeof ForgeCiTriggerDefinitionV1Schema.parse>;
export const ForgeCiEnvironmentV1Schema = defineProtocolObject({ id: ForgeCiIdV1Schema, name: defineProtocolString(), webUrl: defineProtocolString().optional() }, { policy: 'closed' });
export type ForgeCiEnvironmentV1 = ReturnType<typeof ForgeCiEnvironmentV1Schema.parse>;
