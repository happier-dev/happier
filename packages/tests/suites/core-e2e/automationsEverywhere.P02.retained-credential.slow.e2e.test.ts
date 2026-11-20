import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { readActionAutomationIndexUpdateV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { buildTestAccountCliAuthCredentials } from '../../src/testkit/cliAuth';
import { createTestTerminalAuth } from '../../src/testkit/auth';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';
import { createCliActionExecutorFromCredentials } from '../../../../apps/cli/src/session/actions/createCliActionExecutorFromCredentials';
import { decodeStoredCredentials } from '../../../../apps/cli/src/persistence';
import { applyCliActionAutomationUpdateV1 } from '../../../../apps/cli/src/api/actionAutomations';

describe('AE.P02 retained CLI credential', () => {
  let fixture: Awaited<ReturnType<typeof startProjectDaemonFixture>> | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

  it('keeps a retained CLI executor on the pushed Account index when a second real terminal credential binds', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ae-p02-retained-before-'));
    fixture = await startProjectDaemonFixture({ testDir,
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const actor = await fixture.createAccount('actor');
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const retained = createCliActionExecutorFromCredentials({ credentials: actor.credentials,
      serverId: fixture.serverId, serverIdentityId: fixture.serverId, serverApiUrl: fixture.actionServerApiUrl,
      machineId: machine.target.machineId });
    const invoke = (name: string) => retained.execute('account.name.set', { name }, {
      surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: randomUUID(),
      serverId: fixture!.serverId, serverIdentityId: fixture!.serverId, defaultSessionMachineId: machine.target.machineId });
    const readApproval = async (artifactId: string) => {
      const result = await actor.execute('approval.request.get', { artifactId });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      return ApprovalRequestGetResultV1Schema.parse(result.result).request;
    };
    const control = await invoke('Retained control');
    expect(control.ok, JSON.stringify(control)).toBe(true);
    if (!control.ok) throw new Error(control.errorCode);
    const baseline = ActionApprovalRequestCreatedResultSchema.parse(control.result);
    expect(await actor.executeAsPerson('approval.request.decide', { artifactId: baseline.artifactId, decision: 'approve' }))
      .toMatchObject({ ok: true });
    await waitFor(async () => (await readApproval(baseline.artifactId)).status === 'executed',
      { failFast: true, context: 'Retained CLI executor warms its empty index through a successful Account effect' });

    const secondAuth = await createTestTerminalAuth(fixture.server.baseUrl, actor.auth);
    expect(secondAuth.token).not.toBe(actor.credentials.token);
    const credentials = decodeStoredCredentials(buildTestAccountCliAuthCredentials({ auth: secondAuth, mode: 'dataKey' }));
    if (!credentials) throw new Error('Second terminal credentials unavailable');
    const second = createCliActionExecutorFromCredentials({ credentials, serverId: fixture.serverId,
      serverIdentityId: fixture.serverId, serverApiUrl: fixture.actionServerApiUrl });
    expect(await second.execute('account.profile.get', {}, { surface: 'cli', authority: 'present_user',
      actionCaller: { kind: 'host' }, actionRequestId: randomUUID() })).toMatchObject({ ok: true });
    const socket = createUserScopedSocketCollector(fixture.server.baseUrl, credentials.token);
    socket.connect();
    try {
      await waitFor(() => socket.isConnected(), { context: 'Second authenticated terminal receives Account updates' });
      const linked = await actor.executeAsPerson('workflow.trigger.add', {
        actionApproval: 'automatic', project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
        target: { kind: 'inline', definition: { version: 1, inputs: [], blocks: [
          { kind: 'action', id: 'check', actionId: 'machines.command.run', input: {
            command: { kind: 'literal', value: process.platform === 'win32'
              ? 'powershell -NoProfile -Command "[IO.File]::WriteAllText(\'retained-check.txt\', \'check\'); exit 7"'
              : 'printf check > retained-check.txt; exit 7' },
          } },
        ] } }, trigger: { kind: 'action', phase: 'before', mode: 'wait', onFailure: 'refuse',
          enabled: true, actionIds: ['account.name.set'] },
      });
      expect(linked.ok, JSON.stringify(linked)).toBe(true);
      if (!linked.ok) throw new Error(linked.errorCode);
      const saved = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
      let pushed: unknown;
      await waitFor(() => {
        pushed = socket.getEvents().find(event => event.kind === 'update'
          && event.payload.body?.t === 'automation-upsert'
          && event.payload.body.automationId === saved.set.automationId
          && event.payload.body.actionIndex !== undefined);
        return pushed !== undefined;
      }, { context: 'Home publishes the newly saved Action index row to the second terminal' });
      const update = socket.getEvents().find(event => event === pushed);
      if (!update || update.kind !== 'update') throw new Error('Action index update unavailable');
      expect(readActionAutomationIndexUpdateV1(update.payload.body)).toMatchObject({ automationId: saved.set.automationId,
        rows: [expect.objectContaining({ triggerId: saved.triggerId, phase: 'before' })] });
      // Deliver the real socket payload through the same adapter consumed by ApiMachine.
      applyCliActionAutomationUpdateV1({ token: credentials.token, serverHttpBaseUrl: fixture.actionServerApiUrl,
        body: update.payload.body });
      const original = await invoke('Must be refused');
      expect(original.ok, JSON.stringify(original)).toBe(true);
      if (!original.ok) throw new Error(original.errorCode);
      const pending = ActionApprovalRequestCreatedResultSchema.parse(original.result);
      expect((await readApproval(pending.artifactId)).automaticChecks).toMatchObject({
        selected: [expect.objectContaining({ automationId: saved.set.automationId, triggerId: saved.triggerId })], runs: [],
      });
      expect(await actor.executeAsPerson('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve' }))
        .toMatchObject({ ok: true });
      await waitFor(async () => (await readApproval(pending.artifactId)).status === 'failed',
        { failFast: true, context: 'Retained CLI before check reaches a terminal daemon Run before the Account effect' });
      expect(await readApproval(pending.artifactId)).toMatchObject({ execution: { ok: false,
        errorCode: 'action_interception_rejected' }, automaticChecks: { phase: 'refused',
        runs: [expect.any(Object)], results: [expect.objectContaining({ outcome: 'failed' })] } });
      expect(await readFile(join(machine.workspaceDir, 'retained-check.txt'), 'utf8')).toBe('check');
      expect(await actor.executeAsPerson('account.profile.get', {})).toMatchObject({ ok: true,
        result: { name: 'Retained control' } });
    } finally { socket.close(); }
  }, 0);

});
