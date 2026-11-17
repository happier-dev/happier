import { expect, it } from 'vitest';
import { DatabaseStatsStatementV1Schema } from '@happier-dev/database-protocol';
import { projectDatabaseStatementMetrics } from './presentation.js';

it('keeps unobserved buffer activity unknown and computes the selected statement ratio from native counters', () => {
    const row = DatabaseStatsStatementV1Schema.parse({ key: 'statement', database: 'app', calls: '4', totalTimeMs: 20,
        rows: '8', nativeTimeUnit: 'milliseconds', blocksHit: '9007199254740993', blocksRead: '3002399751580331' });
    const projected = projectDatabaseStatementMetrics(row);
    expect(projected).toMatchObject({ meanTimeMs: 5, rowsPerCall: 2 });
    expect(projected.bufferHitRatio).toBeCloseTo(0.75);
    expect(projectDatabaseStatementMetrics({ ...row, blocksHit: '0', blocksRead: '0', calls: '0' }))
        .toEqual({ meanTimeMs: null, rowsPerCall: null, bufferHitRatio: null });
    expect(projectDatabaseStatementMetrics({ ...row, blocksRead: undefined }).bufferHitRatio).toBeNull();
    expect(projectDatabaseStatementMetrics({ ...row, blocksHit: '0', blocksRead: '4' }).bufferHitRatio).toBe(0);
});
