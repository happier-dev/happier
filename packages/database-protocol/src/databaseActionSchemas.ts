import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import * as ids from './actionIdsDatabaseV1.js';
import {
    DatabaseTargetsListInputV1Schema, DatabaseTargetsListResultV1Schema,
    DatabaseDescribeInputV1Schema, DatabaseSchemasListInputV1Schema,
    DatabaseRelationsListInputV1Schema, DatabaseRelationStructureInputV1Schema,
    DatabaseRowsReadInputV1Schema, DatabaseCellReadInputV1Schema,
    DatabaseStatementRunInputV1Schema, DatabaseStatementExplainInputV1Schema,
    DatabaseEditsApplyInputV1Schema, DatabaseStatsOperationInputV1Schema,
    DatabaseOperationResultV1Schema,
} from './databaseOperations.js';

/** Neutral SDK projections retain the business owner's executable parsers. */
export const DatabaseTargetsListInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseTargetsListInputV1Schema);
export const DatabaseTargetsListResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseTargetsListResultV1Schema);
export const DatabaseOperationResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseOperationResultV1Schema);

/** Only operations with a current P1 schema can be declared by the plugin. */
export const DATABASE_OPERATION_ACTION_INPUT_SCHEMAS_V1 = {
    [ids.DATABASE_DESCRIBE_ACTION_ID_V1]: projectZodProtocolSchema(DatabaseDescribeInputV1Schema),
    [ids.DATABASE_SCHEMAS_LIST_ACTION_ID_V1]: projectZodProtocolSchema(DatabaseSchemasListInputV1Schema),
    [ids.DATABASE_RELATIONS_LIST_ACTION_ID_V1]: projectZodProtocolSchema(DatabaseRelationsListInputV1Schema),
    [ids.DATABASE_STRUCTURE_READ_ACTION_ID_V1]: projectZodProtocolSchema(DatabaseRelationStructureInputV1Schema),
    [ids.DATABASE_ROWS_READ_ACTION_ID_V1]: projectZodProtocolSchema(DatabaseRowsReadInputV1Schema),
    [ids.DATABASE_CELL_READ_ACTION_ID_V1]: projectZodProtocolSchema(DatabaseCellReadInputV1Schema),
    [ids.DATABASE_STATEMENT_RUN_ACTION_ID_V1]: projectZodProtocolSchema(DatabaseStatementRunInputV1Schema),
    [ids.DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1]: projectZodProtocolSchema(DatabaseStatementExplainInputV1Schema),
    [ids.DATABASE_EDITS_APPLY_ACTION_ID_V1]: projectZodProtocolSchema(DatabaseEditsApplyInputV1Schema),
    [ids.DATABASE_STATS_READ_ACTION_ID_V1]: projectZodProtocolSchema(DatabaseStatsOperationInputV1Schema),
} as const;
