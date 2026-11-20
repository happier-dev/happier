import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowRunGetResultV1Schema,
  WorkflowRunListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { waitFor } from '../../src/testkit/timing';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { createIsolatedFakeClaudeControlShim } from '../../src/testkit/fakeClaude';

// The Team/profile consent, step-change and agent-decision matrix is shared with
// P02.F8. This distinct path exercises Plan01's direct-share discovery and its
// skipped summary, through the same real server, daemon and public Action owners.
describe('AE.P03.F9-profile-subject direct recipients', () => {
  let fixture: TeamSetupFFixture | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

  it('requires direct-recipient consent on their Machine and reports a linked Workflow they cannot open as skipped', async () => {
    fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'ae-p03-f9-direct-')),
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const author = await fixture.createAccount('author');
    const actor = await fixture.createAccount('direct-recipient');
    const withoutWorkflow = await fixture.createAccount('profile-only-recipient');
    await fixture.claimHomeOwner(author);
    // Direct grants require an eligible relationship; Team membership supplies
    // that relationship without granting the Team either shared Artifact.
    const team = await author.executeAsPerson('teams.create', { v: 1,
      initialOwnerAccountId: readAccountIdFromToken(author.credentials.token),
      name: 'Direct grant recipients', requestKey: randomUUID(),
    }, { presentUserConfirmation: { actionId: 'teams.create' } });
    expect(team.ok, JSON.stringify(team)).toBe(true);
    if (!team.ok) throw new Error(team.errorCode);
    const teamId = TeamSummaryV1Schema.parse(team.result).id;
    for (const recipient of [actor, withoutWorkflow]) {
      const added = await author.executeAsPerson('teams.members.add', { v: 1, teamId,
        accountId: readAccountIdFromToken(recipient.credentials.token), role: 'member', historyAccess: 'from_membership',
      }, { presentUserConfirmation: { actionId: 'teams.members.add' } });
      expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
    }
    const authorMachine = await fixture.enrollDaemon(author, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const agent = await createIsolatedFakeClaudeControlShim({
      testDir: await mkdtemp(join(tmpdir(), 'ae-p03-direct-recipient-agent-')),
      invocationId: 'profile-direct-recipient', captureEnvironmentKeys: [], logFullStdin: false,
    });
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      HAPPIER_CLAUDE_PATH: agent.executablePath } });
    const missingAgent = await createIsolatedFakeClaudeControlShim({
      testDir: await mkdtemp(join(tmpdir(), 'ae-p03-profile-only-recipient-agent-')),
      invocationId: 'profile-only-recipient', captureEnvironmentKeys: [], logFullStdin: false,
    });
    const missingMachine = await fixture.enrollDaemon(withoutWorkflow, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      HAPPIER_CLAUDE_PATH: missingAgent.executablePath } });
    const made = await author.executeAsPerson('actions.policy.set', { profileChange: { kind: 'create', profile: {
      name: 'Direct profile checks', actions: {},
      // The command is allowed by this profile; linked Workflow consent is
      // still required before its author's check runs on a recipient's Machine.
      approvalWaivedSurfaces: { 'machines.command.run': ['agent', 'mcp'] },
    } } });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    if (!made.ok) throw new Error(made.errorCode);
    const created = ActionPolicyOutputSchemas['actions.policy.set'].parse(made.result);
    if (!('profileChange' in created) || created.profileChange.kind !== 'create') throw new Error('Missing profile Artifact');
    const profileId = created.profileChange.id;
    for (const recipient of [actor, withoutWorkflow]) {
      const granted = await author.executeReviewed('artifact.access.grants.set', {
        artifactId: profileId, principal: { kind: 'account', accountId: readAccountIdFromToken(recipient.credentials.token) }, accessLevel: 'view',
      });
      expect(granted.ok, JSON.stringify(granted)).toBe(true);
    }
    const session = await fixture.assertKnownGoodSessionControl(actor, machine);
    const missingSession = await fixture.assertKnownGoodSessionControl(withoutWorkflow, missingMachine);
    const madeWorkflow = await author.executeAsPerson('workflow.definition.create', { definitionId: randomUUID(),
      metadata: { title: 'Direct profile review' }, definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'review', document: { text: 'Review this command and finish successfully.', references: [], attachments: [] } }],
      } });
    expect(madeWorkflow.ok, JSON.stringify(madeWorkflow)).toBe(true);
    if (!madeWorkflow.ok) throw new Error(madeWorkflow.errorCode);
    const workflow = WorkflowDefinitionCreateResultV1Schema.parse(madeWorkflow.result);
    const workflowGrant = await author.executeReviewed('artifact.access.grants.set', { artifactId: workflow.definitionId,
      principal: { kind: 'account', accountId: readAccountIdFromToken(actor.credentials.token) }, accessLevel: 'view' });
    expect(workflowGrant, JSON.stringify(workflowGrant)).toMatchObject({ ok: true });
    const subject = { kind: 'approvalProfile' as const, serverId: fixture.serverId, profileId };
    const linked = await author.executeReviewed('workflow.trigger.add', { workflow: workflow.definitionId,
      project: { machineId: authorMachine.target.machineId, directory: authorMachine.workspaceDir },
      trigger: { kind: 'action', phase: 'before', mode: 'wait', onFailure: 'ask', enabled: true,
        actionIds: ['machines.command.run'], subject } });
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    if (!linked.ok) throw new Error(linked.errorCode);
    const saved = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
    if (!saved.triggerId) throw new Error('Missing linked profile trigger');
    for (const [account, sessionId] of [[actor, session.sessionId], [withoutWorkflow, missingSession.sessionId]] as const) {
      const row = await fetchSessionV2(fixture.server.baseUrl, account.credentials.token, sessionId);
      const selected = await account.executeAsPerson('session.approval_profile.set', { sessionId, serverId: fixture.serverId,
        expectedMetadataRevision: row.metadataVersion, approvalProfileId: profileId });
      expect(selected, JSON.stringify(selected)).toMatchObject({ ok: true });
    }
    const agentLinkInput = { workflow: workflow.definitionId,
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'action', phase: 'before', mode: 'wait', onFailure: 'ask', enabled: true,
        actionIds: ['machines.command.run'], subject } };
    const agentLink = await fixture.executeSessionMcpAction(actor,
      { sessionId: session.sessionId, logPath: agent.logPath }, 'workflow.trigger.add', agentLinkInput);
    expect(agentLink.ok, JSON.stringify(agentLink)).toBe(true);
    if (!agentLink.ok) throw new Error(agentLink.errorCode);
    const agentLinkApproval = ActionApprovalRequestCreatedResultSchema.parse(agentLink.result);
    const canceledLink = await actor.executeAsPerson('approval.request.decide', { artifactId: agentLinkApproval.artifactId, decision: 'cancel' });
    expect(canceledLink, JSON.stringify(canceledLink)).toMatchObject({ ok: true });
    const direct = await actor.execute('workflow.trigger.list', { subject });
    expect(direct.ok, JSON.stringify(direct)).toBe(true);
    if (!direct.ok) throw new Error(direct.errorCode);
    expect(WorkflowTriggerListResultV1Schema.parse(direct.result).attached).toEqual(expect.arrayContaining([
      expect.objectContaining({ automationId: saved.set.automationId, triggerId: saved.triggerId }),
    ]));
    const skipped = await withoutWorkflow.execute('workflow.trigger.list', { subject });
    expect(skipped.ok, JSON.stringify(skipped)).toBe(true);
    if (!skipped.ok) throw new Error(skipped.errorCode);
    expect(WorkflowTriggerListResultV1Schema.parse(skipped.result)).toMatchObject({ attached: [], skippedNotSharedCount: 1 });
    const runs = async (account: typeof actor) => {
      const listed = await account.execute('workflow.run.list', { sourceArtifactId: workflow.definitionId });
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      if (!listed.ok) throw new Error(listed.errorCode);
      return WorkflowRunListResultV1Schema.parse(listed.result).runs;
    };
    // Each Session's native host owns its caller and Machine custody, including
    // continuation after automatic checks; the Account reader cannot supply it.
    const invoke = (account: typeof actor, sessionId: string, logPath: string) => fixture!.executeSessionMcpAction(account,
      { sessionId, logPath }, 'machines.command.run', { command: 'echo checked' });
    const missingWorkflowCommand = await invoke(withoutWorkflow, missingSession.sessionId, missingAgent.logPath);
    expect(missingWorkflowCommand, JSON.stringify(missingWorkflowCommand)).toMatchObject({ ok: true, result: { exitCode: 0 } });
    expect(await runs(withoutWorkflow)).toEqual([]);
    const invoked = await invoke(actor, session.sessionId, agent.logPath);
    expect(invoked.ok, JSON.stringify(invoked)).toBe(true);
    if (!invoked.ok) throw new Error(invoked.errorCode);
    const pending = ActionApprovalRequestCreatedResultSchema.parse(invoked.result);
    const readPending = async (artifactId = pending.artifactId) => {
      const result = await actor.execute('approval.request.get', { artifactId });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      return ApprovalRequestGetResultV1Schema.parse(result.result).request;
    };
    expect(await readPending()).toMatchObject({ status: 'open', automaticChecks: { phase: 'consent',
      consents: [expect.objectContaining({ automationId: saved.set.automationId, triggerId: saved.triggerId, decision: 'pending' })] } });
    expect(await runs(actor)).toEqual([]);
    expect(await runs(author)).toEqual([]);
    const consented = await actor.executeAsPerson('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve',
      triggerConsent: { automationId: saved.set.automationId, triggerId: saved.triggerId, decision: 'allow' } });
    expect(consented, JSON.stringify(consented)).toMatchObject({ ok: true });
    await waitFor(async () => (await readPending()).status === 'executed', { context: 'Direct recipient consented check settlement', failFast: true });
    const executed = await readPending();
    expect(executed, JSON.stringify(executed)).toMatchObject({ execution: { ok: true } });
    const actorRuns = await runs(actor);
    expect(actorRuns).toHaveLength(1);
    expect(await runs(author)).toEqual([]);
    const run = await actor.execute('workflow.run.get', { runId: actorRuns[0]!.id });
    expect(run.ok, JSON.stringify(run)).toBe(true);
    if (!run.ok) throw new Error(run.errorCode);
    expect(WorkflowRunGetResultV1Schema.parse(run.result).acceptedContext.machineId).toBe(machine.target.machineId);
    expect(await author.execute('workflow.run.get', { runId: actorRuns[0]!.id })).toMatchObject({ ok: false, errorCode: 'run_not_found' });
    expect(await withoutWorkflow.execute('workflow.run.get', { runId: actorRuns[0]!.id })).toMatchObject({ ok: false, errorCode: 'run_not_found' });
    // Current consent is reusable; the Action finishes without a second card.
    const repeated = await invoke(actor, session.sessionId, agent.logPath);
    expect(repeated.ok, JSON.stringify(repeated)).toBe(true);
    if (!repeated.ok) throw new Error(repeated.errorCode);
    const repeatedPending = ActionApprovalRequestCreatedResultSchema.safeParse(repeated.result);
    if (repeatedPending.success) {
      expect((await readPending(repeatedPending.data.artifactId)).automaticChecks?.phase).not.toBe('consent');
      await waitFor(async () => (await readPending(repeatedPending.data.artifactId)).status === 'executed',
        { context: 'Direct recipient current consent reuse', failFast: true });
    } else expect(repeated, JSON.stringify(repeated)).toMatchObject({ ok: true, result: { exitCode: 0 } });
  }, 0);
});
