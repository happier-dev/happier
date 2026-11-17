import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedFakeClaudeControlShim, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { readDaemonState } from '../../src/testkit/daemon/daemon';

describe('Team setup shared fixture control', () => {
  let fixture: TeamSetupFFixture | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

  it('enrolls the acting Account Machine and delivers a control prompt to its Agent', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'team-setup-fixture-control-'));
    const agent = await createIsolatedFakeClaudeControlShim({ testDir, invocationId: 'fixture-control',
      captureEnvironmentKeys: [], logFullStdin: true });
    fixture = await startTeamSetupFFixture({ testDir, observeActionRequests: true,
      dbProvider: process.env.HAPPIER_E2E_DB_PROVIDER === 'postgres' ? 'postgres' : 'sqlite' });
    const account = await fixture.createAccount('member');
    const machine = await fixture.enrollDaemon(account, { env: { HAPPIER_CLAUDE_PATH: agent.executablePath } });
    expect((await readDaemonState(machine.homeDir))?.machineControlReady).toBe(true);
    await fixture.assertKnownGoodMachineControl(account, machine);
    await machine.restart();
    expect((await readDaemonState(machine.homeDir))?.machineControlReady).toBe(true);
    await fixture.assertKnownGoodMachineControl(account, machine);
    const control = await fixture.assertKnownGoodSessionControl(account, machine);
    expect(control.metadata.machineId).toBe(machine.target.machineId);
    const prompt = 'Confirm the shared fixture reaches its enrolled Agent.';
    expect(await account.execute('session.message.send', { sessionId: control.sessionId, message: prompt }))
      .toMatchObject({ ok: true });
    expect(await waitForFakeClaudeUserText(agent.logPath, text => text.includes(prompt),
      { invocationId: 'fixture-control' })).toContain(prompt);
  }, 0);
});
