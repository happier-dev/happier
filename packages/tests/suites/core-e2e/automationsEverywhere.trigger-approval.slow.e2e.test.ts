import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { WorkflowDefinitionCreateResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';

describe('AE approved trigger publication', () => {
  let fixture: TeamSetupFFixture | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

  it('persists an approval-gated before Action trigger after Allow', async () => {
    const running = await startTeamSetupFFixture({
      testDir: await mkdtemp(join(tmpdir(), 'ae-trigger-approval-')),
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' },
    });
    fixture = running;
    const actor = await running.createAccount('trigger-author');
    const machine = await running.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    await running.assertKnownGoodMachineControl(actor, machine);
    const recipient = await running.createAccount('trigger-recipient');
    const created = await actor.executeAsPerson('workflow.definition.create', {
      definitionId: randomUUID(), metadata: { title: 'Approval-gated trigger' },
      definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'check', document: { text: 'Check the command.', references: [], attachments: [] } }] },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error(created.errorCode);
    const workflow = WorkflowDefinitionCreateResultV1Schema.parse(created.result);
    const granted = await actor.executeAsPerson('artifact.access.grants.set', { artifactId: workflow.definitionId,
      principal: { kind: 'account', accountId: readAccountIdFromToken(recipient.credentials.token) }, accessLevel: 'view' });
    expect(granted, JSON.stringify(granted)).toMatchObject({ ok: true });
    const input = {
      workflow: workflow.definitionId,
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'action' as const, phase: 'before' as const, actionIds: ['machines.command.run'],
        subject: { kind: 'machine' as const, serverId: running.serverId, machineId: machine.target.machineId },
        filter: { v: 1 as const, all: [{ op: 'eq' as const, field: '/requestId', value: 'approval-gated-trigger' }] },
        mode: 'wait' as const, onFailure: 'ask' as const, enabled: true },
    };
    let artifactId: string | undefined;
    const saved = await actor.executeWithApproval('workflow.trigger.add', input, async requestedArtifactId => {
      artifactId = requestedArtifactId;
      return actor.executeAsPerson('approval.request.decide', { artifactId: requestedArtifactId, decision: 'approve' });
    }, { actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'workflow.trigger.add': { approvalRequiredSurfaces: ['cli'] } } }) });
    expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true });
    expect(artifactId).toEqual(expect.any(String));
    const listed = await actor.executeAsPerson('workflow.trigger.list', { workflow: workflow.definitionId });
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    if (!listed.ok) throw new Error(listed.errorCode);
    const set = WorkflowTriggerListResultV1Schema.parse(listed.result).sets.find(item => item.automationId ===
      (saved.ok ? WorkflowTriggerWriteResultV1Schema.parse(saved.result).set.automationId : ''));
    expect(set?.triggers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'action', phase: 'before', actionIds: ['machines.command.run'] }),
    ]));
  }, 0);
});
