import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chromium, expect as uiExpect, type Browser } from '@playwright/test';

import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { TeamInvitationAcceptResultV1Schema, TeamInvitationCreateResultV1Schema } from '@happier-dev/protocol/teams/invitation';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowRunGetResultV1Schema,
  WorkflowRunListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalQueueListResultV1Schema, ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { WorkflowEventsListOutputV1Schema } from '@happier-dev/protocol/actions/specs/workflowEvents';
import { AutomationEligibleEventCatalogEntryV1Schema } from '@happier-dev/protocol/daemon/automationEligibleEvents';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/automationEventSetupResultV1';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { healthResultProjectionPageSchema } from '../../../plugins/machine-services/src/healthResultProjection';
import { HEALTH_RESULTS_ACTION_ID } from '../../../plugins/machine-services/src/actionIds';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { createOwnServerDockerBoundary } from '../../../../apps/cli/src/deployments/targets/ownServer/ownServerDeployment.testkit';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { prepareAutomationsEverywhereDeployment } from '../../src/testkit/automationsEverywhereDeployment';
import { hasAutomaticCheckPhase } from '../../src/testkit/automationPending';
import { waitFor } from '../../src/testkit/timing';
import { fetchJson } from '../../src/testkit/http';
import { connectStdioMcp, parseToolJson, type ExternalMcpClient, type ExternalMcpTransport } from '../../src/testkit/externalMcp';
import { repoRootDir } from '../../src/testkit/paths';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import { gotoDomContentLoadedWithRetries, waitForAuthenticatedRouteUi } from '../../src/testkit/uiE2e/pageNavigation';
import { installExternalTicketAutomationFixture } from '../../src/testkit/pluginPlatform/externalTicketAutomationFixture';

// PROGRAM §8, Plan 04 U6. V writes this journey; D consumes it. The first
// missing producer stops this single journey rather than masking later legs.
describe('Automations everywhere: composed ship journey', () => {
  let fixture: TeamSetupFFixture | undefined;
  let healthEndpoint: ReturnType<typeof createServer> | undefined;
  let ui: StartedUiWeb | undefined;
  let browser: Browser | undefined;
  let mcp: Readonly<{ client: ExternalMcpClient; transport: ExternalMcpTransport }> | undefined;
  afterEach(async () => {
    await mcp?.client.close();
    await mcp?.transport.close();
    mcp = undefined;
    await browser?.close();
    browser = undefined;
    await ui?.stop();
    ui = undefined;
    await fixture?.stop();
    fixture = undefined;
    if (healthEndpoint) await new Promise<void>((resolve, reject) =>
      healthEndpoint!.close(error => error ? reject(error) : resolve()));
    healthEndpoint = undefined;
  }, 0);

  it('AE.journey shares defaults, checks actor deploys, and authors from live Events', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ae-journey-'));
    const toolsDir = join(testDir, 'tools');
    const docker = await createOwnServerDockerBoundary(toolsDir);
    fixture = await startTeamSetupFFixture({ testDir,
      dbProvider: 'postgres', observeActionRequests: true,
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const a = await fixture.createAccount('A');
    const b = await fixture.createAccount('B');
    await fixture.claimHomeOwner(a);
    const bMachine = await fixture.enrollDaemon(b, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      PATH: `${toolsDir}${delimiter}${process.env.PATH ?? ''}` } });
    await fixture.assertKnownGoodSessionControl(b, bMachine);

    const createdTeam = await a.executeAsPerson('teams.create', { v: 1, initialOwnerAccountId: readAccountIdFromToken(a.credentials.token), name: 'Release team', requestKey: randomUUID() });
    expect(createdTeam.ok, JSON.stringify(createdTeam)).toBe(true);
    if (!createdTeam.ok) throw new Error(`Team creation: ${createdTeam.errorCode}`);
    const team = TeamSummaryV1Schema.parse(createdTeam.result);
    const invitation = await a.executeAsPerson('teams.invitations.create', { v: 1, teamId: team.id,
      role: 'admin', historyAccess: 'from_membership', recipientEmail: null, requestKey: randomUUID() });
    expect(invitation).toMatchObject({ ok: true });
    if (!invitation.ok) throw new Error(`Invitation: ${invitation.errorCode}`);
    const { joinUrl } = TeamInvitationCreateResultV1Schema.parse(invitation.result);
    if (!joinUrl) throw new Error('Invitation has no join URL');
    const joined = await b.executeAsPerson('teams.invitations.accept', { v: 1, token: new URL(joinUrl).pathname.split('/').at(-1) });
    expect(joined).toMatchObject({ ok: true });
    if (!joined.ok) throw new Error(`Team join: ${joined.errorCode}`);
    TeamInvitationAcceptResultV1Schema.parse(joined.result);

    const created = await a.executeReviewed('projects.sources.create', { serverId: fixture.serverId,
      name: 'P', requestKey: randomUUID() });
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error(`Project creation: ${created.errorCode}`);
    const source = ProjectSourcesReadOutputV1Schema.parse(created.result);
    if (!source.ok) throw new Error(`Project creation: ${source.error}`);
    const moved = await a.executeReviewed('projects.sources.update', { serverId: fixture.serverId,
      sourceId: source.source.id, expectedRevision: source.source.revision,
      patch: { owner: { kind: 'team', teamId: team.id } } });
    expect(moved).toMatchObject({ ok: true });
    if (!moved.ok) throw new Error(`Move to Team: ${moved.errorCode}`);
    const shared = ProjectSourcesReadOutputV1Schema.parse(moved.result);
    if (!shared.ok) throw new Error(`Move to Team: ${shared.error}`);

    const profile = await a.executeAsPerson('actions.policy.set', { profileChange: {
      kind: 'create', profile: { name: 'Release approvals' },
    } });
    expect(profile).toMatchObject({ ok: true });
    if (!profile.ok) throw new Error(`Profile creation: ${profile.errorCode}`);
    const result = ActionPolicyOutputSchemas['actions.policy.set'].parse(profile.result);
    if (!('profileChange' in result) || !('id' in result.profileChange)
      || typeof result.profileChange.id !== 'string') {
      throw new Error('Profile create did not return its Artifact identity');
    }
    const profileId = result.profileChange.id;
    const granted = await a.executeReviewed('artifact.access.grants.set', { artifactId: profileId,
      principal: { kind: 'team', teamId: team.id }, accessLevel: 'view' });
    expect(granted).toMatchObject({ ok: true });
    const changed = await a.executeReviewed('projects.sources.update', { serverId: fixture.serverId,
      sourceId: shared.source.id, expectedRevision: shared.source.revision,
      patch: { sessionDefaults: { expectedRevision: 'absent', defaults: { approvalProfileId: profileId } } } });
    // D16: this must be admitted at the Project Source owner, never saved as
    // A's personal preference or accepted only in a renderer's local state.
    expect(changed).toMatchObject({ ok: true });
    if (!changed.ok) throw new Error(`Project default: ${changed.errorCode}`);
    const readByB = await b.execute('projects.sources.read', { serverId: fixture.serverId, sourceId: shared.source.id });
    expect(readByB).toMatchObject({ ok: true, result: {
      sessionDefaults: { defaults: { approvalProfileId: profileId } },
    } });
    // C9/D16: B chooses the same shared Artifact identity through the public
    // profile read, rather than receiving an A-only default that B cannot use.
    const choices = await b.execute('actions.policy.get', { profiles: true }, { surface: 'mcp', authority: 'account_automation' });
    expect(choices).toMatchObject({ ok: true });
    if (!choices.ok) throw new Error(`Member profile discovery: ${choices.errorCode}`);
    const listedProfiles = ActionPolicyOutputSchemas['actions.policy.get'].parse(choices.result);
    if (!('profiles' in listedProfiles)) throw new Error('Profile discovery returned an Action policy row');
    expect(listedProfiles.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: profileId })]));

    const opened = await b.execute('session.spawn_new', {
      executionTarget: bMachine.target,
      directory: { kind: 'path', path: bMachine.workspaceDir },
      projectContext: { sourceRef: { serverId: fixture.serverId, sourceId: shared.source.id } },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      terminal: { mode: 'plain' },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(`Session on P: ${opened.errorCode}`);
    const session = SessionSpawnNewActionResultV1Schema.parse(opened.result);
    expect(session.type).toBe('success');
    if (session.type !== 'success') throw new Error('Session on P did not start');
    expect(await b.readSessionMetadata(session.sessionId)).toMatchObject({
      approvalProfileId: profileId, approvalProfileTeamOrGroupDerived: true,
      machineId: bMachine.target.machineId,
    });

    expect(await b.execute('machines.access.grant.set', { ...bMachine.target,
      principal: { kind: 'account', accountId: readAccountIdFromToken(a.credentials.token) }, level: 'manage' }))
      .toMatchObject({ ok: true });
    const deployInput = await prepareAutomationsEverywhereDeployment({ serverId: fixture.serverId,
      projectSourceId: shared.source.id, name: 'Production', protection: 'production', machine: bMachine, docker,
      invoke: async (actionId, input) => {
        const result = await a.execute(actionId, input, { presentUserConfirmation: { actionId } });
        expect(result.ok, actionId).toBe(true);
        if (!result.ok) throw new Error(`${actionId}: ${result.errorCode}`);
        return result.result;
      } });
    const createdChecks = await a.executeReviewed('workflow.definition.create', { definitionId: randomUUID(),
      metadata: { title: 'Release checks' }, definition: { version: 1, blocks: [
        { kind: 'action', id: 'release-check', actionId: 'machines.command.run', input: {
          command: { kind: 'literal', value: process.platform === 'win32'
            ? 'if exist .release-check-passed (exit /b 0) else (exit /b 7)'
            : 'test -f .release-check-passed' },
        } },
      ] } });
    expect(createdChecks.ok).toBe(true);
    if (!createdChecks.ok) throw new Error(createdChecks.errorCode);
    const checks = WorkflowDefinitionCreateResultV1Schema.parse(createdChecks.result);
    expect(await a.executeReviewed('artifact.access.grants.set', { artifactId: checks.definitionId,
      principal: { kind: 'team', teamId: team.id }, accessLevel: 'view' })).toMatchObject({ ok: true });
    const linked = await a.executeReviewed('workflow.trigger.add', { workflow: checks.definitionId, visibleTeamId: team.id,
      project: { machineId: bMachine.target.machineId, directory: bMachine.workspaceDir },
      trigger: { kind: 'action', phase: 'before', mode: 'wait', onFailure: 'ask', enabled: true,
        actionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1], subject: { kind: 'environment',
          serverId: fixture.serverId, environmentId: deployInput.environmentId } } });
    expect(linked.ok).toBe(true);
    if (!linked.ok) throw new Error(linked.errorCode);
    const trigger = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
    mcp = await connectStdioMcp({ command: process.execPath,
      args: [join(repoRootDir(), 'apps/cli/src/index.ts'), 'mcp', 'serve', '--session', session.sessionId],
      env: { ...process.env, CI: '1', NODE_OPTIONS: fixture.sourceOptions,
        HAPPIER_HOME_DIR: bMachine.homeDir, HAPPIER_SERVER_URL: fixture.actionServerApiUrl },
    });
    const invokeDeploy = () => mcp!.client.callTool({ name: 'action_execute', arguments: {
      actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1, input: deployInput,
    } });
    const beginDeploy = async () => {
      // Observe the real pending card while a live executor may still own the
      // call. Waiting for the call before the human decision can deadlock Ask.
      const invocation = invokeDeploy();
      let reply: Awaited<typeof invocation> | undefined;
      let failure: unknown;
      void invocation.then(value => { reply = value; }, error => { failure = error; });
      let artifactId: string | undefined;
      await waitFor(async () => {
        if (failure) throw failure;
        if (reply) {
          expect(reply.isError).not.toBe(true);
          artifactId = ActionApprovalRequestCreatedResultSchema.parse(parseToolJson(reply)).artifactId;
          return true;
        }
        const listed = await b.execute('approval.request.list', { status: 'open', actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1 });
        expect(listed.ok).toBe(true);
        if (!listed.ok) throw new Error(listed.errorCode);
        artifactId = ApprovalQueueListResultV1Schema.parse(listed.result).items[0]?.artifactId;
        return artifactId !== undefined;
      }, { failFast: true, context: 'B agent deployment exposes its pending approval' });
      if (!artifactId) throw new Error('Deployment approval is unavailable');
      return { artifactId, invocation };
    };
    const approval = async (artifactId: string) => {
      const read = await b.execute('approval.request.get', { artifactId });
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error(read.errorCode);
      return ApprovalRequestGetResultV1Schema.parse(read.result).request;
    };
    const pending = await beginDeploy();
    expect(hasAutomaticCheckPhase(await approval(pending.artifactId), 'consent')).toBe(true);
    expect(await b.execute('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve',
      triggerConsent: { automationId: trigger.set.automationId, triggerId: trigger.triggerId, decision: 'allow' } }))
      .toMatchObject({ ok: true });
    await waitFor(async () => hasAutomaticCheckPhase(await approval(pending.artifactId), 'override'),
      { failFast: true, context: 'Release checks fail on the acting Machine and request a human override' });
    const failedCheck = await approval(pending.artifactId);
    expect(failedCheck).toMatchObject({ automaticChecks: { results: [
      expect.objectContaining({ outcome: 'failed', reason: expect.any(String) }),
    ] } });
    if (!('automaticChecks' in failedCheck) || !failedCheck.automaticChecks) throw new Error('Missing check results');
    const failedReason = failedCheck.automaticChecks.results.find(result => result.outcome === 'failed')?.reason;
    expect(failedReason).toEqual(expect.any(String));
    if (!failedReason) throw new Error('Failed Release checks have no safe reason');
    const actorRuns = await b.execute('workflow.run.list', { sourceArtifactId: checks.definitionId, starter: 'current_account' });
    expect(actorRuns.ok).toBe(true);
    if (!actorRuns.ok) throw new Error(actorRuns.errorCode);
    const runs = WorkflowRunListResultV1Schema.parse(actorRuns.result).runs;
    expect(runs).toHaveLength(1);
    const checkRunId = runs[0]!.id;
    const checkRun = await b.execute('workflow.run.get', { runId: checkRunId });
    expect(checkRun.ok).toBe(true);
    if (!checkRun.ok) throw new Error(checkRun.errorCode);
    expect(WorkflowRunGetResultV1Schema.parse(checkRun.result).acceptedContext.machineId).toBe(bMachine.target.machineId);
    expect(await a.execute('workflow.run.get', { runId: checkRunId })).toMatchObject({ ok: false, errorCode: 'run_not_found' });
    expect(await b.execute('approval.request.decide', { artifactId: pending.artifactId, decision: 'reject' }))
      .toMatchObject({ ok: true });
    expect(await approval(pending.artifactId)).toMatchObject({ status: 'rejected' });
    const deniedReply = await pending.invocation;
    const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(parseToolJson(deniedReply));
    if (!deferred.success) {
      expect(deniedReply.isError).toBe(true);
      expect(parseToolJson(deniedReply)).toMatchObject({ errorCode: 'approval_rejected' });
    }
    const agentRead = await mcp.client.callTool({ name: 'action_execute', arguments: {
      actionId: 'approval.request.get', input: { artifactId: pending.artifactId },
    } });
    expect(agentRead.isError).not.toBe(true);
    expect(ApprovalRequestGetResultV1Schema.parse(parseToolJson(agentRead)).request)
      .toMatchObject({ status: 'rejected', automaticChecks: { results: [
        expect.objectContaining({ outcome: 'failed', reason: failedReason }),
      ] } });
    expect((await docker.readInvocations()).filter(call => call.args[0] === 'compose' && call.args.includes('up'))).toEqual([]);

    await writeFile(join(bMachine.workspaceDir, '.release-check-passed'), 'fixed');
    const retried = await beginDeploy();
    expect(await b.execute('approval.request.decide', { artifactId: retried.artifactId, decision: 'approve' }))
      .toMatchObject({ ok: true });
    await waitFor(async () => (await approval(retried.artifactId)).status === 'executed',
      { failFast: true, context: 'Passing Release checks settle B agent deployment' });
    expect(await approval(retried.artifactId)).toMatchObject({ execution: { ok: true } });
    await retried.invocation;
    await waitFor(async () => (await docker.readInvocations())
      .filter(call => call.args[0] === 'compose' && call.args.includes('up')).length === 1,
    { failFast: true, context: 'Deliberate retry passes Release checks and deploys exactly once' });

    // R5: observe the deployment owner's settled receipt Event. An immediate
    // after-Action return must never stand in for a failed deployment.
    const catalog = await b.execute('workflow.events.list', bMachine.target);
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) throw new Error(catalog.errorCode);
    const failedEvent = DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed;
    const selected = AutomationEligibleEventCatalogEntryV1Schema.parse(
      WorkflowEventsListOutputV1Schema.parse(catalog.result).events.find(row =>
        row.event.identity.pluginId === failedEvent.pluginId && row.event.identity.localId === failedEvent.localId));
    expect(selected.observationBinding).toBeDefined();
    if (!selected.observationBinding) throw new Error('Deployment failure Event has no observer assignment');
    const setup = await b.execute('action.invoke', { action: selected.setupAction.identity,
      expectedContributorOccurrenceId: selected.setupAction.occurrenceId,
      input: { v: 1, serverId: fixture.serverId, environmentId: deployInput.environmentId } },
    { presentUserConfirmation: { actionId: 'action.invoke' }, externalActionTarget: {
      kind: 'machine', machineId: bMachine.target.machineId,
      project: { machineId: bMachine.target.machineId, directory: bMachine.workspaceDir },
    } });
    expect(setup.ok).toBe(true);
    if (!setup.ok) throw new Error(setup.errorCode);
    const configured = PluginEventAutomationSetupResultV1Schema.parse(setup.result);
    const diagnosis = await b.execute('workflow.trigger.add', {
      name: 'Diagnose failed Production deployment',
      target: { kind: 'inline', definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'diagnose', document: {
          text: 'Diagnose the failed Production deployment.', references: [], attachments: [],
        }, input: [], result: { kind: 'text' } }],
      } },
      project: { machineId: bMachine.target.machineId, directory: bMachine.workspaceDir },
      trigger: { kind: 'pluginEvent', enabled: true, eventRef: selected.event.identity,
        sourceInstanceId: configured.sourceInstanceId, sourceContractVersion: configured.sourceContractVersion,
        sourceConfig: configured.sourceConfig, displayLabel: configured.displayLabel,
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: selected.observationBinding.materializationRef },
        filter: null, maximumObservationAgeMs: null },
    });
    expect(diagnosis.ok).toBe(true);
    if (!diagnosis.ok) throw new Error(diagnosis.errorCode);
    const diagnoseTrigger = WorkflowTriggerWriteResultV1Schema.parse(diagnosis.result);
    const automationRuns = async (automationId: string, owner = b) => {
      const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}/v3/automations/${encodeURIComponent(automationId)}/runs`, {
        headers: { Authorization: `Bearer ${owner.credentials.token}`,
          ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
      });
      expect(response.status).toBe(200);
      return AutomationV3RunListResponseSchema.parse(response.data).runs;
    };
    const diagnoseRuns = () => automationRuns(diagnoseTrigger.set.automationId);
    expect(await diagnoseRuns()).toEqual([]);
    await docker.setActivationCommandFailure(true);
    const forced = await beginDeploy();
    expect(await b.execute('approval.request.decide', { artifactId: forced.artifactId, decision: 'approve' }))
      .toMatchObject({ ok: true });
    await forced.invocation;
    await waitFor(async () => {
      const runs = await diagnoseRuns();
      expect(runs.length).toBeLessThanOrEqual(1);
      return runs.length === 1 && typeof runs[0]!.producedSessionId === 'string';
    }, { failFast: true, context: 'Forced deployment failure starts one receipt-caused diagnose Session' });
    expect((await diagnoseRuns())[0]!.cause).toMatchObject({ kind: 'trigger', triggerKind: 'pluginEvent',
      triggerId: diagnoseTrigger.triggerId, evidence: { eventRef: failedEvent } });

    // D9: an omitted subject listens to saved health failures across A's
    // resources. Only the external HTTP endpoint is substituted.
    let healthy = true;
    healthEndpoint = createServer((_request, response) => {
      response.statusCode = healthy ? 200 : 503;
      response.end();
    });
    await new Promise<void>(resolve => healthEndpoint!.listen(0, '127.0.0.1', resolve));
    const healthAddress = healthEndpoint.address();
    if (!healthAddress || typeof healthAddress === 'string') throw new Error('Health endpoint unavailable');
    const aMachine = await fixture.enrollDaemon(a, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      PATH: `${toolsDir}${delimiter}${process.env.PATH ?? ''}` } });
    const ops = await fixture.assertKnownGoodSessionControl(a, aMachine);
    expect(await a.execute('session.title.set', { sessionId: ops.sessionId, title: '#ops' }))
      .toMatchObject({ ok: true });
    await docker.setActivationCommandFailure(false);
    const aSourceResult = await a.executeReviewed('projects.sources.create', { serverId: fixture.serverId,
      name: 'A health project', requestKey: randomUUID() });
    expect(aSourceResult.ok).toBe(true);
    if (!aSourceResult.ok) throw new Error(aSourceResult.errorCode);
    const aSource = ProjectSourcesReadOutputV1Schema.parse(aSourceResult.result);
    if (!aSource.ok) throw new Error(aSource.error);
    const aEnvironment = await prepareAutomationsEverywhereDeployment({ serverId: fixture.serverId,
      projectSourceId: aSource.source.id, name: 'A health environment', machine: aMachine, docker,
      invoke: async (actionId, input) => {
        const result = await a.execute(actionId, input, { presentUserConfirmation: { actionId } });
        expect(result.ok, actionId).toBe(true);
        if (!result.ok) throw new Error(result.errorCode);
        return result.result;
      } });
    const aCatalog = await a.execute('workflow.events.list', aMachine.target);
    expect(aCatalog.ok).toBe(true);
    if (!aCatalog.ok) throw new Error(aCatalog.errorCode);
    const healthEvent = AutomationEligibleEventCatalogEntryV1Schema.parse(
      WorkflowEventsListOutputV1Schema.parse(aCatalog.result).events.find(row =>
        row.event.identity.pluginId === HEALTH_CHECK_EVENT_REFS_V1.failed.pluginId
        && row.event.identity.localId === HEALTH_CHECK_EVENT_REFS_V1.failed.localId));
    if (!healthEvent.observationBinding) throw new Error('Health observer assignment unavailable');
    const invokeHealth = async (localId: string, input: unknown) => {
      const result = await a.execute('action.invoke', { action: { pluginId: healthEvent.event.identity.pluginId, localId }, input },
        { presentUserConfirmation: { actionId: 'action.invoke' }, externalActionTarget: {
          kind: 'machine', machineId: aMachine.target.machineId,
          project: { machineId: aMachine.target.machineId, directory: aMachine.workspaceDir },
        } });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      return result.result;
    };
    const savedHealth = PluginEventAutomationSetupResultV1Schema.parse(await invokeHealth('health/setup', {
      v: 1, subject: { kind: 'environment', environmentId: aEnvironment.environmentId },
      checks: [{ checkId: 'external', kind: { pluginId: healthEvent.event.identity.pluginId, localId: 'http' },
        binding: { kind: 'healthCheck' }, config: { endpoint: `http://127.0.0.1:${healthAddress.port}`, expectStatus: 200 },
        periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }],
    }));
    const transport = { kind: 'checkpointedPull' as const,
      watcherMaterializationRef: healthEvent.observationBinding.materializationRef };
    expect(await a.executeReviewed('workflow.trigger.add', { observationOnly: { kind: 'observationOnly' },
      trigger: { kind: 'pluginEvent', enabled: true, eventRef: HEALTH_CHECK_EVENT_REFS_V1.status,
        sourceInstanceId: savedHealth.sourceInstanceId, sourceContractVersion: savedHealth.sourceContractVersion,
        sourceConfig: savedHealth.sourceConfig, displayLabel: savedHealth.displayLabel,
        observationTransport: transport, filter: null, maximumObservationAgeMs: null } }))
      .toMatchObject({ ok: true });
    const anyHealth = PluginEventAutomationSetupResultV1Schema.parse(await invokeHealth(healthEvent.setupAction.identity.localId,
      { v: 1, serverId: fixture.serverId }));
    const notification = 'A saved health check failed; investigate in #ops.';
    const notify = await a.executeReviewed('workflow.trigger.add', {
      name: 'Any health check fails → message #ops',
      target: { kind: 'inline', definition: { version: 1, blocks: [{ kind: 'action', id: 'notify-ops',
        actionId: 'session.message.send', input: { sessionId: { kind: 'literal', value: ops.sessionId },
          message: { kind: 'literal', value: notification } } }] } },
      project: { machineId: aMachine.target.machineId, directory: aMachine.workspaceDir },
      trigger: { kind: 'pluginEvent', enabled: true, eventRef: healthEvent.event.identity,
        sourceInstanceId: anyHealth.sourceInstanceId, sourceContractVersion: anyHealth.sourceContractVersion,
        sourceConfig: anyHealth.sourceConfig, displayLabel: anyHealth.displayLabel,
        observationTransport: transport, filter: null, maximumObservationAgeMs: null },
    });
    expect(notify.ok).toBe(true);
    if (!notify.ok) throw new Error(notify.errorCode);
    const notifyTrigger = WorkflowTriggerWriteResultV1Schema.parse(notify.result);
    const notifyRuns = () => automationRuns(notifyTrigger.set.automationId, a);
    const retainedHealth = async (status: 'up' | 'down', after = 0) => {
      let cursor: string | undefined;
      do {
        const page = healthResultProjectionPageSchema.parse(await invokeHealth(HEALTH_RESULTS_ACTION_ID, cursor ? { cursor } : {}));
        if (page.items.some(item => item.source?.sourceInstanceId === savedHealth.sourceInstanceId
          && item.projection.checks.some(check => check.checkId === 'external'
            && check.result.status === status && check.result.observedAt > after))) return true;
        cursor = page.nextCursor;
      } while (cursor);
      return false;
    };
    await waitFor(() => retainedHealth('up'), { context: 'A healthy observation is saved before the failure' });
    expect(await notifyRuns()).toEqual([]);
    healthy = false;
    await waitFor(async () => {
      const runs = await notifyRuns();
      expect(runs.length).toBeLessThanOrEqual(1);
      return runs.length === 1 && runs[0]!.state === 'succeeded';
    }, { failFast: true, context: 'An omitted health subject sends one message to #ops' });
    const delivered = await a.execute('session.events.get', { sessionId: ops.sessionId });
    expect(delivered).toMatchObject({ ok: true, result: { ok: true,
      items: expect.arrayContaining([expect.objectContaining({ text: notification })]) } });
    const deliveredAt = Date.now();
    await waitFor(() => retainedHealth('down', deliveredAt), { context: 'Repeated down observation does not repeat the transition' });
    expect(await notifyRuns()).toHaveLength(1);

    // D13 and §8.6 use the actual public plugin host and both Events hosts.
    // UI and server stay source-loaded on this runner's disposable fixture.
    const storageScope = `ae-journey-${randomUUID()}`;
    ui = await startUiWeb({ testDir: join(testDir, 'ui'), env: { ...process.env,
      EXPO_PUBLIC_DEBUG: '1', EXPO_PUBLIC_HAPPY_SERVER_URL: fixture.server.baseUrl,
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: storageScope, HAPPIER_E2E_UI_WEB_MODE: 'metro',
      HAPPIER_E2E_UI_WEB_NO_DEV: '0' } });
    browser = await chromium.launch();
    const aPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await installAuthBootstrapStorageSnapshot(aPage, buildAuthBootstrapStorageSnapshot({
      serverUrl: fixture.server.baseUrl, serverIdentityId: fixture.serverId,
      auth: a.auth, mode: 'dataKey', storageScope,
    }));
    await gotoDomContentLoadedWithRetries(aPage, `${ui.baseUrl}/settings/features`);
    await waitForAuthenticatedRouteUi({ page: aPage, expectedPathname: '/settings/features',
      requiredTestIds: ['settings-feature-experiments-toggle'] });
    for (const testId of ['settings-feature-experiments-toggle', 'settings-feature-toggle-automations']) {
      const toggle = aPage.getByTestId(testId);
      await uiExpect(toggle).toBeVisible();
      if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
      await uiExpect(toggle).toHaveAttribute('aria-checked', 'true');
    }
    const ticket = await installExternalTicketAutomationFixture({ testDir,
      uiBaseUrl: ui.baseUrl, daemon: aMachine.daemon }, 'fixture.external-authoring');
    const ticketWorkflowResult = await a.executeReviewed('workflow.definition.create', { definitionId: randomUUID(),
      metadata: { title: 'Ticket review' }, definition: { version: 1, blocks: [{ kind: 'action', id: 'review',
        actionId: 'actions.policy.get', input: { profiles: { kind: 'literal', value: true } } }] } });
    expect(ticketWorkflowResult.ok).toBe(true);
    if (!ticketWorkflowResult.ok) throw new Error(ticketWorkflowResult.errorCode);
    const ticketWorkflow = WorkflowDefinitionCreateResultV1Schema.parse(ticketWorkflowResult.result);
    await gotoDomContentLoadedWithRetries(aPage, ticket.pageUrl);
    await aPage.getByTestId('external-ticket-picker').click();
    await aPage.getByRole('option', { name: 'Fix the checkout', exact: true }).click();
    const section = aPage.getByTestId('external-ticket-automations');
    await uiExpect(section).toBeVisible();
    await section.getByRole('button', { name: 'Link workflow', exact: true }).click();
    await aPage.getByPlaceholder('Find a workflow').fill('Ticket review');
    await aPage.getByText('Ticket review', { exact: true }).last().click();
    await aPage.getByRole('menuitem', { name: /^Before.*Action$/i }).click();
    await aPage.getByRole('button', { name: 'Action', exact: true }).click();
    await aPage.getByRole('option', { name: 'Close ticket', exact: true }).click();
    await aPage.getByRole('button', { name: 'Link', exact: true }).click();
    const readTicketTriggers = async () => {
      const result = await a.execute('workflow.trigger.list', { workflow: ticketWorkflow.definitionId });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      return WorkflowTriggerListResultV1Schema.parse(result.result).sets;
    };
    await waitFor(async () => (await readTicketTriggers()).length === 1,
      { context: 'Public plugin section links the before-Action trigger' });
    const ticketSet = (await readTicketTriggers())[0]!;
    expect(ticketSet.triggers).toContainEqual(expect.objectContaining({ kind: 'action', phase: 'before',
      actionIds: [ticket.closeActionId], subject: { kind: 'plugin', serverId: fixture.serverId,
        pluginId: ticket.pluginId, subjectKindId: ticket.subjectKindId, identity: { ticketId: ticket.ticketId } } }));
    await aPage.getByTestId('external-ticket-close').click();
    await waitFor(async () => {
      const runs = await automationRuns(ticketSet.automationId, a);
      expect(runs.length).toBeLessThanOrEqual(1);
      return runs.length === 1 && runs[0]!.state === 'succeeded';
    }, { failFast: true, context: 'Public plugin Action runs its qualified before-trigger' });

    await gotoDomContentLoadedWithRetries(aPage, `${ui.baseUrl}/workflows`);
    await aPage.getByTestId('workflows-column:view:events').click();
    await uiExpect(aPage.getByText(healthEvent.event.title, { exact: true }).last()).toBeVisible();
    await uiExpect(aPage.getByText('Close ticket', { exact: true }).last()).toBeVisible();
    const bPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await installAuthBootstrapStorageSnapshot(bPage, buildAuthBootstrapStorageSnapshot({
      serverUrl: fixture.server.baseUrl, serverIdentityId: fixture.serverId,
      auth: b.auth, mode: 'dataKey', storageScope,
    }));
    await gotoDomContentLoadedWithRetries(bPage, `${ui.baseUrl}/settings/features`);
    await waitForAuthenticatedRouteUi({ page: bPage, expectedPathname: '/settings/features',
      requiredTestIds: ['settings-feature-experiments-toggle'] });
    for (const testId of ['settings-feature-experiments-toggle', 'settings-feature-toggle-automations']) {
      const toggle = bPage.getByTestId(testId);
      await uiExpect(toggle).toBeVisible();
      if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
      await uiExpect(toggle).toHaveAttribute('aria-checked', 'true');
    }
    await gotoDomContentLoadedWithRetries(bPage, `${ui.baseUrl}/workflows`);
    await bPage.getByTestId('workflows-column:view:events').click();
    await uiExpect(bPage.getByText(selected.event.title, { exact: true }).last()).toBeVisible();
    const draftResult = await b.execute('workflow.definition.create', { definitionId: randomUUID(),
      metadata: { title: 'Production response' }, definition: { version: 1, blocks: [{ kind: 'action', id: 'response',
        actionId: 'actions.policy.get', input: { profiles: { kind: 'literal', value: true } } }] } });
    expect(draftResult.ok).toBe(true);
    if (!draftResult.ok) throw new Error(draftResult.errorCode);
    const draftWorkflow = WorkflowDefinitionCreateResultV1Schema.parse(draftResult.result);
    const readDraftTriggers = async () => {
      const result = await b.execute('workflow.trigger.list', { workflow: draftWorkflow.definitionId });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      return WorkflowTriggerListResultV1Schema.parse(result.result).sets;
    };
    expect(await readDraftTriggers()).toEqual([]);
    await gotoDomContentLoadedWithRetries(bPage, `${ui.baseUrl}/workflows/${draftWorkflow.definitionId}`);
    await bPage.getByRole('button', { name: 'Live events', exact: true }).click();
    const companion = bPage.getByRole('complementary', { name: 'Live events', exact: true });
    await uiExpect(companion).toBeVisible();
    await companion.getByText(selected.event.title, { exact: true }).last().click();
    await bPage.getByRole('button', { name: 'Add to this workflow', exact: true }).click();
    const draftTrigger = bPage.locator('[data-testid^="workflow-editor-trigger:"]')
      .filter({ has: bPage.locator('[data-testid$="-starts"]') });
    await uiExpect(draftTrigger).toHaveCount(1);
    expect(await readDraftTriggers()).toEqual([]);
    await bPage.getByTestId('workflow-editor-undo').click();
    await uiExpect(draftTrigger).toHaveCount(0);
    expect(await readDraftTriggers()).toEqual([]);
    await bPage.getByTestId('workflow-editor-redo').click();
    await uiExpect(draftTrigger).toHaveCount(1);
    await bPage.getByTestId('workflow-editor-save').click();
    await waitFor(async () => (await readDraftTriggers()).flatMap(set => set.triggers).length === 1,
      { context: 'Only Save persists the Event trigger added to the mounted draft' });
  }, 0);
});
