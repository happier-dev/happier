import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import type { DatabaseCellV1, DatabaseFilterV1, DatabaseForeignKeyV1, SchemaOutput } from './schemaTypes.js';
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
} from './schemaTypes.js';
import * as databaseTargets from './schemas/databaseTargets.js';
export const DatabaseBuiltinEngineIdV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseBuiltinEngineIdV1'>> =
    projectZodProtocolSchema(databaseTargets.DatabaseBuiltinEngineIdV1Schema);
export const DatabaseEngineIdV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseEngineIdV1'>> =
    projectZodProtocolSchema(databaseTargets.DatabaseEngineIdV1Schema);
export const DatabaseManagedDeploymentTargetV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseManagedDeploymentTargetV1'>> =
    projectZodProtocolSchema(databaseTargets.DatabaseManagedDeploymentTargetV1Schema);
export const DatabaseManualTargetV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseManualTargetV1'>> =
    projectZodProtocolSchema(databaseTargets.DatabaseManualTargetV1Schema);
export const DatabaseTargetV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseTargetV1'>> =
    projectZodProtocolSchema(databaseTargets.DatabaseTargetV1Schema);
export const DatabaseWorktreeTargetV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseWorktreeTargetV1'>> =
    projectZodProtocolSchema(databaseTargets.DatabaseWorktreeTargetV1Schema);
export type {
    DatabaseAccessDecisionV1,
    DatabaseAccessRefusalV1,
    DatabaseAccessSummaryV1,
    DatabaseAgentAccessV1,
    DatabaseAgentLevelV1,
    DatabaseOperationClassV1,
    DatabaseRequesterKindV1,
} from './schemaTypes.js';
import * as databaseAccess from './schemas/databaseAccess.js';
export const DatabaseAccessSummaryV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseAccessSummaryV1'>> =
    projectZodProtocolSchema(databaseAccess.DatabaseAccessSummaryV1Schema);
export const DatabaseAgentAccessV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseAgentAccessV1'>> =
    projectZodProtocolSchema(databaseAccess.DatabaseAgentAccessV1Schema);
export type {
    DatabaseCompletenessV1,
    DatabaseContinuationV1,
} from './schemaTypes.js';
import * as databaseContinuations from './schemas/databaseContinuations.js';
export const DatabaseCompletenessV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseCompletenessV1'>> =
    projectZodProtocolSchema(databaseContinuations.DatabaseCompletenessV1Schema);
export const DatabaseContinuationV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseContinuationV1'>> =
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
} from './schemaTypes.js';
import * as databaseValues from './schemas/databaseValues.js';
export const DatabaseCellV1Schema: ProtocolComposableSchema<unknown, DatabaseCellV1> =
    projectZodProtocolSchema(databaseValues.DatabaseCellV1Schema);
export const DatabaseValueRangeV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseValueRangeV1'>> =
    projectZodProtocolSchema(databaseValues.DatabaseValueRangeV1Schema);
export const DatabaseValueV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseValueV1'>> =
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
} from './schemaTypes.js';
import * as databaseOperands from './schemas/databaseOperands.js';
export const DatabaseFilterV1Schema: ProtocolComposableSchema<DatabaseFilterV1> =
    projectZodProtocolSchema(databaseOperands.DatabaseFilterV1Schema);
export const DatabaseReadStatementInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseReadStatementInputV1'>, JsonObjectOutput<SchemaOutput<'databaseReadStatementInputV1'>>> =
    projectZodProtocolSchema(databaseOperands.DatabaseReadStatementInputV1Schema);
export const DatabaseRelationV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseRelationV1'>> =
    projectZodProtocolSchema(databaseOperands.DatabaseRelationV1Schema);
export const DatabaseStatementRunInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseStatementRunInputV1'>, JsonObjectOutput<SchemaOutput<'databaseStatementRunInputV1'>>> =
    projectZodProtocolSchema(databaseOperands.DatabaseStatementRunInputV1Schema);
export const DatabaseStatsOperationInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseStatsOperationInputV1'>, JsonObjectOutput<SchemaOutput<'databaseStatsOperationInputV1'>>> =
    projectZodProtocolSchema(databaseOperands.DatabaseStatsOperationInputV1Schema);
export const DatabaseWriteStatementInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseWriteStatementInputV1'>, JsonObjectOutput<SchemaOutput<'databaseWriteStatementInputV1'>>> =
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
} from './schemaTypes.js';
import * as databaseStats from './schemas/databaseStats.js';
export const DatabaseStatsCounterSampleV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseStatsCounterSampleV1'>> =
    projectZodProtocolSchema(databaseStats.DatabaseStatsCounterSampleV1Schema);
export const DatabaseStatsObservationV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseStatsObservationV1'>> =
    projectZodProtocolSchema(databaseStats.DatabaseStatsObservationV1Schema);
export const DatabaseStatsReasonV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseStatsReasonV1'>> =
    projectZodProtocolSchema(databaseStats.DatabaseStatsReasonV1Schema);
export const DatabaseStatsStatementV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseStatsStatementV1'>> =
    projectZodProtocolSchema(databaseStats.DatabaseStatsStatementV1Schema);
export const DATABASE_OPERATION_NAMES_V1 = databaseOperations.DATABASE_OPERATION_NAMES_V1;
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
} from './schemaTypes.js';
import * as databaseOperations from './schemas/databaseOperations.js';
export const DatabaseActivityCancelInputV1Schema = projectZodProtocolSchema(databaseOperations.DatabaseActivityCancelInputV1Schema);
export const DatabaseStatsEnableInputV1Schema = projectZodProtocolSchema(databaseOperations.DatabaseStatsEnableInputV1Schema);
export const DatabaseCapabilityV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseCapabilityV1'>> =
    projectZodProtocolSchema(databaseOperations.DatabaseCapabilityV1Schema);
export const DatabaseCellReadInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseCellReadInputV1'>, JsonObjectOutput<SchemaOutput<'databaseCellReadInputV1'>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseCellReadInputV1Schema);
export const DatabaseDescribeInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseDescribeInputV1'>, JsonObjectOutput<SchemaOutput<'databaseDescribeInputV1'>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseDescribeInputV1Schema);
export const DatabaseDescriptorV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseDescriptorV1'>, JsonObjectOutput<SchemaOutput<'databaseDescriptorV1'>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseDescriptorV1Schema);
export const DatabaseEditsApplyInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseEditsApplyInputV1'>, JsonObjectOutput<SchemaOutput<'databaseEditsApplyInputV1'>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseEditsApplyInputV1Schema);
export const DatabaseForeignKeyV1Schema: ProtocolComposableSchema<unknown, DatabaseForeignKeyV1> =
    projectZodProtocolSchema(databaseOperations.DatabaseForeignKeyV1Schema);
export const DatabaseFailureV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseFailureV1'>> =
    projectZodProtocolSchema(databaseOperations.DatabaseFailureV1Schema);
export const DatabaseOperationInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseOperationInputV1'>, JsonObjectOutput<SchemaOutput<'databaseOperationInputV1'>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseOperationInputV1Schema);
export const DatabaseOperationResultV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseOperationResultV1'>, JsonObjectOutput<SchemaOutput<'databaseOperationResultV1'>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseOperationResultV1Schema);
export const DatabaseRelationStructureInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseRelationStructureInputV1'>, JsonObjectOutput<SchemaOutput<'databaseRelationStructureInputV1'>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseRelationStructureInputV1Schema);
export const DatabaseRelationsListInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseRelationsListInputV1'>, JsonObjectOutput<SchemaOutput<'databaseRelationsListInputV1'>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseRelationsListInputV1Schema);
export const DatabaseRowsReadInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseRowsReadInputV1'>, JsonObjectOutput<SchemaOutput<'databaseRowsReadInputV1'>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseRowsReadInputV1Schema);
export const DatabaseRowsResultV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseRowsResultV1'>> =
    projectZodProtocolSchema(databaseOperations.DatabaseRowsResultV1Schema);
export const DatabaseSchemasListInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseSchemasListInputV1'>, JsonObjectOutput<SchemaOutput<'databaseSchemasListInputV1'>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseSchemasListInputV1Schema);
export const DatabaseStatementExplainInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseStatementExplainInputV1'>, JsonObjectOutput<SchemaOutput<'databaseStatementExplainInputV1'>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseStatementExplainInputV1Schema);
export const DatabaseStatementResultV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseStatementResultV1'>> =
    projectZodProtocolSchema(databaseOperations.DatabaseStatementResultV1Schema);
export const DatabaseTargetsConnectScopeV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseTargetsConnectScopeV1'>> =
    projectZodProtocolSchema(databaseOperations.DatabaseTargetsConnectScopeV1Schema);
export const DatabaseTargetsListInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseTargetsListInputV1'>, JsonObjectOutput<SchemaOutput<'databaseTargetsListInputV1'>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseTargetsListInputV1Schema);
export const DatabaseTargetsListResultV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseTargetsListResultV1'>, JsonObjectOutput<SchemaOutput<'databaseTargetsListResultV1'>>> =
    projectZodProtocolSchema(databaseOperations.DatabaseTargetsListResultV1Schema);
export type { DatabaseCaptureFindingDetailV1 } from './schemaTypes.js';
export const DatabaseCaptureFindingDetailV1ProtocolSchema = databaseFindings.DatabaseCaptureFindingDetailV1ProtocolSchema;
export const DATABASE_INSIGHT_SOURCES_POINT_ID_V1 = databaseFindings.DATABASE_INSIGHT_SOURCES_POINT_ID_V1;
export const DATABASE_INSIGHT_SOURCES_POINT_REF_V1 = databaseFindings.DATABASE_INSIGHT_SOURCES_POINT_REF_V1;
export const DATABASE_INSIGHT_SOURCE_PROTOCOL_ID_V1 = databaseFindings.DATABASE_INSIGHT_SOURCE_PROTOCOL_ID_V1;
export const DatabaseFindingBriefBuildResultV1ProtocolSchema = databaseFindings.DatabaseFindingBriefBuildResultV1ProtocolSchema;
export const DatabaseFindingObservationV1ProtocolSchema = databaseFindings.DatabaseFindingObservationV1ProtocolSchema;
export const DatabaseFindingReadInputV1ProtocolSchema = databaseFindings.DatabaseFindingReadInputV1ProtocolSchema;
export const DatabaseFindingReadResultV1ProtocolSchema = databaseFindings.DatabaseFindingReadResultV1ProtocolSchema;
export const DatabaseFindingSourceScopeV1ProtocolSchema = databaseFindings.DatabaseFindingSourceScopeV1ProtocolSchema;
export const DatabaseFindingsListInputV1ProtocolSchema = databaseFindings.DatabaseFindingsListInputV1ProtocolSchema;
export const DatabaseFindingsListResultV1ProtocolSchema = databaseFindings.DatabaseFindingsListResultV1ProtocolSchema;
export const DatabaseInsightBriefBuildInputV1ProtocolSchema = databaseFindings.DatabaseInsightBriefBuildInputV1ProtocolSchema;
export const DatabaseInsightSourceDescriptorV1ProtocolSchema = databaseFindings.DatabaseInsightSourceDescriptorV1ProtocolSchema;
export const DatabaseInsightSourceOperationSchemasV1 = databaseFindings.DatabaseInsightSourceOperationSchemasV1;
export const DatabaseInsightSourceReadSchemasV1 = databaseFindings.DatabaseInsightSourceReadSchemasV1;
export const DatabaseFindingDismissInputV1ProtocolSchema = databaseFindings.DatabaseFindingDismissInputV1ProtocolSchema;
export const DatabaseFindingDismissResultV1ProtocolSchema = databaseFindings.DatabaseFindingDismissResultV1ProtocolSchema;
export type {
    DatabaseFindingBaselineV1,
    DatabaseFindingBriefBuildInputV1,
    DatabaseFindingBriefBuildResultV1,
    DatabaseFindingDismissInputV1,
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
} from './schemaTypes.js';
import * as databaseFindings from './schemas/databaseFindings.js';
export const DatabaseFindingBaselineV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseFindingBaselineV1'>> =
    projectZodProtocolSchema(databaseFindings.DatabaseFindingBaselineV1Schema);
export const DatabaseFindingBriefBuildInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseFindingBriefBuildInputV1'>, JsonObjectOutput<SchemaOutput<'databaseFindingBriefBuildInputV1'>>> =
    projectZodProtocolSchema(databaseFindings.DatabaseFindingBriefBuildInputV1Schema);
export const DatabaseFindingBriefBuildResultV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseFindingBriefBuildResultV1'>> =
    projectZodProtocolSchema(databaseFindings.DatabaseFindingBriefBuildResultV1Schema);
export const DatabaseFindingReadInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseFindingReadInputV1'>, JsonObjectOutput<SchemaOutput<'databaseFindingReadInputV1'>>> =
    projectZodProtocolSchema(databaseFindings.DatabaseFindingReadInputV1Schema);
export const DatabaseFindingReadResultV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseFindingReadResultV1'>> =
    projectZodProtocolSchema(databaseFindings.DatabaseFindingReadResultV1Schema);
export const DatabaseFindingsListInputV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseFindingsListInputV1'>, JsonObjectOutput<SchemaOutput<'databaseFindingsListInputV1'>>> =
    projectZodProtocolSchema(databaseFindings.DatabaseFindingsListInputV1Schema);
export const DatabaseFindingsListResultV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseFindingsListResultV1'>> =
    projectZodProtocolSchema(databaseFindings.DatabaseFindingsListResultV1Schema);
export const DatabaseTaskEvidenceV1Schema: ProtocolComposableSchema<SchemaOutput<'databaseTaskEvidenceV1'>> =
    projectZodProtocolSchema(databaseFindings.DatabaseTaskEvidenceV1Schema);
