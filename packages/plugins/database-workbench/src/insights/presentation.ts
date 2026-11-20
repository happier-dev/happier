import type { DatabaseStatsReadV1, DatabaseStatsStatementV1 } from '@happier-dev/plugin-sdk/database';

type StatementRead = Extract<DatabaseStatsReadV1, { group: 'statements' }>;

/** Selecting a statement starts at the first page of that exact key. */
export function selectDatabaseStatement(request: StatementRead, statementKey: string): StatementRead {
    return { ...request, selection: { ...request.selection,
        page: { ...request.selection.page, offset: 0 }, statementKey } };
}

/** Selected-statement metrics use the native cumulative counters. They say
 * nothing about database-wide/OS cache use, interval continuity or index advice. */
export function projectDatabaseStatementMetrics(statement: DatabaseStatsStatementV1): Readonly<{
    meanTimeMs: number | null;
    rowsPerCall: number | null;
    bufferHitRatio: number | null;
}> {
    const calls = BigInt(statement.calls);
    const blocks = statement.blocksHit === undefined || statement.blocksRead === undefined
        ? null : BigInt(statement.blocksHit) + BigInt(statement.blocksRead);
    return {
        meanTimeMs: calls === 0n ? null : statement.totalTimeMs / Number(calls),
        rowsPerCall: calls === 0n ? null : Number(statement.rows) / Number(calls),
        bufferHitRatio: blocks === null || blocks === 0n ? null : Number(statement.blocksHit) / Number(blocks),
    };
}
