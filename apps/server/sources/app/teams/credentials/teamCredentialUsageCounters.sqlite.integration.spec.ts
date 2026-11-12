import { afterAll, beforeAll, describe } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { defineTeamCredentialUsageCounterContract } from './teamCredentialUsageCounters.testkit';
describe('Team spend counters (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'team-spend-counters-' }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    defineTeamCredentialUsageCounterContract({ concurrent: false });
});
