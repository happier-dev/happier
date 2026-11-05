import { defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { ForgeCiIdV1Schema, ForgeCiSelectionV1Schema } from './identity.js';
import { ForgeCiBooleanV1Schema, ForgeCiTimestampV1Schema } from './runs.js';
import { ForgeCiEnvironmentV1Schema } from './triggers.js';

export const ForgeCiDeploymentApprovalV1Schema = defineProtocolObject({ id: ForgeCiIdV1Schema, selection: ForgeCiSelectionV1Schema, environment: ForgeCiEnvironmentV1Schema, eligible: ForgeCiBooleanV1Schema, waitUntilMs: ForgeCiTimestampV1Schema.optional(), reviewers: defineProtocolArray(defineProtocolString()).optional(), webUrl: defineProtocolString().optional() }, { policy: 'closed' });
export type ForgeCiDeploymentApprovalV1 = ReturnType<typeof ForgeCiDeploymentApprovalV1Schema.parse>;
export const ForgeCiDeploymentReviewV1Schema = defineProtocolObject({ id: ForgeCiIdV1Schema, environmentIds: defineProtocolArray(ForgeCiIdV1Schema), decision: defineProtocolUnion([defineProtocolLiteral('approved'), defineProtocolLiteral('rejected'), defineProtocolLiteral('unknown')]), comment: defineProtocolString(), reviewer: defineProtocolString().optional(), createdAtMs: ForgeCiTimestampV1Schema.optional() }, { policy: 'closed' });
export type ForgeCiDeploymentReviewV1 = ReturnType<typeof ForgeCiDeploymentReviewV1Schema.parse>;
