import { afterAll, beforeAll, describe, it } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { verifySessionQueryEquivalence, verifyBoundedSessionQueryContinuation } from './queryEquivalence.test-support';

describe('Session query membership and keysets (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'query-equivalence-', initAuth: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });
    it('matches the monolithic relation across relevance, publication branches and attention', verifySessionQueryEquivalence);
    it('continues past a rejected candidate window without losing exact later rows', verifyBoundedSessionQueryContinuation);
});
