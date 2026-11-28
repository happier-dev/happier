import { expect, it } from 'vitest';
import { DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1 } from '../../../database-protocol/src/actionIdsDatabaseV1';
import { DatabaseFindingBriefBuildResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });
it('F18b G1 known-good Session and Action deliver the agent-installed browser setup as data', async () => {
    const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir: run.testDir('dbw-browser-f18b') });
    try {
        await fixture.assertKnownGoodSessionControl(fixture.owner, fixture.machine);
        const control = await fixture.executeDatabase(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1, { task: {
            kind: 'add_telemetry', sourceScope: { serverId: fixture.serverId, machineId: fixture.machine.target.machineId }, scope: fixture.scope,
        } });
        expect(control.ok).toBe(true);
        if (!control.ok) throw new Error(`F18b setup control refused (${control.errorCode})`);
        const result = DatabaseFindingBriefBuildResultV1Schema.parse(control.result);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(`F18b setup unavailable (${result.code})`);
        console.info('F18b G1 setup Action control passed', fixture.runtime);
        const evidence = JSON.parse(result.brief.evidence.items[0]!.text);
        expect(evidence.browserSetup).toMatchObject({ browser: expect.any(String), route: expect.any(String) });
    } finally { await fixture.stop(); }
}, 0);
