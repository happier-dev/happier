import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AutomationActionTriggerSchema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { WorkflowTriggerListResultV1Schema, WorkflowTriggerRemoveResultV1Schema,
  WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';

describe('AE.P04.F4 Action attachment authoring', () => {
  let fixture: TeamSetupFFixture | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

  // This exercises the mounted UI person's Action bridge and Account writer/read owner.
  // The rendered sentence controls and selected-subject section remain the composed UI gate.
  it('keeps specific/any subject and before/after policy through attach, read, disable, edit and remove', async () => {
    fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'ae-p04-f4-')),
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const actor = await fixture.createAccount('attachment-author');
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const session = await fixture.assertKnownGoodSessionControl(actor, machine);
    const context = { defaultSessionId: session.sessionId, surface: 'mcp', authority: 'account_automation' } as const;
    const command = await actor.execute('action.spec.get', { id: 'machines.command.run' }, context);
    expect(command).toMatchObject({ ok: true, result: { actionSpec: {
      automation: { before: true, after: true, workflowStep: true },
    } } });
    const foundCommand = await actor.execute('action.spec.search', { query: 'machines.command.run' }, context);
    expect(foundCommand).toMatchObject({ ok: true, result: { actionSpecs: expect.arrayContaining([
      expect.objectContaining({ id: 'machines.command.run', automation: expect.objectContaining({ before: true, after: true, workflowStep: true }) }),
    ]) } });
    for (const [id, automation] of [
      ['workflow.run.summaries', { before: false, after: false, workflowStep: true }],
      ['ui.current_context.read', { before: false, after: false, workflowStep: false }],
      [DEPLOYMENT_DEPLOY_ACTION_ID_V1, { after: false }],
    ] as const) {
      expect(await actor.execute('action.spec.get', { id }, context))
        .toMatchObject({ ok: true, result: { actionSpec: { automation } } });
    }
    const subject = { kind: 'machine', serverId: fixture.serverId, machineId: machine.target.machineId } as const;
    for (const definition of [
      { phase: 'before', mode: 'wait', onFailure: 'ask', subject },
      { phase: 'before', mode: 'wait', onFailure: 'refuse' },
      { phase: 'before', mode: 'notify', subject },
      { phase: 'after' },
    ]) {
      const trigger = AutomationActionTriggerSchema.parse({ kind: 'action',
        actionIds: ['machines.command.run'], ...definition });
      const added = await actor.executeAsPerson('workflow.trigger.add', {
        target: { kind: 'inline', definition: { version: 1,
          defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
          blocks: [{ kind: 'step', id: 'check', document: { text: 'Check the deployment.', references: [], attachments: [] },
            input: [], result: { kind: 'text' } }],
        } },
        project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
        trigger: { ...trigger, enabled: true },
      });
      expect(added.ok, JSON.stringify(added)).toBe(true);
      if (!added.ok) throw new Error(`UI attachment refused (${added.errorCode})`);
      const saved = WorkflowTriggerWriteResultV1Schema.parse(added.result);
      expect(saved.set.triggers).toContainEqual(expect.objectContaining(trigger));
      const listed = await actor.executeAsPerson('workflow.trigger.list', {
        automationId: saved.set.automationId,
      });
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      if (!listed.ok) throw new Error(`UI attachment read refused (${listed.errorCode})`);
      const read = WorkflowTriggerListResultV1Schema.parse(listed.result).sets.find(set => set.automationId === saved.set.automationId);
      expect(read?.triggers).toContainEqual(expect.objectContaining(trigger));

      const editedTrigger = AutomationActionTriggerSchema.parse({ kind: 'action', phase: 'after',
        actionIds: trigger.actionIds, ...(trigger.subject ? { subject: trigger.subject } : {}) });
      const updated = await actor.executeAsPerson('workflow.trigger.update', {
        automationId: saved.set.automationId, triggerId: saved.triggerId,
        expectedRevision: saved.set.revision, patch: { enabled: false, trigger: editedTrigger },
      });
      expect(updated.ok, JSON.stringify(updated)).toBe(true);
      if (!updated.ok) throw new Error(`UI attachment edit refused (${updated.errorCode})`);
      const edited = WorkflowTriggerWriteResultV1Schema.parse(updated.result);
      expect(edited.set.triggers).toContainEqual(expect.objectContaining({ ...editedTrigger, enabled: false }));
      const removed = await actor.executeAsPerson('workflow.trigger.remove', {
        automationId: edited.set.automationId, triggerId: saved.triggerId,
      });
      expect(removed.ok, JSON.stringify(removed)).toBe(true);
      if (!removed.ok) throw new Error(`UI attachment removal refused (${removed.errorCode})`);
      expect(WorkflowTriggerRemoveResultV1Schema.parse(removed.result)).toMatchObject({
        set: { automationId: saved.set.automationId, triggers: [] },
        triggerId: saved.triggerId,
      });
    }
  }, 0);
});
