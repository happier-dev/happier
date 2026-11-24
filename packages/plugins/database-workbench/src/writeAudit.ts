import { normalizePostgresqlStatement } from '@happier-dev/databases/postgresql';
import { normalizeSqliteStatement } from '@happier-dev/databases/sqlite';
import type { DatabaseEngineConnectionV1, JsonValue } from '@happier-dev/plugin-sdk';
import type { DatabaseOperationInputV1, DatabaseOperationResultV1 } from '@happier-dev/plugin-sdk/database';

function statementShape(sql: string, connection: Pick<DatabaseEngineConnectionV1, 'engine' | 'normalizeStatementShape'>) {
    try {
        if (connection.normalizeStatementShape) return connection.normalizeStatementShape(sql);
        if (connection.engine === 'postgresql') return normalizePostgresqlStatement(sql).shape;
        if (connection.engine === 'sqlite') return normalizeSqliteStatement(sql).shape;
    } catch {
        // A lexical failure after commit omits the shape and keeps the committed result.
    }
    return undefined;
}

export function projectCommittedDatabaseWrite(input: DatabaseOperationInputV1, result: DatabaseOperationResultV1,
    connection: Pick<DatabaseEngineConnectionV1, 'engine' | 'normalizeStatementShape'>,
): Readonly<Record<string, JsonValue>> | undefined {
    if (!result.ok) return undefined;
    if (input.operation === 'statement.run' && input.mode === 'write' && result.operation === 'statement.run') {
        return { operation: input.operation, statements: input.statements.map(({ sql }, index) => {
            const shape = statementShape(sql, connection);
            const affectedRows = result.results[index]?.affectedRows;
            return { ...(shape ? { shape } : { omittedTextReason: 'normalization_unavailable' }),
                ...(affectedRows === undefined ? {} : { affectedRows }) };
        }) };
    }
    if (input.operation === 'edits.apply' && result.operation === 'edits.apply' && result.status === 'committed') {
        const columns = new Set<string>();
        for (const change of input.changes) {
            if ('key' in change) for (const { column } of change.key) columns.add(column);
            if ('values' in change) for (const { column } of change.values) columns.add(column);
            if ('original' in change) for (const { column } of change.original) columns.add(column);
        }
        return { operation: input.operation, relation: input.relation, columns: [...columns],
            inserted: result.inserted, updated: result.updated, deleted: result.deleted };
    }
    return undefined;
}
