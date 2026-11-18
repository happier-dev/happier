import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import type { ProtocolComposableSchema, ProtocolJsonValue } from '../protocol/protocolFacade.js';

// Action schemas retain the executable parser’s strict JSON output type.
type JsonObjectOutput<T> = T extends object ? T & Readonly<Record<string, ProtocolJsonValue>> : T;

export type {
    DatabaseBuiltinEngineIdV1,
    DatabaseDeploymentServiceTargetV1,
    DatabaseEngineIdV1,
    DatabaseManagedDeploymentTargetV1,
    DatabaseManualTargetV1,
    DatabaseTargetV1,
    DatabaseWorktreeSourceV1,
    DatabaseWorktreeTargetV1,
} from './schemas/databaseTargets.js';
import * as databaseTargets from './schemas/databaseTargets.js';
export const DatabaseBuiltinEngineIdV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseTargets.DatabaseBuiltinEngineIdV1Schema.parse>> =
    projectZodProtocolSchema(databaseTargets.DatabaseBuiltinEngineIdV1Schema);
export const DatabaseEngineIdV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseTargets.DatabaseEngineIdV1Schema.parse>> =
    projectZodProtocolSchema(databaseTargets.DatabaseEngineIdV1Schema);
export const DatabaseManagedDeploymentTargetV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseTargets.DatabaseManagedDeploymentTargetV1Schema.parse>> =
    projectZodProtocolSchema(databaseTargets.DatabaseManagedDeploymentTargetV1Schema);
export const DatabaseManualTargetV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseTargets.DatabaseManualTargetV1Schema.parse>> =
    projectZodProtocolSchema(databaseTargets.DatabaseManualTargetV1Schema);
export const DatabaseTargetV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseTargets.DatabaseTargetV1Schema.parse>> =
    projectZodProtocolSchema(databaseTargets.DatabaseTargetV1Schema);
export const DatabaseWorktreeTargetV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseTargets.DatabaseWorktreeTargetV1Schema.parse>> =
    projectZodProtocolSchema(databaseTargets.DatabaseWorktreeTargetV1Schema);
export type {
    DatabaseAccessDecisionV1,
    DatabaseAccessRefusalV1,
    DatabaseAccessSummaryV1,
    DatabaseAgentAccessV1,
    DatabaseAgentLevelV1,
    DatabaseOperationClassV1,
    DatabaseRequesterKindV1,
} from './schemas/databaseAccess.js';
import * as databaseAccess from './schemas/databaseAccess.js';
export const DatabaseAccessSummaryV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseAccess.DatabaseAccessSummaryV1Schema.parse>> =
    projectZodProtocolSchema(databaseAccess.DatabaseAccessSummaryV1Schema);
export const DatabaseAgentAccessV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseAccess.DatabaseAgentAccessV1Schema.parse>> =
    projectZodProtocolSchema(databaseAccess.DatabaseAgentAccessV1Schema);
export type {
    DatabaseCompletenessV1,
    DatabaseContinuationV1,
} from './schemas/databaseContinuations.js';
import * as databaseContinuations from './schemas/databaseContinuations.js';
export const DatabaseCompletenessV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseContinuations.DatabaseCompletenessV1Schema.parse>> =
    projectZodProtocolSchema(databaseContinuations.DatabaseCompletenessV1Schema);
export const DatabaseContinuationV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseContinuations.DatabaseContinuationV1Schema.parse>> =
    projectZodProtocolSchema(databaseContinuations.DatabaseContinuationV1Schema);
export type {
    DatabaseCellV1,
    DatabaseColumnV1,
    DatabaseNamedCellV1,
    DatabasePartialCellV1,
    DatabaseRowIdentityV1,
    DatabaseRowV1,
    DatabaseSemanticTypeV1,
    DatabaseValueRangeV1,
    DatabaseValueV1,
    DatabaseWriteValueV1,
} from './schemas/databaseValues.js';
import * as databaseValues from './schemas/databaseValues.js';
export const DatabaseCellV1Schema: ProtocolComposableSchema<unknown, databaseValues.DatabaseCellV1> =
    projectZodProtocolSchema(databaseValues.DatabaseCellV1Schema);
export const DatabaseValueRangeV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseValues.DatabaseValueRangeV1Schema.parse>> =
    projectZodProtocolSchema(databaseValues.DatabaseValueRangeV1Schema);
export const DatabaseValueV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseValues.DatabaseValueV1Schema.parse>> =
    projectZodProtocolSchema(databaseValues.DatabaseValueV1Schema);
export type {
    DatabaseFilterV1,
    DatabaseOrderV1,
    DatabasePageDemandV1,
    DatabaseReadStatementInputV1,
    DatabaseRelationV1,
    DatabaseRowsBindingV1,
    DatabaseRowsContinuationV1,
    DatabaseStatementRunInputV1,
    DatabaseStatementV1,
    DatabaseStatsOperationInputV1,
    DatabaseStatsReadV1,
    DatabaseWriteStatementInputV1,
} from './schemas/databaseOperands.js';
import * as databaseOperands from './schemas/databaseOperands.js';
export const DatabaseReadStatementInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperands.DatabaseReadStatementInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperands.DatabaseReadStatementInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperands.DatabaseReadStatementInputV1Schema);
export const DatabaseRelationV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperands.DatabaseRelationV1Schema.parse>> =
    projectZodProtocolSchema(databaseOperands.DatabaseRelationV1Schema);
export const DatabaseStatementRunInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperands.DatabaseStatementRunInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperands.DatabaseStatementRunInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperands.DatabaseStatementRunInputV1Schema);
export const DatabaseStatsOperationInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperands.DatabaseStatsOperationInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperands.DatabaseStatsOperationInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperands.DatabaseStatsOperationInputV1Schema);
export const DatabaseWriteStatementInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperands.DatabaseWriteStatementInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperands.DatabaseWriteStatementInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperands.DatabaseWriteStatementInputV1Schema);
export type {
    DatabaseStatsCounterComparisonV1,
    DatabaseStatsCounterSampleV1,
    DatabaseStatsGroupV1,
    DatabaseStatsIntervalBasisV1,
    DatabaseStatsObservationV1,
    DatabaseStatsReasonV1,
    DatabaseStatsSizeV1,
    DatabaseStatsStatementV1,
} from './schemas/databaseStats.js';
import * as databaseStats from './schemas/databaseStats.js';
export const DatabaseStatsCounterSampleV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseStats.DatabaseStatsCounterSampleV1Schema.parse>> =
    projectZodProtocolSchema(databaseStats.DatabaseStatsCounterSampleV1Schema);
export const DatabaseStatsObservationV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseStats.DatabaseStatsObservationV1Schema.parse>> =
    projectZodProtocolSchema(databaseStats.DatabaseStatsObservationV1Schema);
export const DatabaseStatsReasonV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseStats.DatabaseStatsReasonV1Schema.parse>> =
    projectZodProtocolSchema(databaseStats.DatabaseStatsReasonV1Schema);
export const DatabaseStatsStatementV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseStats.DatabaseStatsStatementV1Schema.parse>> =
    projectZodProtocolSchema(databaseStats.DatabaseStatsStatementV1Schema);
export { DATABASE_OPERATION_NAMES_V1 } from './schemas/databaseOperations.js';
export type {
    DatabaseCapabilityV1,
    DatabaseCellReadInputV1,
    DatabaseCellResultV1,
    DatabaseDescribeInputV1,
    DatabaseDescriptorV1,
    DatabaseEditV1,
    DatabaseEditsApplyInputV1,
    DatabaseFailureCauseV1,
    DatabaseFailureV1,
    DatabaseForeignKeyV1,
    DatabaseIncomingForeignKeyV1,
    DatabaseIndexV1,
    DatabaseOperationInputV1,
    DatabaseOperationNameV1,
    DatabaseOperationResultV1,
    DatabaseRelationStructureInputV1,
    DatabaseRelationStructureV1,
    DatabaseRelationSummaryV1,
    DatabaseRelationsListInputV1,
    DatabaseRowsReadInputV1,
    DatabaseRowsResultV1,
    DatabaseSchemasListInputV1,
    DatabaseStatementExplainInputV1,
    DatabaseStatementResultV1,
    DatabaseTargetsListInputV1,
    DatabaseTargetsListResultV1,
} from './schemas/databaseOperations.js';
import * as databaseOperations from './schemas/databaseOperations.js';
export const DatabaseCapabilityV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseCapabilityV1Schema.parse>> =
    projectZodProtocolSchema(databaseOperations.DatabaseCapabilityV1Schema);
export const DatabaseCellReadInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseCellReadInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperations.DatabaseCellReadInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseCellReadInputV1Schema);
export const DatabaseDescribeInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseDescribeInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperations.DatabaseDescribeInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseDescribeInputV1Schema);
export const DatabaseDescriptorV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseDescriptorV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperations.DatabaseDescriptorV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseDescriptorV1Schema);
export const DatabaseEditsApplyInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseEditsApplyInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperations.DatabaseEditsApplyInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseEditsApplyInputV1Schema);
export const DatabaseForeignKeyV1Schema: ProtocolComposableSchema<unknown, databaseOperations.DatabaseForeignKeyV1> =
    projectZodProtocolSchema(databaseOperations.DatabaseForeignKeyV1Schema);
export const DatabaseFailureV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseFailureV1Schema.parse>> =
    projectZodProtocolSchema(databaseOperations.DatabaseFailureV1Schema);
export const DatabaseOperationInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseOperationInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperations.DatabaseOperationInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseOperationInputV1Schema);
export const DatabaseOperationResultV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseOperationResultV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperations.DatabaseOperationResultV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseOperationResultV1Schema);
export const DatabaseRelationStructureInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseRelationStructureInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperations.DatabaseRelationStructureInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseRelationStructureInputV1Schema);
export const DatabaseRelationsListInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseRelationsListInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperations.DatabaseRelationsListInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseRelationsListInputV1Schema);
export const DatabaseRowsReadInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseRowsReadInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperations.DatabaseRowsReadInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseRowsReadInputV1Schema);
export const DatabaseRowsResultV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseRowsResultV1Schema.parse>> =
    projectZodProtocolSchema(databaseOperations.DatabaseRowsResultV1Schema);
export const DatabaseSchemasListInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseSchemasListInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperations.DatabaseSchemasListInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseSchemasListInputV1Schema);
export const DatabaseStatementExplainInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseStatementExplainInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperations.DatabaseStatementExplainInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseStatementExplainInputV1Schema);
export const DatabaseStatementResultV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseStatementResultV1Schema.parse>> =
    projectZodProtocolSchema(databaseOperations.DatabaseStatementResultV1Schema);
export const DatabaseTargetsConnectScopeV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseTargetsConnectScopeV1Schema.parse>> =
    projectZodProtocolSchema(databaseOperations.DatabaseTargetsConnectScopeV1Schema);
export const DatabaseTargetsListInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseTargetsListInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperations.DatabaseTargetsListInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseTargetsListInputV1Schema);
export const DatabaseTargetsListResultV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseOperations.DatabaseTargetsListResultV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseOperations.DatabaseTargetsListResultV1Schema.parse>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseTargetsListResultV1Schema);
export { DATABASE_INSIGHT_SOURCES_POINT_ID_V1, DATABASE_INSIGHT_SOURCES_POINT_REF_V1, DATABASE_INSIGHT_SOURCE_PROTOCOL_ID_V1, DatabaseFindingBriefBuildResultV1ProtocolSchema, DatabaseFindingObservationV1ProtocolSchema, DatabaseFindingReadInputV1ProtocolSchema, DatabaseFindingReadResultV1ProtocolSchema, DatabaseFindingSourceScopeV1ProtocolSchema, DatabaseFindingsListInputV1ProtocolSchema, DatabaseFindingsListResultV1ProtocolSchema, DatabaseInsightBriefBuildInputV1ProtocolSchema, DatabaseInsightSourceDescriptorV1ProtocolSchema } from './schemas/databaseFindings.js';
export type {
    DatabaseFindingBaselineV1,
    DatabaseFindingBriefBuildInputV1,
    DatabaseFindingBriefBuildResultV1,
    DatabaseFindingObservationV1,
    DatabaseFindingReadInputV1,
    DatabaseFindingReadResultV1,
    DatabaseFindingV1,
    DatabaseFindingsListInputV1,
    DatabaseFindingsListResultV1,
    DatabaseInsightBriefBuildInputV1,
    DatabaseInsightSourceDescriptorV1,
    DatabaseTaskBriefBuildInputV1,
    DatabaseTaskEvidenceV1,
} from './schemas/databaseFindings.js';
import * as databaseFindings from './schemas/databaseFindings.js';
export const DatabaseFindingBaselineV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseFindings.DatabaseFindingBaselineV1Schema.parse>> =
    projectZodProtocolSchema(databaseFindings.DatabaseFindingBaselineV1Schema);
export const DatabaseFindingBriefBuildInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseFindings.DatabaseFindingBriefBuildInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseFindings.DatabaseFindingBriefBuildInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseFindings.DatabaseFindingBriefBuildInputV1Schema);
export const DatabaseFindingBriefBuildResultV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseFindings.DatabaseFindingBriefBuildResultV1Schema.parse>> =
    projectZodProtocolSchema(databaseFindings.DatabaseFindingBriefBuildResultV1Schema);
export const DatabaseFindingReadInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseFindings.DatabaseFindingReadInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseFindings.DatabaseFindingReadInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseFindings.DatabaseFindingReadInputV1Schema);
export const DatabaseFindingReadResultV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseFindings.DatabaseFindingReadResultV1Schema.parse>> =
    projectZodProtocolSchema(databaseFindings.DatabaseFindingReadResultV1Schema);
export const DatabaseFindingsListInputV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseFindings.DatabaseFindingsListInputV1Schema.parse>, JsonObjectOutput<ReturnType<typeof databaseFindings.DatabaseFindingsListInputV1Schema.parse>>> =
    projectZodProtocolSchema(databaseFindings.DatabaseFindingsListInputV1Schema);
export const DatabaseFindingsListResultV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseFindings.DatabaseFindingsListResultV1Schema.parse>> =
    projectZodProtocolSchema(databaseFindings.DatabaseFindingsListResultV1Schema);
export const DatabaseTaskEvidenceV1Schema: ProtocolComposableSchema<ReturnType<typeof databaseFindings.DatabaseTaskEvidenceV1Schema.parse>> =
    projectZodProtocolSchema(databaseFindings.DatabaseTaskEvidenceV1Schema);
