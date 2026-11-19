import * as ids from './actionIdsDatabaseV1.js';
import {
    DatabaseDescribeInputV1Schema,
    DatabaseSchemasListInputV1Schema,
    DatabaseRelationsListInputV1Schema,
    DatabaseRelationStructureInputV1Schema,
    DatabaseRowsReadInputV1Schema,
    DatabaseCellReadInputV1Schema,
    DatabaseStatementRunInputV1Schema,
    DatabaseStatementExplainInputV1Schema,
    DatabaseEditsApplyInputV1Schema,
    DatabaseStatsOperationInputV1Schema,
} from '@happier-dev/plugin-sdk/database';

/** Only operations with a current P1 schema can be declared by the plugin. */
export const DATABASE_OPERATION_ACTION_INPUT_SCHEMAS_V1 = {
    [ids.DATABASE_DESCRIBE_ACTION_ID_V1]: DatabaseDescribeInputV1Schema,
    [ids.DATABASE_SCHEMAS_LIST_ACTION_ID_V1]: DatabaseSchemasListInputV1Schema,
    [ids.DATABASE_RELATIONS_LIST_ACTION_ID_V1]: DatabaseRelationsListInputV1Schema,
    [ids.DATABASE_STRUCTURE_READ_ACTION_ID_V1]: DatabaseRelationStructureInputV1Schema,
    [ids.DATABASE_ROWS_READ_ACTION_ID_V1]: DatabaseRowsReadInputV1Schema,
    [ids.DATABASE_CELL_READ_ACTION_ID_V1]: DatabaseCellReadInputV1Schema,
    [ids.DATABASE_STATEMENT_RUN_ACTION_ID_V1]: DatabaseStatementRunInputV1Schema,
    [ids.DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1]: DatabaseStatementExplainInputV1Schema,
    [ids.DATABASE_EDITS_APPLY_ACTION_ID_V1]: DatabaseEditsApplyInputV1Schema,
    [ids.DATABASE_STATS_READ_ACTION_ID_V1]: DatabaseStatsOperationInputV1Schema,
} as const;
