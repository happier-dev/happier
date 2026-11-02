import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, ScmHostingRepositoryIdentityV1ProtocolSchema, type ProtocolComposableSchema } from '@happier-dev/plugin-sdk/protocol';
import type { ProtocolScmHostingProviderKind, ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';

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
