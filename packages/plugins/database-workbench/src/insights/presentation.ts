import type { DatabaseStatsStatementV1 } from '@happier-dev/database-protocol';

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
