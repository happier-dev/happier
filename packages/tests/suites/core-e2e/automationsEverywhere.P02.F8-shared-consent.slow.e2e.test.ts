import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import type { MachineAccessGrantSetInputV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowDefinitionEditResultV1Schema, WorkflowRunListResultV1Schema,
  WorkflowRunGetResultV1Schema, WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ApprovalQueueListResultV1Schema, ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { AccountApiTokensCreateActionOutputV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1, AutomationActionAdmitRequestV1Schema,
  AutomationActionAdmitResultV1Schema } from '@happier-dev/protocol/automations/automationActionOccurrenceV1';
import { AutomationDefinitionDetailSchema, AutomationDefinitionListResponseSchema,
  buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { openAutomationStoredWorkflowDefinitionV2 } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { RoleActionOutputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { automationSubjectKeyV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { prepareCliPrivateLabel } from '../../../../apps/cli/src/api/privateLabels';
import { getAutomationDefinition } from '../../../../apps/cli/src/api/automations';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { createCliAutomationEncryptionResolver } from '../../../../apps/cli/src/session/actions/workflowTriggers';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { fetchJson } from '../../src/testkit/http';
import { waitFor } from '../../src/testkit/timing';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { readFakeClaudeLogEvents } from '../../src/testkit/fakeClaude';
import { connectStdioMcp, parseToolJson, type ExternalMcpClient, type ExternalMcpTransport } from '../../src/testkit/externalMcp';
import { writeActivatedActionExecutionPluginFixture,
  writeEnabledLocalExtensionPackageState } from '../../src/testkit/extensions/localPackageFixture';

describe('AE.P02.F8-shared-consent', () => {
  let fixture: TeamSetupFFixture | undefined;
  let mcp: Readonly<{ client: ExternalMcpClient; transport: ExternalMcpTransport }> | undefined;
  let releaseFile: string | undefined;
  afterEach(async () => {
    if (releaseFile) await writeFile(releaseFile, 'release');
    releaseFile = undefined;
    await mcp?.client.close();
    await mcp?.transport.close();
    mcp = undefined;
    await fixture?.stop(); fixture = undefined;
  }, 0);

  it('rejects a forged encrypted reach header at the server write boundary', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ae-p02-f8-forged-reach-'));
    fixture = await startTeamSetupFFixture({ testDir,
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const author = await fixture.createAccount('author');
    const machine = await fixture.enrollDaemon(author);
    await fixture.assertKnownGoodSessionControl(author, machine);
    const created = await author.executeAsPerson('workflow.definition.create', { definitionId: randomUUID(),
      metadata: { title: 'Reach admission' }, definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'check', document: { text: 'Check the command.', references: [], attachments: [] } }] } });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error(created.errorCode);
    const workflow = WorkflowDefinitionCreateResultV1Schema.parse(created.result);
    const linked = await author.executeAsPerson('workflow.trigger.add', { workflow: workflow.definitionId,
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'action', phase: 'after', enabled: true, actionIds: ['machines.command.run'] } });
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    if (!linked.ok) throw new Error(linked.errorCode);
    const saved = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
    const headers = { Authorization: `Bearer ${author.credentials.token}`, 'Content-Type': 'application/json',
      ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
    const subject = { kind: 'machine' as const, ...machine.target, machineId: randomUUID() };
    for (const scoped of [true, false]) {
      const triggerId = randomUUID();
      const trigger = { kind: 'action' as const, phase: 'after' as const, actionIds: ['machines.command.run'],
        ...(scoped ? { subject } : {}) };
      const envelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'e2ee',
        material: { type: 'dataKey', machineKey: author.auth.accountMachineKey }, randomBytes: tweetnacl.randomBytes,
        binding: { v: 1, automationId: saved.set.automationId, triggerId, triggerRevision: 0, triggerKind: 'action' },
        definition: trigger });
      const forged = await fetchJson<unknown>(`${fixture.server.baseUrl}/v3/automations/${saved.set.automationId}/triggers`, {
        method: 'POST', headers, body: JSON.stringify({ triggerId, trigger: {
          kind: 'action', phase: 'after', enabled: true, actionIds: trigger.actionIds,
          ...(scoped ? { subjectKind: subject.kind, subjectKey: automationSubjectKeyV1(subject) } : {}),
          reachesOthers: true, triggerDefinitionEnvelope: envelope,
        } }),
      });
      expect(forged.status, JSON.stringify(forged.data)).toBe(409);
      expect(forged.data).toMatchObject({ error: 'automation_stored_content_unavailable' });
    }
    const detail = await fetchJson<unknown>(`${fixture.server.baseUrl}/v3/automations/${saved.set.automationId}`, { headers });
    expect(detail.status).toBe(200);
    expect(AutomationDefinitionDetailSchema.parse(detail.data).triggers).toHaveLength(1);
  });

  it('visibly skips a shared needs-Machine check on an Account-only Environment write', async () => {
    fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'ae-p02-f8-no-machine-')),
      observeActionRequests: true, serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const author = await fixture.createAccount('author');
    const actor = await fixture.createAccount('actor');
    expect((await fixture.claimHomeOwner(author)).result.status).toBe('claimed');
    const machine = await fixture.enrollDaemon(author, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const teamResult = await author.executeAsPerson('teams.create', { v: 1, name: 'Environment managers', requestKey: randomUUID(),
      initialOwnerAccountId: readAccountIdFromToken(author.credentials.token) });
    expect(teamResult.ok, JSON.stringify(teamResult)).toBe(true);
    if (!teamResult.ok) throw new Error(teamResult.errorCode);
    const teamId = TeamSummaryV1Schema.parse(teamResult.result).id;
    expect(await author.executeAsPerson('teams.members.add', { v: 1, teamId, role: 'admin', historyAccess: 'from_membership',
      accountId: readAccountIdFromToken(actor.credentials.token) })).toMatchObject({ ok: true });
    const machineGrant = await author.executeAsPerson('machines.access.grant.set', { ...machine.target,
      principal: { kind: 'account', accountId: readAccountIdFromToken(actor.credentials.token) }, level: 'admin' } satisfies MachineAccessGrantSetInputV1);
    expect(machineGrant, JSON.stringify(machineGrant)).toMatchObject({ ok: true, result: { kind: 'saved' } });
    const sourceOwnerMachineGrant = await author.executeAsPerson('machines.access.grant.set', { ...machine.target,
      principal: { kind: 'team', teamId }, level: 'view' } satisfies MachineAccessGrantSetInputV1);
    expect(sourceOwnerMachineGrant, JSON.stringify(sourceOwnerMachineGrant)).toMatchObject({ ok: true, result: { kind: 'saved' } });
    const sourceResult = await author.executeAsPerson('projects.sources.create', { serverId: fixture.serverId,
      name: 'Shared Environment', owner: { kind: 'team', teamId }, requestKey: randomUUID() });
    expect(sourceResult.ok, JSON.stringify(sourceResult)).toBe(true);
    if (!sourceResult.ok) throw new Error(sourceResult.errorCode);
    const source = ProjectSourcesReadOutputV1Schema.parse(sourceResult.result);
    if (!source.ok) throw new Error(source.error);
    const document = JSON.stringify({ services: { app: { image: 'example.invalid/review:latest' } } });
    const environmentResult = await author.executeAsPerson('deployments.environments.create', {
      serverId: fixture.serverId, projectSourceId: source.source.id, requestKey: randomUUID(),
      name: 'Account-only controller edit', retainPreviousDeployments: 1,
      definition: { from: 'compose', document, profiles: [], services: ['app'] },
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
      controllerMachineId: machine.target.machineId, buildMachineId: machine.target.machineId,
    });
    expect(environmentResult.ok, JSON.stringify(environmentResult)).toBe(true);
    if (!environmentResult.ok) throw new Error(environmentResult.errorCode);
    const environment = DeploymentActionOutputSchemasV1['deployments.environments.create'].parse(environmentResult.result);
    if (!environment.ok) throw new Error(environment.error);
    const workflowResult = await author.executeAsPerson('workflow.definition.create', { definitionId: randomUUID(),
      metadata: { title: 'Shared Environment review' }, definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'review', document: { text: 'Review the controller change.', references: [], attachments: [] } }] } });
    expect(workflowResult.ok, JSON.stringify(workflowResult)).toBe(true);
    if (!workflowResult.ok) throw new Error(workflowResult.errorCode);
    const workflow = WorkflowDefinitionCreateResultV1Schema.parse(workflowResult.result);
    expect(await author.executeAsPerson('artifact.access.grants.set', { artifactId: workflow.definitionId,
      principal: { kind: 'team', teamId }, accessLevel: 'view' })).toMatchObject({ ok: true });
    const activeFixture = fixture;
    let environmentRevision = environment.revision;
    let actorSession: Readonly<{ sessionId: string; machineId: string }> | undefined;
    const exercisePhase = async (phase: 'before' | 'after') => {
      const initialRuns = await actor.execute('workflow.run.list', { sourceArtifactId: workflow.definitionId, starter: 'current_account' });
      if (!initialRuns.ok) throw new Error(initialRuns.errorCode);
      const initialRunIds = WorkflowRunListResultV1Schema.parse(initialRuns.result).runs.map(run => run.id);
      const assertNoConsentReadOrCard = () => {
        const occurrences = activeFixture.readActionOccurrences();
        const requests = activeFixture.takeRequestObservations();
        expect(requests.filter(request => request.method === 'GET' && request.path.startsWith('/v3/automations/')
          && request.path !== AUTOMATION_ACTION_INDEX_HTTP_PATH_V1)).toEqual([]);
        expect(requests.filter(request => request.method === 'POST' && request.path === '/v1/artifacts')).toEqual([]);
        expect(occurrences).toEqual([]);
        return requests;
      };
      const linked = await author.executeAsPerson('workflow.trigger.add', { workflow: workflow.definitionId, visibleTeamId: teamId,
        project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
        trigger: { kind: 'action', phase, ...(phase === 'before' ? { mode: 'wait', onFailure: 'ask' } : {}), enabled: true,
          actionIds: ['deployments.environments.controller.set'], subject: { kind: 'environment', serverId: activeFixture.serverId,
            environmentId: environment.environmentId } } });
      expect(linked.ok, JSON.stringify(linked)).toBe(true);
      if (!linked.ok) throw new Error(linked.errorCode);
      const shared = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
      activeFixture.takeRequestObservations();
      // This Account UI invocation has no Session or Machine binder. The controller
      // id is an Environment record field, not execution placement.
      const result = await actor.executeAsPerson('deployments.environments.controller.set', { serverId: activeFixture.serverId,
        environmentId: environment.environmentId, expectedRevision: environmentRevision,
        controllerMachineId: machine.target.machineId });
      expect(result).toMatchObject({ ok: true, automationNotices: [expect.objectContaining({ code: 'action_automation_skipped',
        reason: 'machineRequired', automationId: shared.set.automationId, triggerId: shared.triggerId })] });
      if (!result.ok) throw new Error(result.errorCode);
      const firstEdit = DeploymentActionOutputSchemasV1['deployments.environments.controller.set'].parse(result.result);
      expect(firstEdit).toMatchObject({ ok: true, environmentId: environment.environmentId });
      if (!firstEdit.ok) throw new Error(firstEdit.error);
      expect(assertNoConsentReadOrCard()).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'POST',
        path: `/v1/deployments/environments/${environment.environmentId}/controller`, statusCode: 200 })]));
      const index = await fetchJson<unknown>(`${activeFixture.server.baseUrl}${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`,
        { headers: { Authorization: `Bearer ${actor.credentials.token}` } });
      expect(index.status).toBe(200);
      expect(ActionAutomationIndexV1Schema.parse(index.data).rows.filter(row => row.consentFor?.automationId === shared.set.automationId
        && row.consentFor.triggerId === shared.triggerId)).toEqual([]);
      for (const account of [author, actor]) {
        const runs = await account.execute('workflow.run.list', { sourceArtifactId: workflow.definitionId, starter: 'current_account' });
        expect(runs.ok, JSON.stringify(runs)).toBe(true);
        if (!runs.ok) throw new Error(runs.errorCode);
        expect(WorkflowRunListResultV1Schema.parse(runs.result).runs.map(run => run.id)).toEqual(account === actor ? initialRunIds : []);
      }

      // An Account Action still has no execution Machine when its caller has
      // a configured Session. That binder must not launch the shared check.
      if (!actorSession) {
        const actorMachine = await activeFixture.enrollDaemon(actor,
          { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
        const control = await activeFixture.assertKnownGoodSessionControl(actor, actorMachine);
        actorSession = { sessionId: control.sessionId, machineId: actorMachine.target.machineId };
      }
      activeFixture.takeRequestObservations();
      const bound = await actor.executeAsPerson('deployments.environments.controller.set', {
        serverId: activeFixture.serverId, environmentId: environment.environmentId,
        expectedRevision: firstEdit.revision, controllerMachineId: machine.target.machineId,
      }, { defaultSessionId: actorSession.sessionId, defaultSessionMachineId: actorSession.machineId });
      expect(bound.ok, JSON.stringify(bound)).toBe(true);
      if (!bound.ok) throw new Error(bound.errorCode);
      expect(bound).toMatchObject({ automationNotices: [expect.objectContaining({
        code: 'action_automation_skipped', reason: 'machineRequired' })] });
      assertNoConsentReadOrCard();
      const boundEdit = DeploymentActionOutputSchemasV1['deployments.environments.controller.set'].parse(bound.result);
      if (!boundEdit.ok) throw new Error(boundEdit.error);
      activeFixture.takeRequestObservations();
      const unboundCurrent = await actor.executeAsPerson('deployments.environments.controller.set', {
        serverId: activeFixture.serverId, environmentId: environment.environmentId,
        expectedRevision: boundEdit.revision, controllerMachineId: machine.target.machineId });
      expect(unboundCurrent).toMatchObject({ ok: true, automationNotices: [expect.objectContaining({
        code: 'action_automation_skipped', reason: 'machineRequired' })] });
      assertNoConsentReadOrCard();
      if (!unboundCurrent.ok) throw new Error(unboundCurrent.errorCode);
      const finalEdit = DeploymentActionOutputSchemasV1['deployments.environments.controller.set'].parse(unboundCurrent.result);
      if (!finalEdit.ok) throw new Error(finalEdit.error);
      environmentRevision = finalEdit.revision;
      const after = await actor.execute('workflow.run.list', { sourceArtifactId: workflow.definitionId, starter: 'current_account' });
      expect(after.ok, JSON.stringify(after)).toBe(true);
      if (!after.ok) throw new Error(after.errorCode);
      expect(WorkflowRunListResultV1Schema.parse(after.result).runs.map(run => run.id)).toEqual(initialRunIds);
      const afterIndex = await fetchJson<unknown>(`${activeFixture.server.baseUrl}${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`,
        { headers: { Authorization: `Bearer ${actor.credentials.token}` } });
      expect(afterIndex.status).toBe(200);
      expect(ActionAutomationIndexV1Schema.parse(afterIndex.data).rows.filter(row =>
        row.consentFor?.automationId === shared.set.automationId && row.consentFor.triggerId === shared.triggerId))
        .toEqual([]);
      expect(await author.executeAsPerson('workflow.trigger.update', { automationId: shared.set.automationId,
        triggerId: shared.triggerId, expectedRevision: shared.set.revision, patch: { enabled: false } })).toMatchObject({ ok: true });
    };
    await exercisePhase('before');
    await exercisePhase('after');
  }, 0);

  it('asks the execution Account before a shared check and keeps the consent row out of ordinary listings', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ae-p02-f8-'));
    const agentLogPath = join(testDir, 'actor-agent.jsonl');
    releaseFile = join(testDir, 'release-bot-turn');
    fixture = await startTeamSetupFFixture({ testDir,
      observeActionRequests: true, serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const author = await fixture.createAccount('author');
    const actor = await fixture.createAccount('actor');
    const reader = await fixture.createAccount('reader');
    const unrelated = await fixture.createAccount('unrelated');
    const pluginId = 'acme.f8-consent';
    const pluginLocalActionId = 'review';
    const pluginActionId = formatQualifiedPluginActionId({ pluginId, localId: pluginLocalActionId });
    const pluginRoot = join(testDir, 'review-plugin');
    const pluginEffectPath = join(testDir, 'nested-plugin-fired.txt');
    await writeActivatedActionExecutionPluginFixture({ pluginRoot, pluginId, actionId: pluginLocalActionId,
      markerPath: pluginEffectPath });
    await writeEnabledLocalExtensionPackageState({ happyHomeDir: join(testDir, actor.name, 'home'), pluginRoot, pluginId });
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      HAPPIER_E2E_FAKE_CLAUDE_LOG: agentLogPath, HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
      HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'daemon-runtime-continuity',
      HAPPIER_E2E_FAKE_CLAUDE_RUNTIME_CONTINUITY_RELEASE_FILE: releaseFile } });
    const session = await fixture.assertKnownGoodSessionControl(actor, machine);
    const decidingSession = await fixture.assertKnownGoodSessionControl(actor, machine);
    const reviewTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const roleInstructions = `AE_F8_ACTOR_ROLE_${randomUUID()}`;
    const reviewDocument = 'Check the command and finish successfully.';
    const reviewRole = { name: 'Actor command review',
      instructions: roleInstructions, engine: { agentTargetKey: buildBackendTargetKeyV2(reviewTarget) },
      runsAs: { kind: 'background_run', intent: 'task' }, workspaceWrites: 'deny', secondOpinion: 'off', enabled: true } as const;
    const createdRole = await actor.executeAsPerson('roles.create', { role: reviewRole });
    expect(createdRole.ok, JSON.stringify(createdRole)).toBe(true);
    if (!createdRole.ok) throw new Error(createdRole.errorCode);
    const role = RoleActionOutputSchemasV1['roles.create'].parse(createdRole.result);
    expect(await actor.executeAsPerson('actions.policy.set', { actionId: 'approval.request.decide', audience: 'mcp', mode: 'allowed' }))
      .toMatchObject({ ok: true, result: { mode: 'allowed' } });
    const waivedAgentDecision = { authority: 'account_automation' as const, surface: 'mcp' as const,
      defaultSessionId: decidingSession.sessionId,
      actionCaller: { kind: 'session' as const, sessionId: decidingSession.sessionId, starterDepth: 0, turnDepth: 0 },
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {},
        approvalWaivedSurfaces: { 'approval.request.decide': ['mcp'] } }) };
    const created = await author.executeAsPerson('workflow.definition.create', { definitionId: randomUUID(),
      metadata: { title: 'Shared command check' }, definition: { version: 1,
        defaults: { roleId: role.roleId }, blocks: [
        { kind: 'step', id: 'review', document: { text: reviewDocument, references: [], attachments: [] } },
      ] } });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error(created.errorCode);
    const workflow = WorkflowDefinitionCreateResultV1Schema.parse(created.result);
    const teamIds: string[] = [];
    for (const name of ['Workflow readers', 'Other workflow readers']) {
      const made = await author.executeAsPerson('teams.create', { v: 1, name, requestKey: randomUUID() });
      expect(made.ok, JSON.stringify(made)).toBe(true);
      if (!made.ok) throw new Error(made.errorCode);
      const teamId = TeamSummaryV1Schema.parse(made.result).id;
      teamIds.push(teamId);
      expect(await author.executeAsPerson('teams.members.add', { v: 1, teamId, role: 'member', historyAccess: 'from_membership',
        accountId: readAccountIdFromToken(actor.credentials.token) })).toMatchObject({ ok: true });
      expect(await author.executeAsPerson('teams.members.add', { v: 1, teamId, role: 'member', historyAccess: 'from_membership',
        accountId: readAccountIdFromToken(reader.credentials.token) })).toMatchObject({ ok: true });
      expect(await author.executeAsPerson('artifact.access.grants.set', { artifactId: workflow.definitionId,
        principal: { kind: 'team', teamId }, accessLevel: 'view' })).toMatchObject({ ok: true });
    }
    const ungrantedTeam = await author.executeAsPerson('teams.create', { v: 1, name: 'No Workflow grant', requestKey: randomUUID() });
    expect(ungrantedTeam.ok, JSON.stringify(ungrantedTeam)).toBe(true);
    if (!ungrantedTeam.ok) throw new Error(ungrantedTeam.errorCode);
    expect(await author.executeAsPerson('teams.members.add', { v: 1, teamId: TeamSummaryV1Schema.parse(ungrantedTeam.result).id,
      role: 'member', historyAccess: 'from_membership', accountId: readAccountIdFromToken(unrelated.credentials.token) }))
      .toMatchObject({ ok: true });
    // A needs Manage on the operand to attach a shared check. The check still
    // belongs to B and uses the invoking Session's Machine when B allows it.
    expect(await actor.executeAsPerson('machines.access.grant.set', { ...machine.target,
      principal: { kind: 'account', accountId: readAccountIdFromToken(author.credentials.token) }, level: 'manage' }))
      .toMatchObject({ ok: true });
    const otherMachine = await fixture.enrollDaemon({ ...actor, name: 'actor-other-machine' },
      { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    expect(otherMachine.target.machineId).not.toBe(machine.target.machineId);
    const otherSession = await fixture.assertKnownGoodSessionControl(actor, otherMachine);
    expect(await actor.executeAsPerson('machines.access.grant.set', { ...otherMachine.target,
      principal: { kind: 'account', accountId: readAccountIdFromToken(author.credentials.token) }, level: 'view' }))
      .toMatchObject({ ok: true });
    // An author's account-wide trigger and a trigger on a resource the author
    // can only view must not enter another person's before bucket.
    expect(await author.executeAsPerson('workflow.trigger.add', { workflow: workflow.definitionId, visibleTeamId: teamIds[0],
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'action', phase: 'before', mode: 'wait', onFailure: 'ask', enabled: true,
        actionIds: ['machines.command.run'] } })).toMatchObject({ ok: true });
    expect(await author.executeAsPerson('workflow.trigger.add', { workflow: workflow.definitionId, visibleTeamId: teamIds[0],
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'action', phase: 'before', mode: 'wait', onFailure: 'ask', enabled: true,
        actionIds: ['machines.command.run'], subject: { kind: 'machine', ...otherMachine.target } } }))
      .toMatchObject({ ok: true });
    const linked = await author.executeAsPerson('workflow.trigger.add', { workflow: workflow.definitionId,
      visibleTeamId: teamIds[0],
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'action', phase: 'before', mode: 'wait', onFailure: 'ask', enabled: true,
        actionIds: ['machines.command.run'], subject: { kind: 'machine', ...machine.target } } });
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    if (!linked.ok) throw new Error(linked.errorCode);
    const shared = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
    if (!shared.triggerId) throw new Error('Shared trigger identity is missing');
    let sharedRevision = shared.set.revision;
    const setSharedPhase = async (phase: 'before' | 'after') => {
      const updated = await author.executeAsPerson('workflow.trigger.update', { automationId: shared.set.automationId,
        triggerId: shared.triggerId, expectedRevision: sharedRevision, patch: { trigger: {
          kind: 'action', phase, ...(phase === 'before' ? { mode: 'wait', onFailure: 'ask' } : {}),
          actionIds: ['machines.command.run'], subject: { kind: 'machine', ...machine.target },
        } } });
      expect(updated.ok, JSON.stringify(updated)).toBe(true);
      if (!updated.ok) throw new Error(updated.errorCode);
      sharedRevision = WorkflowTriggerWriteResultV1Schema.parse(updated.result).set.revision;
    };
    const unmatched = await actor.execute('machines.command.run', { command: process.platform === 'win32' ? 'echo other' : 'printf other' },
      { defaultSessionId: otherSession.sessionId, presentUserConfirmation: { actionId: 'machines.command.run' },
        externalActionTarget: { kind: 'machine', machineId: otherMachine.target.machineId,
          project: { machineId: otherMachine.target.machineId, directory: otherMachine.workspaceDir } } });
    expect(unmatched).toMatchObject({ ok: true, result: { exitCode: 0 } });
    const invoke = () => actor.execute('machines.command.run', { command: process.platform === 'win32' ? 'echo checked' : 'printf checked' },
      { defaultSessionId: session.sessionId, presentUserConfirmation: { actionId: 'machines.command.run' },
        externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
          project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } });
    const headers = { Authorization: `Bearer ${actor.credentials.token}`,
      ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
    const consentRows = async () => {
      const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`, { headers });
      expect(response.status).toBe(200);
      return ActionAutomationIndexV1Schema.parse(response.data).rows.filter(row => row.consentFor?.automationId === shared.set.automationId
        && row.consentFor.triggerId === shared.triggerId);
    };
    const readConsentContext = async (automationId: string) => {
      const row = await runWithServerHttpBaseUrl(fixture!.server.baseUrl,
        () => getAutomationDefinition({ token: actor.credentials.token, automationId }));
      if (row?.executionRecipe?.v !== 2) throw new Error('Missing actor consent Workflow recipe');
      const encryption = await createCliAutomationEncryptionResolver({ credentials: actor.credentials,
        serverHttpBaseUrl: fixture!.server.baseUrl })();
      const opened = openAutomationStoredWorkflowDefinitionV2({ workflow: row.executionRecipe.workflow, encryption });
      if (opened.kind !== 'available') throw new Error(`Actor consent open failed: ${opened.kind}`);
      return opened.definition;
    };
    const readApproval = async (artifactId: string) => {
      const result = await actor.execute('approval.request.get', { artifactId });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      return ApprovalRequestGetResultV1Schema.parse(result.result).request;
    };
    const actorRuns = async () => {
      const result = await actor.execute('workflow.run.list', { sourceArtifactId: workflow.definitionId, starter: 'current_account' });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      return WorkflowRunListResultV1Schema.parse(result.result).runs;
    };
    const waitExecuted = async (artifactId: string) => {
      await waitFor(async () => (await readApproval(artifactId)).execution !== undefined,
        { context: 'Shared check and original command settlement', failFast: true });
      expect(await readApproval(artifactId)).toMatchObject({ status: 'executed', execution: { ok: true } });
    };
    const settleWithoutConsent = async (result: Awaited<ReturnType<typeof invoke>>) => {
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
      if (pending.success) {
        expect(await readApproval(pending.data.artifactId)).not.toMatchObject({ automaticChecks: { phase: 'consent' } });
        await waitExecuted(pending.data.artifactId);
      } else expect(result).toMatchObject({ result: { exitCode: 0 } });
    };

    // Exercise the actual Bot turn's MCP registration. Standalone MCP does not
    // carry the shared message's requester and cannot prove this boundary.
    expect(await actor.executeAsPerson('session.bot.set', { sessionId: session.sessionId, bot: { kind: 'bot' } }))
      .toMatchObject({ ok: true });
    expect(await actor.executeAsPerson('session.access.grant.set', { v: 1, sessionId: session.sessionId,
      subject: { kind: 'account', accountId: readAccountIdFromToken(author.credentials.token) },
      accessLevel: 'edit', canApprovePermissions: true })).toMatchObject({ ok: true });
    const botPrompt = `DAEMON_RUNTIME_CONTINUITY_HOLD_${randomUUID()}`;
    expect(await author.executeAsPerson('session.send', { sessionId: { serverId: fixture.serverId, sessionId: session.sessionId },
      message: botPrompt, reply: 'none' })).toMatchObject({ ok: true });
    let botInvocationId: string | undefined;
    await waitFor(async () => {
      const events = await readFakeClaudeLogEvents(agentLogPath);
      const input = events.find(event => event.type === 'sdk_stdin' && typeof event.userText === 'string' && event.userText.includes(botPrompt));
      const entered = events.find(event => event.type === 'runtime_continuity_provider_effect_entered'
        && input && event.invocationId === input.invocationId);
      if (typeof entered?.invocationId !== 'string') return false;
      botInvocationId = entered.invocationId;
      return true;
    }, { context: 'Shared author message enters the real Bot turn' });
    const launch = (await readFakeClaudeLogEvents(agentLogPath)).find(event => event.type === 'invocation'
      && event.invocationId === botInvocationId)?.mergedMcpServers;
    const happier: unknown = launch && typeof launch === 'object' ? Reflect.get(launch, 'happier') : undefined;
    if (!happier || typeof happier !== 'object') throw new Error('Bot did not advertise its Happier MCP registration');
    const command: unknown = Reflect.get(happier, 'command');
    const args: unknown = Reflect.get(happier, 'args');
    const environment: unknown = Reflect.get(happier, 'env');
    if (typeof command !== 'string' || !Array.isArray(args) || !args.every((arg): arg is string => typeof arg === 'string')
      || !environment || typeof environment !== 'object') throw new Error('Bot MCP launch is not a stdio registration');
    const env: Record<string, string | undefined> = { ...process.env };
    for (const [key, value] of Object.entries(environment)) {
      if (typeof value !== 'string') throw new Error('Bot MCP launch has an invalid environment value');
      env[key] = value;
    }
    mcp = await connectStdioMcp({ command, args, env });
    const requesterMcp = mcp;
    const exerciseRequester = async (phase: 'before' | 'after', consent: 'missing' | 'stale' | 'current') => {
      const previousRunIds = (await actorRuns()).map(run => run.id);
      const previousConsentRows = await consentRows();
      const botCommand = requesterMcp.client.callTool({ name: 'action_execute', arguments: { actionId: 'machines.command.run',
        input: { command: process.platform === 'win32' ? 'echo bot' : 'printf bot' } } });
      let botEarlyReply: Awaited<typeof botCommand> | undefined;
      let botFailure: unknown;
      void botCommand.then(reply => { botEarlyReply = reply; }, error => { botFailure = error; });
      let botApprovalId: string | undefined;
      await waitFor(async () => {
        if (botFailure) throw botFailure;
        if (botEarlyReply) {
          const pending = ActionApprovalRequestCreatedResultSchema.safeParse(parseToolJson(botEarlyReply));
          if (!pending.success) throw new Error('Shared Bot command executed without its requester approval');
          botApprovalId = pending.data.artifactId;
          return true;
        }
        const listed = await actor.execute('approval.request.list', { status: 'open', actionId: 'machines.command.run' });
        expect(listed.ok, JSON.stringify(listed)).toBe(true);
        if (!listed.ok) throw new Error(listed.errorCode);
        botApprovalId = ApprovalQueueListResultV1Schema.parse(listed.result).items[0]?.artifactId;
        return botApprovalId !== undefined;
      }, { context: 'Shared Bot asks its actual requesting person' });
      if (!botApprovalId) throw new Error('Missing shared Bot requester approval');
      const pendingRequester = await readApproval(botApprovalId);
      expect(pendingRequester).toMatchObject({ requesterConfirmation: {
        requesterAccountId: readAccountIdFromToken(author.credentials.token),
        executionAccountId: readAccountIdFromToken(actor.credentials.token),
      } });
      expect(pendingRequester.automaticChecks?.consents.filter(row => row.automationId === shared.set.automationId
        && row.triggerId === shared.triggerId && row.decision === 'pending') ?? []).toEqual([]);
      if (consent !== 'current') {
        expect(await author.executeAsPerson('approval.request.decide', { artifactId: botApprovalId, decision: 'approve', triggerConsent: {
          automationId: shared.set.automationId, triggerId: shared.triggerId, decision: 'allow',
        } })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      }
      const decided = await author.executeAsPerson('approval.request.decide', { artifactId: botApprovalId, decision: 'approve' });
      expect(decided.ok, JSON.stringify(decided)).toBe(true);
      if (consent !== 'current') expect(decided).toMatchObject({ automationNotices: [expect.objectContaining({
        code: 'action_automation_skipped', reason: 'actorConsentUnavailableForRequester',
        automationId: shared.set.automationId, triggerId: shared.triggerId, workflowId: workflow.definitionId,
      })] });
      await waitExecuted(botApprovalId);
      const botReply = await botCommand;
      if (consent !== 'current') {
        const visibleNotice = botReply.content?.map(content => content.type === 'text' ? content.text : '').join('\n');
        expect(visibleNotice).toContain('actorConsentUnavailableForRequester');
        expect(visibleNotice).toContain(shared.set.automationId);
        expect(visibleNotice).toContain(shared.triggerId);
      }
      const botPending = ActionApprovalRequestCreatedResultSchema.safeParse(parseToolJson(botReply));
      if (!botPending.success) expect(parseToolJson(botReply)).toMatchObject({ exitCode: 0 });
      if (consent === 'current') {
        await waitFor(async () => (await actorRuns()).length === previousRunIds.length + 1,
          { context: `Current execution Account consent starts the shared requester ${phase} check`, failFast: true });
      } else expect((await actorRuns()).map(run => run.id)).toEqual(previousRunIds);
      expect(await consentRows()).toEqual(previousConsentRows);
    };
    await exerciseRequester('before', 'missing');
    await setSharedPhase('after');
    await exerciseRequester('after', 'missing');
    await setSharedPhase('before');

    const invoked = await invoke();
    expect(invoked.ok, JSON.stringify(invoked)).toBe(true);
    if (!invoked.ok) throw new Error(invoked.errorCode);
    const approval = ActionApprovalRequestCreatedResultSchema.parse(invoked.result);
    const triggerConsent = { automationId: shared.set.automationId, triggerId: shared.triggerId, decision: 'allow' };
    expect(await actor.execute('approval.request.get', { artifactId: approval.artifactId }))
      .toMatchObject({ ok: true, result: { request: { status: 'open', automaticChecks: {
        phase: 'consent', consents: [expect.objectContaining({ automationId: shared.set.automationId, triggerId: shared.triggerId })],
      } } } });
    expect(await actor.execute('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve', triggerConsent },
      waivedAgentDecision)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(await consentRows()).toEqual([]);
    const tokenId = randomUUID();
    const label = await prepareCliPrivateLabel({ endpoint: fixture.server.baseUrl, token: actor.credentials.token,
      accountId: readAccountIdFromToken(actor.credentials.token), accountMode: 'e2ee',
      recipientCensusPath: '/v1/account/private-labels/recipient-census',
      binding: { entity: 'account_api_token', field: 'label', id: tokenId }, value: 'Consent refusal fixture' });
    const tokenResult = await actor.executeAsPerson('account.apiTokens.create', { tokenId, label, grant: API_TOKEN_FULL_GRANT_V1 });
    expect(tokenResult.ok).toBe(true);
    if (!tokenResult.ok) throw new Error(tokenResult.errorCode);
    const token = AccountApiTokensCreateActionOutputV1Schema.parse(tokenResult.result);
    const tokenDecision = await fetchJson<unknown>(`${fixture.server.baseUrl}${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}approval.request.decide`, {
      method: 'POST', headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId: machine.target.machineId },
        input: { artifactId: approval.artifactId, decision: 'approve', triggerConsent } }),
    });
    expect(tokenDecision.status).toBe(200);
    expect(ExternalActionResponseEnvelopeV1Schema.parse(tokenDecision.data).execution)
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(await consentRows()).toEqual([]);
    const profileCreated = await actor.executeAsPerson('actions.policy.set', { profileChange: { kind: 'create', profile: {
      name: 'Waived Session decisions', actions: {}, approvalWaivedSurfaces: { 'approval.request.decide': ['mcp'] },
    } } });
    expect(profileCreated.ok).toBe(true);
    if (!profileCreated.ok || !profileCreated.result || typeof profileCreated.result !== 'object') throw new Error('Missing created profile');
    const profileChange: unknown = Reflect.get(profileCreated.result, 'profileChange');
    const profileId: unknown = profileChange && typeof profileChange === 'object' ? Reflect.get(profileChange, 'id') : undefined;
    if (typeof profileId !== 'string') throw new Error('Missing created profile identity');
    const decidingSessionRow = await fetchSessionV2(fixture.server.baseUrl, actor.credentials.token, decidingSession.sessionId);
    expect(await actor.executeAsPerson('session.approval_profile.set', { sessionId: decidingSession.sessionId,
      serverId: fixture.serverId, expectedMetadataRevision: decidingSessionRow.metadataVersion, approvalProfileId: profileId }))
      .toMatchObject({ ok: true });
    expect(await actor.executeAsPerson('actions.policy.reset', { actionId: 'approval.request.decide', audience: 'mcp' }))
      .toMatchObject({ ok: true });
    const { actionsSettings: _accountWaiver, ...profileDecision } = waivedAgentDecision;
    expect(await actor.execute('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve', triggerConsent }, profileDecision))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(await consentRows()).toEqual([]);
    expect(await author.executeAsPerson('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve', triggerConsent }))
      .toMatchObject({ ok: false });
    expect(await actor.executeAsPerson('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve', triggerConsent }))
      .toMatchObject({ ok: true });
    await waitExecuted(approval.artifactId);
    expect(await consentRows()).toHaveLength(1);
    const savedActorConsent = (await consentRows())[0];
    if (!savedActorConsent) throw new Error('Missing actor consent after person Allow');
    const reviewedContext = await readConsentContext(savedActorConsent.automationId);
    expect(reviewedContext.actorConsent?.agentSteps).toEqual([expect.objectContaining({
      blockId: 'review', document: { text: reviewDocument, references: [], attachments: [] },
      selection: expect.objectContaining({ agentTarget: reviewTarget }),
      executionTarget: { kind: 'detached_run' },
      role: expect.objectContaining({ roleId: role.roleId, instructions: roleInstructions }),
    })]);

    let checkRun: ReturnType<typeof WorkflowRunListResultV1Schema.parse>['runs'][number] | undefined;
    await waitFor(async () => {
      const listed = await actor.execute('workflow.run.list', { sourceArtifactId: workflow.definitionId, starter: 'current_account' });
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      if (!listed.ok) throw new Error(listed.errorCode);
      const runs = WorkflowRunListResultV1Schema.parse(listed.result).runs;
      expect(runs.length).toBeLessThanOrEqual(1);
      checkRun = runs[0];
      return checkRun !== undefined;
    }, { context: 'Actor-owned shared check Run admission', failFast: true });
    if (!checkRun || checkRun.origin.kind !== 'automation') throw new Error('Missing actor check Run');
    const detail = await actor.execute('workflow.run.get', { runId: checkRun.id });
    expect(detail.ok, JSON.stringify(detail)).toBe(true);
    if (!detail.ok) throw new Error(detail.errorCode);
    expect(WorkflowRunGetResultV1Schema.parse(detail.result).acceptedContext.machineId).toBe(machine.target.machineId);
    expect(await author.execute('workflow.run.get', { runId: checkRun.id })).toMatchObject({ ok: false, errorCode: 'run_not_found' });
    expect(await reader.execute('workflow.run.get', { runId: checkRun.id })).toMatchObject({ ok: false, errorCode: 'run_not_found' });
    expect(await unrelated.execute('workflow.run.get', { runId: checkRun.id })).toMatchObject({ ok: false, errorCode: 'run_not_found' });
    const authorRuns = await author.execute('workflow.run.list', { sourceArtifactId: workflow.definitionId });
    expect(authorRuns.ok).toBe(true);
    if (!authorRuns.ok) throw new Error(authorRuns.errorCode);
    expect(WorkflowRunListResultV1Schema.parse(authorRuns.result).runs).toEqual([]);
    const consent = await fetchJson<unknown>(`${fixture.server.baseUrl}/v3/automations/${checkRun.origin.automationId}`, { headers });
    expect(consent.status).toBe(200);
    expect(AutomationDefinitionDetailSchema.parse(consent.data).assignments).toEqual([]);
    const listed = await fetchJson<unknown>(`${fixture.server.baseUrl}/v3/automations`, { headers });
    expect(listed.status).toBe(200);
    expect(AutomationDefinitionListResponseSchema.parse(listed.data).automations).toEqual([]);
    fixture.takeRequestObservations();
    const repeated = await invoke();
    await settleWithoutConsent(repeated);
    expect(fixture.takeRequestObservations().filter(request => request.method === 'GET'
      && request.path === `/v1/artifacts/${workflow.definitionId}`)).toEqual([]);

    const allowCurrentPhase = async () => {
      const invoked = await invoke();
      expect(invoked.ok, JSON.stringify(invoked)).toBe(true);
      if (!invoked.ok) throw new Error(invoked.errorCode);
      const pending = ActionApprovalRequestCreatedResultSchema.parse(invoked.result);
      expect(await readApproval(pending.artifactId)).toMatchObject({ automaticChecks: { phase: 'consent' } });
      expect(await actor.executeAsPerson('approval.request.decide', { artifactId: pending.artifactId,
        decision: 'approve', triggerConsent })).toMatchObject({ ok: true });
      await waitExecuted(pending.artifactId);
    };
    await exerciseRequester('before', 'current');
    await setSharedPhase('after');
    await allowCurrentPhase();
    await exerciseRequester('after', 'current');
    await setSharedPhase('before');
    await allowCurrentPhase();

    const changedMode = await author.executeAsPerson('workflow.trigger.update', { automationId: shared.set.automationId,
      triggerId: shared.triggerId, expectedRevision: sharedRevision,
      patch: { trigger: { kind: 'action', phase: 'before', mode: 'notify',
        actionIds: ['machines.command.run'], subject: { kind: 'machine', ...machine.target } } } });
    expect(changedMode.ok, JSON.stringify(changedMode)).toBe(true);
    await settleWithoutConsent(await invoke());
    if (!changedMode.ok) throw new Error(changedMode.errorCode);
    const modeRevision = WorkflowTriggerWriteResultV1Schema.parse(changedMode.result).set.revision;
    const restoredMode = await author.executeAsPerson('workflow.trigger.update', { automationId: shared.set.automationId,
      triggerId: shared.triggerId, expectedRevision: modeRevision,
      patch: { trigger: { kind: 'action', phase: 'before', mode: 'wait', onFailure: 'refuse',
        actionIds: ['machines.command.run'], subject: { kind: 'machine', ...machine.target } } } });
    expect(restoredMode.ok, JSON.stringify(restoredMode)).toBe(true);
    if (!restoredMode.ok) throw new Error(restoredMode.errorCode);
    sharedRevision = WorkflowTriggerWriteResultV1Schema.parse(restoredMode.result).set.revision;
    await settleWithoutConsent(await invoke());

    const renamed = await author.executeAsPerson('workflow.definition.edit', { definitionId: workflow.definitionId,
      expectedRevision: workflow.revision, ops: [{ kind: 'rename', name: 'Renamed command check' }] });
    expect(renamed.ok, JSON.stringify(renamed)).toBe(true);
    if (!renamed.ok) throw new Error(renamed.errorCode);
    const renamedDefinition = WorkflowDefinitionEditResultV1Schema.parse(renamed.result);
    const renamedInvocation = await invoke();
    await settleWithoutConsent(renamedInvocation);

    const editedAgentSentinel = `AE_F8_EDITED_AGENT_${randomUUID()}`;
    const beforeAgentEditRunIds = (await actorRuns()).map(run => run.id);
    const edited = await author.executeAsPerson('workflow.definition.edit', { definitionId: workflow.definitionId,
      expectedRevision: renamedDefinition.revision,
      ops: [{ kind: 'set_step_prompt', blockId: 'review', text: `Inspect the command carefully. ${editedAgentSentinel}` }] });
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    if (!edited.ok) throw new Error(edited.errorCode);
    const editedDefinition = WorkflowDefinitionEditResultV1Schema.parse(edited.result);
    // The requesting person cannot refresh the execution Account's stale consent.
    await exerciseRequester('before', 'stale');
    await setSharedPhase('after');
    await exerciseRequester('after', 'stale');
    await setSharedPhase('before');
    const changedInvocation = await invoke();
    expect(changedInvocation.ok, JSON.stringify(changedInvocation)).toBe(true);
    if (!changedInvocation.ok) throw new Error(changedInvocation.errorCode);
    const changedApproval = ActionApprovalRequestCreatedResultSchema.parse(changedInvocation.result);
    expect(await readApproval(changedApproval.artifactId)).toMatchObject({ automaticChecks: { phase: 'consent' } });
    expect((await actorRuns()).map(run => run.id)).toEqual(beforeAgentEditRunIds);
    const editedAgentExecutions = async () => (await readFakeClaudeLogEvents(agentLogPath))
      .filter(event => event.type === 'sdk_stdin' && typeof event.userText === 'string' && event.userText.includes(editedAgentSentinel));
    expect(await editedAgentExecutions()).toEqual([]);
    expect(await actor.execute('approval.request.decide', { artifactId: changedApproval.artifactId, decision: 'approve',
      triggerConsent: { ...triggerConsent, decision: 'skip' } }, waivedAgentDecision))
      .toMatchObject({ ok: true });
    await waitExecuted(changedApproval.artifactId);
    expect(await readApproval(changedApproval.artifactId)).toMatchObject({ automaticChecks: {
      consents: expect.arrayContaining([expect.objectContaining({ ...triggerConsent, decision: 'skip' })]),
      notices: expect.arrayContaining([expect.objectContaining({ code: 'action_automation_skipped', reason: 'consentSkipped',
        automationId: shared.set.automationId, triggerId: shared.triggerId, workflowId: workflow.definitionId })]),
    } });
    expect((await actorRuns()).map(run => run.id)).toEqual(beforeAgentEditRunIds);
    expect(await editedAgentExecutions()).toEqual([]);
    const skippedAgain = await actor.executeAsPerson('approval.request.decide', { artifactId: changedApproval.artifactId,
      decision: 'approve' });
    expect(skippedAgain).toMatchObject({ ok: true, automationNotices: [expect.objectContaining({
      code: 'action_automation_skipped', reason: 'consentSkipped', automationId: shared.set.automationId,
      triggerId: shared.triggerId, workflowId: workflow.definitionId,
    })] });
    await writeFile(releaseFile, 'release');
    await requesterMcp.client.close(); await requesterMcp.transport.close(); mcp = undefined;

    const renewedInvocation = await invoke();
    expect(renewedInvocation.ok, JSON.stringify(renewedInvocation)).toBe(true);
    if (!renewedInvocation.ok) throw new Error(renewedInvocation.errorCode);
    const renewedApproval = ActionApprovalRequestCreatedResultSchema.parse(renewedInvocation.result);
    expect(await actor.executeAsPerson('approval.request.decide', { artifactId: renewedApproval.artifactId,
      decision: 'approve', triggerConsent })).toMatchObject({ ok: true });
    await waitExecuted(renewedApproval.artifactId);
    await waitFor(async () => (await editedAgentExecutions()).length > 0,
      { context: 'Edited Agent starts only after renewed person consent' });

    const actionEffectPath = join(machine.workspaceDir, `edited-action-${randomUUID()}.txt`);
    const editedAction = await author.executeAsPerson('workflow.definition.edit', { definitionId: workflow.definitionId,
      expectedRevision: editedDefinition.revision, ops: [{ kind: 'insert_block', list: { kind: 'root' }, afterBlockId: 'review', block: {
        kind: 'action', actionId: 'machines.command.run',
        input: { command: { kind: 'literal', value: `echo edited > "${actionEffectPath}"` } },
      } }] });
    expect(editedAction.ok, JSON.stringify(editedAction)).toBe(true);
    const savedConsent = (await consentRows())[0];
    if (!savedConsent) throw new Error('Missing actor consent reference for stale admission');
    const staleAdmission = await fetchJson<unknown>(`${fixture.server.baseUrl}${AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(AutomationActionAdmitRequestV1Schema.parse({
        triggers: [{ automationId: savedConsent.automationId, triggerId: savedConsent.triggerId,
          triggerRevision: savedConsent.triggerRevision }],
        evidence: { v: 1, kind: 'action', actionId: 'machines.command.run', requestId: randomUUID(), phase: 'before',
          occurredAt: Date.now(), machineId: machine.target.machineId, subjects: [] },
      })),
    });
    expect(staleAdmission.status).toBe(200);
    const staleRun = AutomationActionAdmitResultV1Schema.parse(staleAdmission.data).results[0];
    if (!staleRun || staleRun.kind === 'skipped') throw new Error('Stale consent did not reach daemon admission');
    let leafApprovalId: string | undefined;
    await waitFor(async () => {
      const result = await actor.execute('workflow.run.invocations.list', { runId: staleRun.runId,
        lifecycles: ['needs_attention'], includeContent: true });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      const held = WorkflowInvocationListResultV1Schema.parse(result.result).invocationDetails?.find(detail =>
        detail.progress.reason?.code === 'approval_required' && detail.progress.execution?.kind === 'action');
      if (!held || held.progress.execution?.kind !== 'action') return false;
      leafApprovalId = ActionApprovalRequestCreatedResultSchema.parse(held.progress.execution.output).artifactId;
      return true;
    }, { context: 'Existing Action leaf owner holds unconsented changed execution', failFast: true });
    expect(existsSync(actionEffectPath)).toBe(false);
    if (!leafApprovalId) throw new Error('Missing held Action approval');
    expect(await readApproval(leafApprovalId)).toMatchObject({ executionOriginV1: { caller: {
      kind: 'workflowRun', runId: staleRun.runId,
    } } });
    expect(await actor.executeAsPerson('approval.request.decide', { artifactId: leafApprovalId, decision: 'reject' }))
      .toMatchObject({ ok: true });
    await waitFor(async () => {
      const run = (await actorRuns()).find(candidate => candidate.id === staleRun.runId);
      if (!run || run.state !== 'failed') return false;
      expect(run.errorCode).toBe('approval_rejected');
      return true;
    }, { context: 'Rejecting the real leaf approval settles the stale check Run', failFast: true });
    expect(existsSync(actionEffectPath)).toBe(false);
    const beforeActionEditRunIds = (await actorRuns()).map(run => run.id);
    const actionEditInvocation = await invoke();
    expect(actionEditInvocation.ok, JSON.stringify(actionEditInvocation)).toBe(true);
    if (!actionEditInvocation.ok) throw new Error(actionEditInvocation.errorCode);
    const actionEditApproval = ActionApprovalRequestCreatedResultSchema.parse(actionEditInvocation.result);
    expect(await readApproval(actionEditApproval.artifactId)).toMatchObject({ automaticChecks: { phase: 'consent' } });
    expect((await actorRuns()).map(run => run.id)).toEqual(beforeActionEditRunIds);
    expect(await actor.executeAsPerson('approval.request.decide', { artifactId: actionEditApproval.artifactId,
      decision: 'approve', triggerConsent })).toMatchObject({ ok: true });
    await waitExecuted(actionEditApproval.artifactId);
    expect((await actorRuns()).length).toBe(beforeActionEditRunIds.length + 1);
    expect(existsSync(actionEffectPath)).toBe(true);

    // The deciding actor's private child and the actual Machine's contributed
    // Action must pass through the same UI Allow materializer as built-in leaves.
    const childCreated = await actor.executeAsPerson('workflow.definition.create', { definitionId: randomUUID(),
      metadata: { title: 'Actor private nested plugin check' }, definition: { version: 1, defaults: {}, blocks: [
        { kind: 'action', id: 'plugin-review', actionId: pluginActionId,
          input: { source: { kind: 'literal', value: 'F8 nested consent' } } },
      ] } });
    expect(childCreated.ok, JSON.stringify(childCreated)).toBe(true);
    if (!childCreated.ok) throw new Error(childCreated.errorCode);
    const child = WorkflowDefinitionCreateResultV1Schema.parse(childCreated.result);
    if (!editedAction.ok) throw new Error(editedAction.errorCode);
    const actionEditedDefinition = WorkflowDefinitionEditResultV1Schema.parse(editedAction.result);
    const nestedEdit = await author.executeAsPerson('workflow.definition.edit', { definitionId: workflow.definitionId,
      expectedRevision: actionEditedDefinition.revision, ops: [{ kind: 'insert_block', list: { kind: 'root' }, block: {
        kind: 'workflow', id: 'actor-child', workflowRef: child.definitionId,
      } }] });
    expect(nestedEdit.ok, JSON.stringify(nestedEdit)).toBe(true);
    const nestedInvocation = await invoke();
    expect(nestedInvocation.ok, JSON.stringify(nestedInvocation)).toBe(true);
    if (!nestedInvocation.ok) throw new Error(nestedInvocation.errorCode);
    const nestedApproval = ActionApprovalRequestCreatedResultSchema.parse(nestedInvocation.result);
    expect(await readApproval(nestedApproval.artifactId)).toMatchObject({ automaticChecks: { phase: 'consent' } });
    expect(existsSync(pluginEffectPath)).toBe(false);
    expect(await actor.executeAsPerson('approval.request.decide', { artifactId: nestedApproval.artifactId,
      decision: 'approve', triggerConsent })).toMatchObject({ ok: true });
    await waitExecuted(nestedApproval.artifactId);
    expect(existsSync(pluginEffectPath)).toBe(true);
    const nestedConsent = (await consentRows())[0];
    if (!nestedConsent) throw new Error('Missing renewed nested consent');
    const nestedContext = await readConsentContext(nestedConsent.automationId);
    expect(nestedContext.actionApprovals).toEqual(expect.arrayContaining([expect.objectContaining({
      operation: expect.objectContaining({ approvedBy: { accountId: readAccountIdFromToken(actor.credentials.token) },
        steps: expect.arrayContaining([{ actionId: pluginActionId, input: { source: 'F8 nested consent' } }]),
      }),
    })]));
  }, 0);
});
