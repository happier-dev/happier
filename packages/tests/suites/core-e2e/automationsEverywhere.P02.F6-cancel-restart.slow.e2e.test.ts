import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { isTerminalAutomationRunStateV3 } from '@happier-dev/protocol/automations/automationRunStateV3';
import { startAutomaticCheckFixture, hasAutomaticCheckPhase } from '../../src/testkit/automationPending';
import { waitFor } from '../../src/testkit/timing';
import { createCliActionExecutorFromCredentials } from '../../../../apps/cli/src/session/actions/createCliActionExecutorFromCredentials';

describe('AE.P02.F6-cancel-restart', () => {
  let fixture: Awaited<ReturnType<typeof startAutomaticCheckFixture>> | undefined;
  afterEach(async () => { await fixture?.release(); await fixture?.stop(); fixture = undefined; }, 0);
  it('rejoins recorded checking after daemon and requester restart without a replacement Run', async () => {
    fixture = await startAutomaticCheckFixture('wait');
    const pending = await fixture.invokePending();
    await waitFor(async () => hasAutomaticCheckPhase(await fixture!.approval(pending.artifactId), 'checking'),
      { context: 'Persisted check before replacing the Account executor' });
    const runs = await fixture.runs();
    expect(runs).toHaveLength(1);
    const runId = runs[0]!.id;
    pending.detach();
    await pending.invocation;
    await fixture.machine.daemon.stop();
    await fixture.enrollDaemon(fixture.actor, { pairedHome: { homeDir: fixture.machine.homeDir,
      serverId: fixture.machine.cliServerId, machineId: fixture.machine.target.machineId },
      env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const restarted = createCliActionExecutorFromCredentials({ credentials: fixture.actor.credentials,
      readCredentials: async () => fixture!.actor.credentials,
      serverId: fixture.serverId, serverIdentityId: fixture.serverId, serverApiUrl: fixture.actionServerApiUrl });
    const resumed = restarted.execute('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve' },
      { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: randomUUID(),
        serverId: fixture.serverId, serverIdentityId: fixture.serverId });
    await fixture.release();
    expect(await resumed).toMatchObject({ ok: true });
    await waitFor(async () => (await fixture!.approval(pending.artifactId)).status === 'executed',
      { context: 'Rejoined checking continuation settles the effect' });
    expect(await fixture.approval(pending.artifactId)).toMatchObject({ automaticChecks: {
      runs: [expect.objectContaining({ runId })],
    } });
    expect(await fixture.runs()).toHaveLength(1);
  }, 0);
  it('preserves canceled pending custody and its Run ids over daemon restart and a late check result', async () => {
    fixture = await startAutomaticCheckFixture('wait');
    const pending = await fixture.invokePending();
    await waitFor(async () => hasAutomaticCheckPhase(await fixture!.approval(pending.artifactId), 'checking'),
      { context: 'Recorded checking approval' });
    const runs = await fixture.runs();
    expect(runs).toHaveLength(1);
    const runId = runs[0]!.id;
    expect(await fixture.actor.execute('approval.request.decide', { artifactId: pending.artifactId, decision: 'cancel' }))
      .toMatchObject({ ok: true });
    await pending.invocation;
    expect(await fixture.approval(pending.artifactId)).toMatchObject({ status: 'canceled', automaticChecks: {
      runs: [expect.objectContaining({ runId })],
    } });
    await fixture.machine.daemon.stop();
    await fixture.enrollDaemon(fixture.actor, { pairedHome: { homeDir: fixture.machine.homeDir,
      serverId: fixture.machine.cliServerId, machineId: fixture.machine.target.machineId },
      env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    await fixture.release();
    await waitFor(async () => (await fixture!.runs()).every(run => isTerminalAutomationRunStateV3(run.state)),
      { context: 'Stopped check settlement after restart' });
    expect(await fixture.approval(pending.artifactId)).toMatchObject({ status: 'canceled', automaticChecks: {
      runs: [expect.objectContaining({ runId })],
    } });
    expect(await fixture.runs()).toHaveLength(1);
    await expect(access(fixture.effectPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 0);
});
