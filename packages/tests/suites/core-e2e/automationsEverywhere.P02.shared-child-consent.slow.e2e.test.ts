import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowDefinitionEditResultV1Schema,
  WorkflowRunListResultV1Schema, WorkflowRunGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { readFakeClaudeLogEvents } from '../../src/testkit/fakeClaude';
import { waitFor } from '../../src/testkit/timing';

describe('AE.P02.F8 shared child consent (BUILT-H1)', () => {
  let fixture: TeamSetupFFixture | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

  it('asks the actor again after a shared child Agent prompt changes while the root revision stays equal', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ae-p02-shared-child-'));
    const agentLogPath = join(testDir, 'actor-agent.jsonl');
    fixture = await startTeamSetupFFixture({ testDir,
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const active = fixture;
    const author = await active.createAccount('author');
    const actor = await active.createAccount('actor');
    const actorId = readAccountIdFromToken(actor.credentials.token);
    expect((await active.claimHomeOwner(author)).result.status).toBe('claimed');
    const authorMachine = await active.enrollDaemon(author,
      { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const actorMachine = await active.enrollDaemon(actor, { env: {
      HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', HAPPIER_E2E_FAKE_CLAUDE_LOG: agentLogPath,
      HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
    } });
    const session = await active.assertKnownGoodSessionControl(actor, actorMachine);
    const createdProfile = await author.executeAsPerson('actions.policy.set', { profileChange: { kind: 'create',
      profile: { name: 'Shared child review', actions: {} } } });
    expect(createdProfile.ok, JSON.stringify(createdProfile)).toBe(true);
    if (!createdProfile.ok) throw new Error(createdProfile.errorCode);
    const profile = ActionPolicyOutputSchemas['actions.policy.set'].parse(createdProfile.result);
    if (!('profileChange' in profile) || profile.profileChange.kind !== 'create') throw new Error('Missing profile');
    const profileId = profile.profileChange.id;
    expect(await author.executeAsPerson('artifact.access.grants.set', { artifactId: profileId,
      principal: { kind: 'account', accountId: actorId }, accessLevel: 'view' })).toMatchObject({ ok: true });
    const sessionRow = await fetchSessionV2(active.server.baseUrl, actor.credentials.token, session.sessionId);
    expect(await actor.executeAsPerson('session.approval_profile.set', { sessionId: session.sessionId,
      serverId: active.serverId, expectedMetadataRevision: sessionRow.metadataVersion, approvalProfileId: profileId }))
      .toMatchObject({ ok: true });

    const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } as const;
    const childCreated = await author.executeAsPerson('workflow.definition.create', { definitionId: randomUUID(),
      metadata: { title: 'Shared child' }, definition: { version: 1, defaults: { agentTarget },
        blocks: [{ kind: 'step', id: 'review', document: {
          text: 'Review the request and finish successfully.', references: [], attachments: [],
        } }] } });
    expect(childCreated.ok, JSON.stringify(childCreated)).toBe(true);
    if (!childCreated.ok) throw new Error(childCreated.errorCode);
    const child = WorkflowDefinitionCreateResultV1Schema.parse(childCreated.result);
    const rootCreated = await author.executeAsPerson('workflow.definition.create', { definitionId: randomUUID(),
      metadata: { title: 'Shared root' }, definition: { version: 1, defaults: { agentTarget },
        blocks: [{ kind: 'workflow', id: 'child', workflowRef: child.definitionId }] } });
    expect(rootCreated.ok, JSON.stringify(rootCreated)).toBe(true);
    if (!rootCreated.ok) throw new Error(rootCreated.errorCode);
    const root = WorkflowDefinitionCreateResultV1Schema.parse(rootCreated.result);
    for (const artifactId of [root.definitionId, child.definitionId]) {
      expect(await author.executeAsPerson('artifact.access.grants.set', { artifactId,
        principal: { kind: 'account', accountId: actorId }, accessLevel: 'view' })).toMatchObject({ ok: true });
    }
    const linked = await author.executeAsPerson('workflow.trigger.add', { workflow: root.definitionId,
      project: { machineId: authorMachine.target.machineId, directory: authorMachine.workspaceDir },
      trigger: { kind: 'action', phase: 'before', mode: 'wait', enabled: true,
        actionIds: ['machines.command.run'],
        subject: { kind: 'approvalProfile', serverId: active.serverId, profileId } } });
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    if (!linked.ok) throw new Error(linked.errorCode);
    const shared = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
    if (!shared.triggerId) throw new Error('Missing shared trigger');
    const readApproval = async (artifactId: string) => {
      const result = await actor.execute('approval.request.get', { artifactId });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      return ApprovalRequestGetResultV1Schema.parse(result.result).request;
    };
    const runs = async () => {
      const result = await actor.execute('workflow.run.list', { sourceArtifactId: root.definitionId, starter: 'current_account' });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      return WorkflowRunListResultV1Schema.parse(result.result).runs;
    };
    const invoke = () => actor.execute('machines.command.run', {
      command: process.platform === 'win32' ? 'echo shared-child-control' : 'printf shared-child-control',
    }, { defaultSessionId: session.sessionId, presentUserConfirmation: { actionId: 'machines.command.run' },
      externalActionTarget: { kind: 'machine', machineId: actorMachine.target.machineId,
        project: { machineId: actorMachine.target.machineId, directory: actorMachine.workspaceDir } } });
    const first = await invoke();
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) throw new Error(first.errorCode);
    const pending = ActionApprovalRequestCreatedResultSchema.parse(first.result);
    expect(await readApproval(pending.artifactId)).toMatchObject({ automaticChecks: { phase: 'consent' } });
    expect(await actor.executeAsPerson('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve',
      triggerConsent: { automationId: shared.set.automationId, triggerId: shared.triggerId, decision: 'allow' } }))
      .toMatchObject({ ok: true });
    await waitFor(async () => (await readApproval(pending.artifactId)).status === 'executed',
      { context: 'Allowed child check and original Action settle', failFast: true });
    // Unchanged child content must keep the existing consent; always re-asking is wrong too.
    const unchanged = await invoke();
    expect(unchanged.ok, JSON.stringify(unchanged)).toBe(true);
    if (!unchanged.ok) throw new Error(unchanged.errorCode);
    const checking = ActionApprovalRequestCreatedResultSchema.safeParse(unchanged.result);
    if (checking.success) {
      expect(await readApproval(checking.data.artifactId)).not.toMatchObject({ automaticChecks: { phase: 'consent' } });
      await waitFor(async () => (await readApproval(checking.data.artifactId)).status === 'executed',
        { context: 'Unchanged shared child reuses consent', failFast: true });
    } else expect(unchanged).toMatchObject({ result: { exitCode: 0 } });
    const originalRuns = await runs();
    expect(originalRuns).toHaveLength(2);
    const run = await actor.execute('workflow.run.get', { runId: originalRuns[0]!.id });
    expect(run.ok, JSON.stringify(run)).toBe(true);
    if (!run.ok) throw new Error(run.errorCode);
    expect(WorkflowRunGetResultV1Schema.parse(run.result).acceptedContext.machineId).toBe(actorMachine.target.machineId);

    const editedPrompt = `Review the changed request. SHARED_CHILD_EDIT_${randomUUID()}`;
    const edited = await author.executeAsPerson('workflow.definition.edit', { definitionId: child.definitionId,
      expectedRevision: child.revision, ops: [{ kind: 'set_step_prompt', blockId: 'review', text: editedPrompt }] });
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    if (!edited.ok) throw new Error(edited.errorCode);
    expect(WorkflowDefinitionEditResultV1Schema.parse(edited.result).revision).not.toBe(child.revision);
    expect(await author.execute('workflow.definition.get', { definitionId: root.definitionId }))
      .toMatchObject({ ok: true, result: { revision: root.revision } });
    const next = await invoke();
    expect(next.ok, JSON.stringify(next)).toBe(true);
    if (!next.ok) throw new Error(next.errorCode);
    const reask = ActionApprovalRequestCreatedResultSchema.parse(next.result);
    expect(await readApproval(reask.artifactId)).toMatchObject({ automaticChecks: { phase: 'consent', consents: [
      expect.objectContaining({ decision: 'pending', review: { reason: 'steps', changedSteps: [
        expect.objectContaining({ sourceKey: child.definitionId, blockId: 'review' }),
      ] } }),
    ] } });
    expect((await runs()).map(item => item.id)).toEqual(originalRuns.map(item => item.id));
    expect((await readFakeClaudeLogEvents(agentLogPath)).filter(event => event.type === 'sdk_stdin'
      && typeof event.userText === 'string' && event.userText.includes(editedPrompt))).toEqual([]);
    expect(await actor.executeAsPerson('approval.request.decide', { artifactId: reask.artifactId, decision: 'reject' }))
      .toMatchObject({ ok: true });
  }, 0);
});
