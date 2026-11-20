import * as database from '@happier-dev/plugin-sdk/database';

/** The Workbench Action and SDK input schema for each engine operation. */
export const databaseOperationActions = {
    'describe': { id: database.DATABASE_DESCRIBE_ACTION_ID_V1, inputSchema: database.DatabaseDescribeInputV1Schema },
    'schemas.list': { id: database.DATABASE_SCHEMAS_LIST_ACTION_ID_V1, inputSchema: database.DatabaseSchemasListInputV1Schema },
    'relations.list': { id: database.DATABASE_RELATIONS_LIST_ACTION_ID_V1, inputSchema: database.DatabaseRelationsListInputV1Schema },
    'relation.structure': { id: database.DATABASE_STRUCTURE_READ_ACTION_ID_V1, inputSchema: database.DatabaseRelationStructureInputV1Schema },
    'rows.read': { id: database.DATABASE_ROWS_READ_ACTION_ID_V1, inputSchema: database.DatabaseRowsReadInputV1Schema },
    'cell.read': { id: database.DATABASE_CELL_READ_ACTION_ID_V1, inputSchema: database.DatabaseCellReadInputV1Schema },
    'statement.run': { id: database.DATABASE_STATEMENT_RUN_ACTION_ID_V1, inputSchema: database.DatabaseStatementRunInputV1Schema },
    'statement.explain': { id: database.DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1, inputSchema: database.DatabaseStatementExplainInputV1Schema },
    'edits.apply': { id: database.DATABASE_EDITS_APPLY_ACTION_ID_V1, inputSchema: database.DatabaseEditsApplyInputV1Schema },
    'stats.read': { id: database.DATABASE_STATS_READ_ACTION_ID_V1, inputSchema: database.DatabaseStatsOperationInputV1Schema },
} as const satisfies Record<database.DatabaseOperationInputV1['operation'], {
    id: database.DatabaseActionIdV1;
    inputSchema: unknown;
}>;
