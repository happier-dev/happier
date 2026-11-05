import {
    defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
    defineProtocolString, defineProtocolUnion, defineProtocolUniqueArray,
    FileDownloadDestinationV1ProtocolSchema, FileDownloadResultV1ProtocolSchema,
    ScmHostingRepositoryIdentityV1ProtocolSchema,
} from '@happier-dev/plugin-sdk/protocol';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import { TriageSourceFailureV1Schema, defineTriageConditionalReadV1, defineTriageValueResultV1 } from '../../v1/diagnostics.js';
import { defineTriagePagedPanelPageV1 } from '../../v1/pagedPanel.js';
import { ForgeCiIdV1Schema, ForgeCiRunRefV1Schema, ForgeCiSelectionV1Schema } from './identity.js';
import { ForgeCiBooleanV1Schema, ForgeCiRunFiltersV1Schema, ForgeCiRunV1Schema, ForgeCiWorkflowV1Schema } from './runs.js';
import { ForgeCiJobV1Schema } from './jobs.js';
import { ForgeCiExcerptRequestV1Schema, ForgeCiLogSelectionV1Schema, ForgeCiLogV1Schema } from './logs.js';
import { ForgeCiEnvironmentV1Schema, ForgeCiTriggerDefinitionV1Schema, ForgeCiTriggerValuesV1Schema } from './triggers.js';
import { ForgeCiArtifactV1Schema } from './artifacts.js';
import { ForgeCiAnnotationV1Schema } from './annotations.js';
import { ForgeCiDeploymentApprovalV1Schema, ForgeCiDeploymentReviewV1Schema } from './approvals.js';
import { ForgeCiFailureSummaryV1Schema } from './failureSummary.js';

const closed = { policy: 'closed' } as const;
const repository = ScmHostingRepositoryIdentityV1ProtocolSchema;
const credentialRef = QualifiedConnectedAccountRefSchema.nullable().optional();
const cursor = defineProtocolString({ minLength: 1 }).optional();
const validator = defineProtocolString().optional();
const attempt = ForgeCiIdV1Schema.optional();
const runId = ForgeCiIdV1Schema;
const workflowId = ForgeCiIdV1Schema;
const jobId = ForgeCiIdV1Schema;
const maxSerializedBytes = defineProtocolNumber({ integer: true, minimum: 1 });
const incomplete = defineProtocolUnion([defineProtocolLiteral('pagination'), defineProtocolLiteral('provider_ceiling')]);
export const ForgeCiWorkflowPageV1Schema = defineTriagePagedPanelPageV1(ForgeCiWorkflowV1Schema, incomplete);
export const ForgeCiRunPageV1Schema = defineTriagePagedPanelPageV1(ForgeCiRunV1Schema, incomplete);
export const ForgeCiJobPageV1Schema = defineTriagePagedPanelPageV1(ForgeCiJobV1Schema, incomplete);
export const ForgeCiArtifactPageV1Schema = defineTriagePagedPanelPageV1(ForgeCiArtifactV1Schema, incomplete);
export const ForgeCiAnnotationPageV1Schema = defineTriagePagedPanelPageV1(ForgeCiAnnotationV1Schema, incomplete);
export const ForgeCiEnvironmentPageV1Schema = defineTriagePagedPanelPageV1(ForgeCiEnvironmentV1Schema, incomplete);
export const ForgeCiDeploymentPageV1Schema = defineTriagePagedPanelPageV1(ForgeCiDeploymentApprovalV1Schema, incomplete);
export const ForgeCiDeploymentReviewPageV1Schema = defineTriagePagedPanelPageV1(ForgeCiDeploymentReviewV1Schema, incomplete);
export type ForgeCiWorkflowPageV1 = ReturnType<typeof ForgeCiWorkflowPageV1Schema.parse>;
export type ForgeCiRunPageV1 = ReturnType<typeof ForgeCiRunPageV1Schema.parse>;
export type ForgeCiJobPageV1 = ReturnType<typeof ForgeCiJobPageV1Schema.parse>;
export type ForgeCiArtifactPageV1 = ReturnType<typeof ForgeCiArtifactPageV1Schema.parse>;
export type ForgeCiAnnotationPageV1 = ReturnType<typeof ForgeCiAnnotationPageV1Schema.parse>;
export type ForgeCiEnvironmentPageV1 = ReturnType<typeof ForgeCiEnvironmentPageV1Schema.parse>;
export type ForgeCiDeploymentPageV1 = ReturnType<typeof ForgeCiDeploymentPageV1Schema.parse>;
export type ForgeCiDeploymentReviewPageV1 = ReturnType<typeof ForgeCiDeploymentReviewPageV1Schema.parse>;
const affected = defineProtocolObject({
    repository,
    run: ForgeCiRunRefV1Schema.optional(),
    selection: ForgeCiSelectionV1Schema.optional(),
    workflowId: workflowId.optional(),
    ref: ForgeCiIdV1Schema.optional(),
    jobId: jobId.optional(),
    environmentIds: defineProtocolUniqueArray(ForgeCiIdV1Schema).optional(),
}, closed);
const receipt = defineProtocolObject({ id: ForgeCiIdV1Schema, webUrl: defineProtocolString().optional() }, closed);
export const ForgeCiMutationResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('confirmed'), affected, receipt }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('accepted'), affected, receipt: receipt.optional() }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('rejected'), failure: TriageSourceFailureV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('outcome_unknown'), affected, webUrl: defineProtocolString().optional(), failure: TriageSourceFailureV1Schema.optional() }, closed),
]);
export type ForgeCiMutationResultV1 = ReturnType<typeof ForgeCiMutationResultV1Schema.parse>;
export const ForgeCiWorkflowsListInputV1Schema = defineProtocolObject({ repository, credentialRef, cursor, validator }, closed);
export const ForgeCiWorkflowReadInputV1Schema = defineProtocolObject({ repository, credentialRef, workflowId, validator }, closed);
export const ForgeCiRunsListInputV1Schema = defineProtocolObject({ repository, credentialRef, workflowId: workflowId.optional(), filters: ForgeCiRunFiltersV1Schema, cursor, validator }, closed);
export const ForgeCiRunReadInputV1Schema = defineProtocolObject({ repository, credentialRef, runId, attempt, validator }, closed);
export const ForgeCiJobsListInputV1Schema = defineProtocolObject({ repository, credentialRef, runId, attempt, cursor, validator }, closed);
export const ForgeCiJobReadInputV1Schema = defineProtocolObject({ repository, credentialRef, jobId, validator }, closed);
export const ForgeCiJobLogReadInputV1Schema = defineProtocolObject({ repository, credentialRef, runId, attempt, jobId, selection: ForgeCiLogSelectionV1Schema, cursor, maxSerializedBytes: maxSerializedBytes.optional() }, closed);
export const ForgeCiArtifactsListInputV1Schema = defineProtocolObject({ repository, credentialRef, runId, cursor, validator }, closed);
export const ForgeCiArtifactDownloadInputV1Schema = defineProtocolObject({ repository, runId, artifactId: ForgeCiIdV1Schema, destination: FileDownloadDestinationV1ProtocolSchema }, closed);
export const ForgeCiAnnotationsListInputV1Schema = defineProtocolObject({ repository, credentialRef, runId, attempt, jobId, checkRunId: ForgeCiIdV1Schema, cursor, validator }, closed);
export const ForgeCiTriggerReadInputV1Schema = defineProtocolObject({ repository, credentialRef, workflowId, ref: ForgeCiIdV1Schema, validator }, closed);
export const ForgeCiEnvironmentsListInputV1Schema = defineProtocolObject({ repository, credentialRef, cursor, search: defineProtocolString().optional(), validator }, closed);
export const ForgeCiJobLogDownloadInputV1Schema = defineProtocolObject({ repository, runId, attempt, jobId, destination: FileDownloadDestinationV1ProtocolSchema }, closed);
export const ForgeCiWorkflowDispatchInputV1Schema = defineProtocolObject({ repository, workflowId, ref: ForgeCiIdV1Schema, inputs: ForgeCiTriggerValuesV1Schema }, closed);
export const ForgeCiWorkflowTargetInputV1Schema = defineProtocolObject({ repository, workflowId }, closed);
export const ForgeCiRunRerunInputV1Schema = defineProtocolObject({ repository, runId, attempt, enableDebugLogging: ForgeCiBooleanV1Schema.optional() }, closed);
export const ForgeCiJobRerunInputV1Schema = defineProtocolObject({ repository, runId, attempt, jobId, enableDebugLogging: ForgeCiBooleanV1Schema.optional() }, closed);
export const ForgeCiRunTargetInputV1Schema = defineProtocolObject({ repository, runId, attempt }, closed);
/** Reviewed native facts are effect operands, not caller-composed confirmation text. */
export const ForgeCiForkRunApprovalInputV1Schema = defineProtocolObject({
    repository, runId, attempt, headSha: ForgeCiIdV1Schema, contributor: ForgeCiIdV1Schema, sourceRepository: repository,
}, closed);
export const ForgeCiDeploymentsListInputV1Schema = defineProtocolObject({ repository, credentialRef, runId, validator }, closed);
export const ForgeCiDeploymentHistoryReadInputV1Schema = defineProtocolObject({ repository, credentialRef, runId, cursor, validator }, closed);
export const ForgeCiDeploymentReviewInputV1Schema = defineProtocolObject({ repository, credentialRef, runId, attempt, environmentIds: defineProtocolUniqueArray(ForgeCiIdV1Schema, { minItems: 1 }), comment: defineProtocolString() }, closed);
export const ForgeCiFailureContextReadInputV1Schema = defineProtocolObject({ repository, credentialRef, selection: ForgeCiSelectionV1Schema, jobs: defineProtocolUniqueArray(ForgeCiIdV1Schema).optional(), excerpt: ForgeCiExcerptRequestV1Schema, maxSerializedBytes }, closed);
export const ForgeCiActionInputSchemasV1 = Object.freeze({
    listWorkflows: ForgeCiWorkflowsListInputV1Schema,
    readWorkflow: ForgeCiWorkflowReadInputV1Schema,
    listRuns: ForgeCiRunsListInputV1Schema,
    readRun: ForgeCiRunReadInputV1Schema,
    listJobs: ForgeCiJobsListInputV1Schema,
    readJob: ForgeCiJobReadInputV1Schema,
    readJobLog: ForgeCiJobLogReadInputV1Schema,
    listArtifacts: ForgeCiArtifactsListInputV1Schema,
    downloadArtifact: ForgeCiArtifactDownloadInputV1Schema,
    listAnnotations: ForgeCiAnnotationsListInputV1Schema,
    readTrigger: ForgeCiTriggerReadInputV1Schema,
    listEnvironments: ForgeCiEnvironmentsListInputV1Schema,
    downloadJobLog: ForgeCiJobLogDownloadInputV1Schema,
    dispatchWorkflow: ForgeCiWorkflowDispatchInputV1Schema,
    enableWorkflow: ForgeCiWorkflowTargetInputV1Schema,
    disableWorkflow: ForgeCiWorkflowTargetInputV1Schema,
    rerunAll: ForgeCiRunRerunInputV1Schema,
    rerunFailed: ForgeCiRunRerunInputV1Schema,
    rerunJob: ForgeCiJobRerunInputV1Schema,
    cancelRun: ForgeCiRunTargetInputV1Schema,
    forceCancelRun: ForgeCiRunTargetInputV1Schema,
    approveForkRun: ForgeCiForkRunApprovalInputV1Schema,
    listDeployments: ForgeCiDeploymentsListInputV1Schema,
    readDeploymentHistory: ForgeCiDeploymentHistoryReadInputV1Schema,
    approveDeployment: ForgeCiDeploymentReviewInputV1Schema,
    rejectDeployment: ForgeCiDeploymentReviewInputV1Schema,
    readFailureContext: ForgeCiFailureContextReadInputV1Schema,
});
export const ForgeCiActionResultSchemasV1 = Object.freeze({
    listWorkflows: defineTriageConditionalReadV1(ForgeCiWorkflowPageV1Schema),
    readWorkflow: defineTriageConditionalReadV1(ForgeCiWorkflowV1Schema),
    listRuns: defineTriageConditionalReadV1(ForgeCiRunPageV1Schema),
    readRun: defineTriageConditionalReadV1(ForgeCiRunV1Schema),
    listJobs: defineTriageConditionalReadV1(ForgeCiJobPageV1Schema),
    readJob: defineTriageConditionalReadV1(ForgeCiJobV1Schema),
    readJobLog: defineTriageValueResultV1(ForgeCiLogV1Schema),
    listArtifacts: defineTriageConditionalReadV1(ForgeCiArtifactPageV1Schema),
    downloadArtifact: FileDownloadResultV1ProtocolSchema,
    listAnnotations: defineTriageConditionalReadV1(ForgeCiAnnotationPageV1Schema),
    readTrigger: defineTriageConditionalReadV1(ForgeCiTriggerDefinitionV1Schema),
    listEnvironments: defineTriageConditionalReadV1(ForgeCiEnvironmentPageV1Schema),
    downloadJobLog: FileDownloadResultV1ProtocolSchema,
    dispatchWorkflow: ForgeCiMutationResultV1Schema,
    enableWorkflow: ForgeCiMutationResultV1Schema,
    disableWorkflow: ForgeCiMutationResultV1Schema,
    rerunAll: ForgeCiMutationResultV1Schema,
    rerunFailed: ForgeCiMutationResultV1Schema,
    rerunJob: ForgeCiMutationResultV1Schema,
    cancelRun: ForgeCiMutationResultV1Schema,
    forceCancelRun: ForgeCiMutationResultV1Schema,
    approveForkRun: ForgeCiMutationResultV1Schema,
    listDeployments: defineTriageConditionalReadV1(ForgeCiDeploymentPageV1Schema),
    readDeploymentHistory: defineTriageConditionalReadV1(ForgeCiDeploymentReviewPageV1Schema),
    approveDeployment: ForgeCiMutationResultV1Schema,
    rejectDeployment: ForgeCiMutationResultV1Schema,
    readFailureContext: defineTriageValueResultV1(ForgeCiFailureSummaryV1Schema),
});
export type ForgeCiOperationIdV1 = keyof typeof ForgeCiActionInputSchemasV1;
export type ForgeCiActionInputByOperationV1 = { readonly [K in ForgeCiOperationIdV1]: ReturnType<typeof ForgeCiActionInputSchemasV1[K]['parse']> };
export type ForgeCiActionResultByOperationV1 = { readonly [K in ForgeCiOperationIdV1]: ReturnType<typeof ForgeCiActionResultSchemasV1[K]['parse']> };
export type ForgeCiWorkflowsListInputV1 = ReturnType<typeof ForgeCiWorkflowsListInputV1Schema.parse>;
export type ForgeCiWorkflowReadInputV1 = ReturnType<typeof ForgeCiWorkflowReadInputV1Schema.parse>;
export type ForgeCiRunsListInputV1 = ReturnType<typeof ForgeCiRunsListInputV1Schema.parse>;
export type ForgeCiRunReadInputV1 = ReturnType<typeof ForgeCiRunReadInputV1Schema.parse>;
export type ForgeCiJobsListInputV1 = ReturnType<typeof ForgeCiJobsListInputV1Schema.parse>;
export type ForgeCiJobReadInputV1 = ReturnType<typeof ForgeCiJobReadInputV1Schema.parse>;
export type ForgeCiJobLogReadInputV1 = ReturnType<typeof ForgeCiJobLogReadInputV1Schema.parse>;
export type ForgeCiArtifactsListInputV1 = ReturnType<typeof ForgeCiArtifactsListInputV1Schema.parse>;
export type ForgeCiArtifactDownloadInputV1 = ReturnType<typeof ForgeCiArtifactDownloadInputV1Schema.parse>;
export type ForgeCiAnnotationsListInputV1 = ReturnType<typeof ForgeCiAnnotationsListInputV1Schema.parse>;
export type ForgeCiTriggerReadInputV1 = ReturnType<typeof ForgeCiTriggerReadInputV1Schema.parse>;
export type ForgeCiEnvironmentsListInputV1 = ReturnType<typeof ForgeCiEnvironmentsListInputV1Schema.parse>;
export type ForgeCiJobLogDownloadInputV1 = ReturnType<typeof ForgeCiJobLogDownloadInputV1Schema.parse>;
export type ForgeCiWorkflowDispatchInputV1 = ReturnType<typeof ForgeCiWorkflowDispatchInputV1Schema.parse>;
export type ForgeCiWorkflowTargetInputV1 = ReturnType<typeof ForgeCiWorkflowTargetInputV1Schema.parse>;
export type ForgeCiRunRerunInputV1 = ReturnType<typeof ForgeCiRunRerunInputV1Schema.parse>;
export type ForgeCiJobRerunInputV1 = ReturnType<typeof ForgeCiJobRerunInputV1Schema.parse>;
export type ForgeCiRunTargetInputV1 = ReturnType<typeof ForgeCiRunTargetInputV1Schema.parse>;
export type ForgeCiDeploymentsListInputV1 = ReturnType<typeof ForgeCiDeploymentsListInputV1Schema.parse>;
export type ForgeCiDeploymentHistoryReadInputV1 = ReturnType<typeof ForgeCiDeploymentHistoryReadInputV1Schema.parse>;
export type ForgeCiDeploymentReviewInputV1 = ReturnType<typeof ForgeCiDeploymentReviewInputV1Schema.parse>;
export type ForgeCiFailureContextReadInputV1 = ReturnType<typeof ForgeCiFailureContextReadInputV1Schema.parse>;
