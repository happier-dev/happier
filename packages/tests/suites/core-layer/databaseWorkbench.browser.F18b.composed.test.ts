import { expect, it } from 'vitest';
import { DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1 } from '../../../database-protocol/src/actionIdsDatabaseV1';
import { DatabaseFindingBriefBuildResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { startDatabaseWorkbenchAgent, startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });
it('F18b delivers browser instrumentation setup as data to the selected Worktree Session', async () => {
    const testDir = run.testDir('dbw-browser-f18b');
    const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir });
    let agent: Awaited<ReturnType<typeof startDatabaseWorkbenchAgent>> | undefined;
    try {
        agent = await startDatabaseWorkbenchAgent(fixture, testDir);
        const input = { task: {
            kind: 'add_telemetry', sourceScope: { serverId: fixture.serverId, machineId: fixture.machine.target.machineId }, scope: fixture.scope,
        } };
        const control = await agent.execute(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1, input);
        expect(control.ok).toBe(true);
        if (!control.ok) throw new Error(`F18b setup control refused (${control.errorCode})`);
        const result = DatabaseFindingBriefBuildResultV1Schema.parse(control.result);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(`F18b setup unavailable (${result.code})`);
        console.info('F18b G1 setup Action control passed', fixture.runtime);
        const evidence = JSON.parse(result.brief.evidence.items[0]!.text);
        expect(evidence).toMatchObject({ ...input, browserSetup: { browser: expect.any(String), route: expect.any(String) } });
    } finally {
        try { await agent?.stop(); } finally { await fixture.stop(); }
    }
}, 0);
