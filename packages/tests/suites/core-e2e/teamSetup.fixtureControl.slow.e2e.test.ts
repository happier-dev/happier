import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedFakeClaudeControlShim, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { readDaemonState } from '../../src/testkit/daemon/daemon';
import { repoRootDir } from '../../src/testkit/paths';

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

  it('runs a selected ACP Agent turn and uses its non-native Goal continuation controls', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'team-setup-acp-control-'));
    fixture = await startTeamSetupFFixture({ testDir,
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' },
      dbProvider: process.env.HAPPIER_E2E_DB_PROVIDER === 'postgres' ? 'postgres' : 'sqlite' });
    const account = await fixture.createAccount('member');
    const machine = await fixture.enrollDaemon(account, { env: {
      HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      HAPPIER_OHMYPI_PATH: resolve(repoRootDir(), 'packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs'),
      PI_CODING_AGENT_DIR: join(testDir, 'ohmypi'),
      GEMINI_API_KEY: 'e2e-fake-gemini-api-key',
    } });
    const control = await fixture.assertKnownGoodSessionControl(account, machine, {
      target: { kind: 'agent', identity: { pluginId: 'happier.agent.ohmypi', localId: 'ohmypi' } },
      prompt: 'ACP_STUB_USAGE_UPDATE=fixture-control',
      assistantSubstring: 'ACP_STUB_USAGE_UPDATE_DONE fixture-control',
    });
    expect(control.metadata.machineId).toBe(machine.target.machineId);
    // The public write resolves the opened runtime's Goal capability before
    // accepting Keep going. A native Goal owner must refuse this same request.
    expect(await account.executeAsPerson('workflow.trigger.add', {
      lifetimeSession: { sessionId: control.sessionId },
      target: { kind: 'workflow', ref: 'builtin:keep-going' },
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'sessionLifecycle', enabled: true,
        subject: { kind: 'session', serverId: fixture.serverId, sessionId: control.sessionId },
        events: ['parentTurnCompleted'], policy: { kind: 'everyMatch' } },
    }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
      presentUserConfirmation: { actionId: 'workflow.trigger.add' } })).toMatchObject({ ok: true });
    expect(await account.execute('session.goal.clear', { sessionId: control.sessionId },
      { presentUserConfirmation: { actionId: 'session.goal.clear' } })).toMatchObject({ ok: true });
  }, 0);
});
