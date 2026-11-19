import {
    defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
    defineProtocolString, defineProtocolUnion, type ProtocolComposableSchema,
} from './protocolFacade.js';
import {
    ScmHostingRepositoryIdentityV1ProtocolSchema,
    type ProtocolScmHostingProviderKind,
    type ScmHostingRepositoryIdentityV1,
} from './hostingRepositoryIdentity.js';

/** Internal portable typing of the exact public SCM parser, without a second grammar. */
export const forgeCiRepositoryIdentityV1Schema: ProtocolComposableSchema<ScmHostingRepositoryIdentityV1<ProtocolScmHostingProviderKind>> = ScmHostingRepositoryIdentityV1ProtocolSchema;

/** Exact native identifiers; provider-specific grammar remains at ingress. */
export const ForgeCiIdV1Schema = defineProtocolString({ minLength: 1 });
export const ForgeCiRunRefV1Schema = defineProtocolObject({ v: defineProtocolLiteral(1), repository: forgeCiRepositoryIdentityV1Schema, runId: ForgeCiIdV1Schema }, { policy: 'closed' });
export type ForgeCiRunRefV1 = ReturnType<typeof ForgeCiRunRefV1Schema.parse>;
export const ForgeCiAttemptRefV1Schema = defineProtocolObject({ run: ForgeCiRunRefV1Schema, attemptId: ForgeCiIdV1Schema, number: defineProtocolNumber({ integer: true, minimum: 1 }).optional() }, { policy: 'closed' });
export type ForgeCiAttemptRefV1 = ReturnType<typeof ForgeCiAttemptRefV1Schema.parse>;
export const ForgeCiSelectionV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('run'), run: ForgeCiRunRefV1Schema }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('attempt'), attempt: ForgeCiAttemptRefV1Schema }, { policy: 'closed' }),
]);
export type ForgeCiSelectionV1 = ReturnType<typeof ForgeCiSelectionV1Schema.parse>;
export const ForgeCiJobRefV1Schema = defineProtocolObject({ selection: ForgeCiSelectionV1Schema, jobId: ForgeCiIdV1Schema }, { policy: 'closed' });
export type ForgeCiJobRefV1 = ReturnType<typeof ForgeCiJobRefV1Schema.parse>;
export const ForgeCiStepRefV1Schema = defineProtocolObject({ job: ForgeCiJobRefV1Schema, stepId: ForgeCiIdV1Schema }, { policy: 'closed' });
export type ForgeCiStepRefV1 = ReturnType<typeof ForgeCiStepRefV1Schema.parse>;

export const ForgeCiIdV1JsonSchema = /* @__PURE__ */ (() => ForgeCiIdV1Schema.jsonSchema)();
export const ForgeCiRunRefV1JsonSchema = /* @__PURE__ */ (() => ForgeCiRunRefV1Schema.jsonSchema)();
export const ForgeCiAttemptRefV1JsonSchema = /* @__PURE__ */ (() => ForgeCiAttemptRefV1Schema.jsonSchema)();
export const ForgeCiSelectionV1JsonSchema = /* @__PURE__ */ (() => ForgeCiSelectionV1Schema.jsonSchema)();
export const ForgeCiJobRefV1JsonSchema = /* @__PURE__ */ (() => ForgeCiJobRefV1Schema.jsonSchema)();
export const ForgeCiStepRefV1JsonSchema = /* @__PURE__ */ (() => ForgeCiStepRefV1Schema.jsonSchema)();

const nonterminalPhase = defineProtocolUnion([defineProtocolLiteral('queued'), defineProtocolLiteral('running'), defineProtocolLiteral('waiting')]);
const terminalOutcome = defineProtocolUnion([defineProtocolLiteral('success'), defineProtocolLiteral('failure'), defineProtocolLiteral('cancelled'), defineProtocolLiteral('skipped'), defineProtocolLiteral('neutral'), defineProtocolLiteral('timed_out'), defineProtocolLiteral('action_required'), defineProtocolLiteral('startup_failure'), defineProtocolLiteral('stale'), defineProtocolLiteral('unknown')]);
const bucket = defineProtocolUnion([defineProtocolLiteral('passed'), defineProtocolLiteral('failed'), defineProtocolLiteral('pending'), defineProtocolLiteral('neutral'), defineProtocolLiteral('unknown')]);
const facts = { nativeLabel: defineProtocolString(), outcomeBucket: bucket };
export const ForgeCiStateV1Schema = defineProtocolUnion([
    defineProtocolObject({ ...facts, phase: nonterminalPhase, outcome: defineProtocolLiteral(null) }, { policy: 'closed' }),
    defineProtocolObject({ ...facts, phase: defineProtocolLiteral('completed'), outcome: terminalOutcome }, { policy: 'closed' }),
    defineProtocolObject({ ...facts, phase: defineProtocolLiteral('unknown'), outcome: defineProtocolLiteral('unknown') }, { policy: 'closed' }),
]);
export type ForgeCiStateV1 = ReturnType<typeof ForgeCiStateV1Schema.parse>;
export const ForgeCiStateV1JsonSchema = /* @__PURE__ */ (() => ForgeCiStateV1Schema.jsonSchema)();

const coordinate = defineProtocolNumber({ integer: true, minimum: 1 });
export const ForgeCiAnnotationV1Schema = defineProtocolObject({ id: ForgeCiIdV1Schema, job: ForgeCiJobRefV1Schema, checkRunId: ForgeCiIdV1Schema, level: defineProtocolUnion([defineProtocolLiteral('notice'), defineProtocolLiteral('warning'), defineProtocolLiteral('error')]), message: defineProtocolString(), title: defineProtocolString().optional(), path: defineProtocolString().optional(), startLine: coordinate.optional(), endLine: coordinate.optional(), startColumn: coordinate.optional(), endColumn: coordinate.optional(), details: defineProtocolString().optional(), webUrl: defineProtocolString().optional() }, { policy: 'closed' });
export type ForgeCiAnnotationV1 = ReturnType<typeof ForgeCiAnnotationV1Schema.parse>;
export const ForgeCiAnnotationV1JsonSchema = /* @__PURE__ */ (() => ForgeCiAnnotationV1Schema.jsonSchema)();

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
