import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { readBuiltinWidgetDescriptorV1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
import { proposeWidgetInputDefaultBindingsV1 } from '@happier-dev/protocol/widgets/widgetInputAdmissionV1';
import { readUsagePageWidgetFollowBindingsV1 } from '@happier-dev/protocol/widgets/usageWidgetPresetsV1';
import { createRunDirs } from '../../src/testkit/runDir';
import { startTeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { settleReviewedSessionMcpAction, startSessionMcpAgent } from '../../src/testkit/sessionMcpAgent';

const run = createRunDirs({ runLabel: 'core' });

it('adds a reviewed Usage widget from a Session and refuses the same action when agent access is off', async () => {
  const testDir = run.testDir('usage-widget-r220');
  const fixture = await startTeamSetupFFixture({ testDir, dbProvider: 'sqlite' });
  let session: Awaited<ReturnType<typeof startSessionMcpAgent>> | undefined;
  try {
    const account = await fixture.createAccount('usage-widget');
    const accountId = readAccountIdFromToken(account.credentials.token);
    if (!accountId) throw new Error('Account ID missing');
    const machine = await fixture.enrollDaemon(account);
    session = await startSessionMcpAgent({ testDir, directory: machine.workspaceDir,
      daemonState: machine.daemon.state, executeAsPerson: account.executeAsPerson });
    const surface = { serverId: fixture.serverId, accountId,
      owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } } as const;
    const definition = { kind: 'builtin', id: 'usage_flow' } as const;
    const descriptor = readBuiltinWidgetDescriptorV1(definition);
    if (!descriptor) throw new Error('Usage Flow descriptor missing');
    const instance = { v: 1 as const, id: randomUUID(), definition,
      bindings: { ...proposeWidgetInputDefaultBindingsV1(descriptor), ...readUsagePageWidgetFollowBindingsV1(descriptor) } };
    const pending = await session.execute('widgets.item.add', { surface, instance });
    expect(pending).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    const added = await settleReviewedSessionMcpAction(pending, { serverId: fixture.serverId,
      serverHttpBaseUrl: fixture.actionServerApiUrl, token: account.credentials.token, execute: account.execute,
      decide: artifactId => account.executeAsPerson('approval.request.decide', { artifactId, decision: 'approve' }) });
    expect(added).toMatchObject({ ok: true, result: { ref: { surface, instanceId: instance.id }, instance } });
    const list = async () => account.executeAsPerson('widgets.item.list', { surface });
    expect(await list()).toMatchObject({ ok: true, result: { instances: expect.arrayContaining([
      expect.objectContaining({ instance: expect.objectContaining({ id: instance.id, definition }) }),
    ]) } });
    expect(await account.executeAsPerson('actions.policy.set', { actionId: 'widgets.item.add', audience: 'agent', mode: 'off' }))
      .toMatchObject({ ok: true });
    const refusedId = randomUUID();
    expect(await session.execute('widgets.item.add', { surface, instance: { ...instance, id: refusedId } }))
      .toMatchObject({ ok: false, errorCode: 'action_disabled' });
    const after = await list();
    expect(after).toMatchObject({ ok: true });
    if (!after.ok) throw new Error('Usage surface read refused');
    expect(JSON.stringify(after.result)).not.toContain(refusedId);
  } finally {
    try { await session?.stop(); } finally { await fixture.stop(); }
  }
}, 0);
