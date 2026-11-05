import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { TriageSourceFailureV1Schema } from '../../v1/diagnostics.js';
import { ForgeCiIdV1Schema, ForgeCiJobRefV1Schema } from './identity.js';
import { ForgeCiStateV1Schema } from './state.js';
import { ForgeCiTimestampV1Schema } from './runs.js';

export const ForgeCiStepV1Schema = defineProtocolObject({
    id: ForgeCiIdV1Schema,
    number: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
    name: defineProtocolString(),
    state: ForgeCiStateV1Schema,
    startedAtMs: ForgeCiTimestampV1Schema.optional(),
    completedAtMs: ForgeCiTimestampV1Schema.optional(),
    /** Whole-second native endpoints cover that entire second for log attribution. */
    timestampPrecision: defineProtocolLiteral('second').optional(),
}, { policy: 'closed' });
export type ForgeCiStepV1 = ReturnType<typeof ForgeCiStepV1Schema.parse>;
export const ForgeCiStepsV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('available'), values: defineProtocolArray(ForgeCiStepV1Schema) }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('unsupported') }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
]);
export const ForgeCiJobV1Schema = defineProtocolObject({
    ref: ForgeCiJobRefV1Schema,
    name: defineProtocolString(),
    state: ForgeCiStateV1Schema,
    steps: ForgeCiStepsV1Schema,
    runnerName: defineProtocolString().optional(),
    runnerLabels: defineProtocolArray(defineProtocolString()).optional(),
    headSha: ForgeCiIdV1Schema.optional(),
    startedAtMs: ForgeCiTimestampV1Schema.optional(),
    completedAtMs: ForgeCiTimestampV1Schema.optional(),
    webUrl: defineProtocolString().optional(),
    checkRunId: ForgeCiIdV1Schema.optional(),
    annotationsCount: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
}, { policy: 'closed' });
export type ForgeCiJobV1 = ReturnType<typeof ForgeCiJobV1Schema.parse>;
