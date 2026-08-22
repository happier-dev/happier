export { assertTriageSourceContributionV1 } from './assertions.js';
export { checkTriageSourceContributionV1 } from './conformance.js';
export type { TriageSourceConformanceResultV1 } from './conformance.js';
export { createTriageSourceV1Fixture } from './fixtures.js';
export type { TriageSourceV1Fixture } from './fixtures.js';
// The one published byte-gate derivation, plus the two values a caller outside
// this package feeds it: `packages/plugins/triage/src/actions/
// maximumEncodedActionValue.test.ts` builds a maximal value for a schema whose
// reachable bound its own owner narrows, and measures it. The walk's internal
// steps stay importable from `./maximumEncodedValue.js`, which is how this
// package's own `v1/maximumEncodedResult.test.ts` reaches them; publishing them
// would make each one a permanent name for a step of one derivation.
export {
    buildMaximalSchemaValue,
    deriveMaximumEncodedBytes,
    deriveMaximumEncodedBytesByLabel,
    encodedJsonBytes,
} from './maximumEncodedValue.js';
export type { MeasurableSchemaV1 } from './maximumEncodedValue.js';
