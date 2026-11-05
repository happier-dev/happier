import {
    defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
    defineProtocolString, defineProtocolUnion, ScmHostingRepositoryIdentityV1ProtocolSchema,
    type ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';
import type { ProtocolScmHostingProviderKind, ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import { ForgeCiAttemptRefV1Schema, ForgeCiIdV1Schema, ForgeCiRunRefV1Schema } from './identity.js';
import { ForgeCiStateV1Schema } from './state.js';

export const ForgeCiBooleanV1Schema = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
export const ForgeCiTimestampV1Schema = defineProtocolNumber({ integer: true, minimum: 0 });
export const ForgeCiWorkflowV1Schema = defineProtocolObject({ id: ForgeCiIdV1Schema, name: defineProtocolString(), path: defineProtocolString().optional(), nativeState: defineProtocolString(), webUrl: defineProtocolString().optional(), description: defineProtocolString().optional() }, { policy: 'closed' });
export type ForgeCiWorkflowV1 = ReturnType<typeof ForgeCiWorkflowV1Schema.parse>;
export const ForgeCiWorkflowRefV1Schema = defineProtocolObject({
    id: ForgeCiIdV1Schema,
    path: defineProtocolString().optional(),
}, { policy: 'closed' });
export type ForgeCiWorkflowRefV1 = ReturnType<typeof ForgeCiWorkflowRefV1Schema.parse>;
export const ForgeCiRunFiltersV1Schema = defineProtocolObject({ actor: defineProtocolString().optional(), branch: defineProtocolString().optional(), event: defineProtocolString().optional(), state: defineProtocolString().optional(), created: defineProtocolString().optional(), excludePullRequests: ForgeCiBooleanV1Schema.optional(), checkSuiteId: ForgeCiIdV1Schema.optional(), headSha: ForgeCiIdV1Schema.optional() }, { policy: 'closed' });
export type ForgeCiRunFiltersV1 = ReturnType<typeof ForgeCiRunFiltersV1Schema.parse>;
// Use the public portable kind name while retaining the SCM owner's parser.
const sourceRepository: ProtocolComposableSchema<ScmHostingRepositoryIdentityV1<ProtocolScmHostingProviderKind>> = ScmHostingRepositoryIdentityV1ProtocolSchema;
export const ForgeCiRunV1Schema = defineProtocolObject({
    ref: ForgeCiRunRefV1Schema,
    state: ForgeCiStateV1Schema,
    title: defineProtocolString().optional(),
    number: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
    headSha: ForgeCiIdV1Schema.optional(),
    headRef: defineProtocolString().optional(),
    /** Missing approval or provenance is unknown; generic waiting proves neither. */
    forkApproval: defineProtocolObject({
        required: ForgeCiBooleanV1Schema,
        contributor: ForgeCiIdV1Schema.optional(),
        sourceRepository: sourceRepository.optional(),
    }, { policy: 'closed' }).optional(),
    createdAtMs: ForgeCiTimestampV1Schema.optional(),
    startedAtMs: ForgeCiTimestampV1Schema.optional(),
    completedAtMs: ForgeCiTimestampV1Schema.optional(),
    /** Native last-update fact, distinct from an explicit completion timestamp. */
    updatedAtMs: ForgeCiTimestampV1Schema.optional(),
    workflow: ForgeCiWorkflowRefV1Schema.optional(),
    webUrl: defineProtocolString().optional(),
    currentAttempt: ForgeCiAttemptRefV1Schema.optional(),
    attemptCount: defineProtocolNumber({ integer: true, minimum: 1 }).optional(),
}, { policy: 'closed' });
export type ForgeCiRunV1 = ReturnType<typeof ForgeCiRunV1Schema.parse>;
