/** Database business schemas consume the dependency-neutral qualified Action identity owner. */
import * as ids from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import type { DatabaseOperationInputV1 } from './databaseOperations.js';

export * from '@happier-dev/protocol/actions/actionIdsDatabaseV1';

/** The one Action each P1 operation runs through; hosts and renderers never pair them by hand. */
export const DATABASE_OPERATION_ACTION_ID_V1 = {
    'describe': ids.DATABASE_DESCRIBE_ACTION_ID_V1,
    'schemas.list': ids.DATABASE_SCHEMAS_LIST_ACTION_ID_V1,
    'relations.list': ids.DATABASE_RELATIONS_LIST_ACTION_ID_V1,
    'relation.structure': ids.DATABASE_STRUCTURE_READ_ACTION_ID_V1,
    'rows.read': ids.DATABASE_ROWS_READ_ACTION_ID_V1,
    'cell.read': ids.DATABASE_CELL_READ_ACTION_ID_V1,
    'statement.run': ids.DATABASE_STATEMENT_RUN_ACTION_ID_V1,
    'statement.explain': ids.DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1,
    'edits.apply': ids.DATABASE_EDITS_APPLY_ACTION_ID_V1,
    'stats.read': ids.DATABASE_STATS_READ_ACTION_ID_V1,
} as const satisfies Record<DatabaseOperationInputV1['operation'], ids.DatabaseActionIdV1>;
