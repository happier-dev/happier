import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { ActionApprovalRequestCreatedResultSchema, createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createCredentialedAccountArtifactStore } from '../../../../apps/cli/src/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import type { TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { startAutomationsEverywhereDeploymentFixture } from '../../src/testkit/automationsEverywhereDeployment';
import { connectStdioMcp, parseToolJson } from '../../src/testkit/externalMcp';
import { repoRootDir } from '../../src/testkit/paths';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';
import { createIsolatedFakeClaudeControlShim } from '../../src/testkit/fakeClaude';

describe('Shared approval profiles', () => {
  let fixture: TeamSetupFFixture | undefined;
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  let mcp: Awaited<ReturnType<typeof connectStdioMcp>> | undefined;
  afterEach(async () => {
    try {
      await mcp?.client.close();
      await mcp?.transport.close();
      await ui?.close();
    } finally { mcp = undefined; ui = undefined; await fixture?.stop(); fixture = undefined; }
  }, 0);

  it('AE.P03.F1-own-profile stores the profile in an Artifact, edits by revision and refuses generic writes', async () => {
    const agent = await createIsolatedFakeClaudeControlShim({
      testDir: await mkdtemp(join(tmpdir(), 'ae-p03-profile-agent-')),
      invocationId: 'own-approval-profile', captureEnvironmentKeys: [], logFullStdin: false,
    });
    const deployment = await startAutomationsEverywhereDeploymentFixture(await mkdtemp(join(tmpdir(), 'ae-p03-profile-')),
      { daemonEnv: { HAPPIER_CLAUDE_PATH: agent.executablePath } });
    fixture = deployment.fixture;
    const { actor: owner, machine, deployInput, docker } = deployment;
    const session = await fixture.assertKnownGoodSessionControl(owner, machine);
    ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl,
      addressAnchorUrl: fixture.server.baseUrl, accountSecret: owner.auth.accountSigningSeed });
    await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machine.target.machineId), { timeoutMs: 60_000 });
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
      serverId: ui.serverId, actionCaller: { kind: 'host' as const } };
    const askProfile = { name: 'Deploy review', actions: { [DEPLOYMENT_DEPLOY_ACTION_ID_V1]: { approvalRequiredSurfaces: ['agent', 'mcp'] } } };
    const created = await ui.executeConfirmed('actions.policy.set', { profileChange: { kind: 'create', profile: askProfile } }, context);
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw createActionExecuteFailureError(created);
    const change = (created.result as { profileChange: { id: string; revision: { headerVersion: number; bodyVersion: number } } }).profileChange;
    expect(change.id).toBeTruthy();
    const document = await runWithServerHttpBaseUrl(fixture.actionServerApiUrl,
      () => createCredentialedAccountArtifactStore(owner.credentials).read(change.id));
    expect(document).toMatchObject({ artifactId: change.id, header: { kind: 'approval-profile.v1', name: askProfile.name },
      revision: change.revision });
    expect(typeof document?.body).toBe('string');
    expect(JSON.parse(document!.body as string)).toEqual({ kind: 'approval-profile.v1', profile: askProfile });
    const listed = await ui.execute('actions.policy.get', { profiles: true }, context);
    expect(listed).toMatchObject({ ok: true, result: { profiles: [{ id: change.id, profile: { name: 'Deploy review' }, access: 'owner' }] } });
    fixture.takeRequestObservations();
    const unchanged = await ui.executeConfirmed('actions.policy.set', { profileChange: { kind: 'update', id: change.id,
      expectedRevision: change.revision, profile: askProfile } }, context);
    expect(unchanged).toMatchObject({ ok: true, result: { profileChange: { revision: change.revision } } });
    expect(fixture.takeRequestObservations().filter(row => row.method !== 'GET' && row.path !== '/v1/artifacts/read'
      && /^\/v[12]\/(?:artifacts|account\/settings)(?:\/|\?|$)/u.test(row.path))).toEqual([]);
    for (const audience of ['agent', 'mcp'] as const) {
      const policy = await ui.executeConfirmed('actions.policy.set', { actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1, audience, mode: 'allowed' }, context);
      expect(policy, JSON.stringify(policy)).toMatchObject({ ok: true,
        result: { actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1, mode: 'allowed' } });
    }
    const stored = await fetchSessionV2(fixture.server.baseUrl, owner.credentials.token, session.sessionId);
    const picked = await ui.executeConfirmed('session.approval_profile.set', { sessionId: session.sessionId, serverId: fixture.serverId,
      expectedMetadataRevision: stored.metadataVersion, approvalProfileId: change.id }, context);
    expect(picked.ok, JSON.stringify(picked)).toBe(true);
    if (!picked.ok) throw createActionExecuteFailureError(picked);
    expect(await owner.readSessionMetadata(session.sessionId)).toMatchObject({
      approvalProfileId: change.id, approvalProfileTeamOrGroupDerived: false,
    });
    // --session only focuses a standalone host; the real Session MCP host owns its profile.
    const deploy = () => fixture!.executeSessionMcpAction(owner,
      { sessionId: session.sessionId, logPath: agent.logPath }, DEPLOYMENT_DEPLOY_ACTION_ID_V1, deployInput);
    const firstDeploy = await deploy();
    expect(firstDeploy.ok, JSON.stringify(firstDeploy)).toBe(true);
    if (!firstDeploy.ok) throw createActionExecuteFailureError(firstDeploy);
    const approvalId = ActionApprovalRequestCreatedResultSchema.parse(firstDeploy.result).artifactId;
    const activations = async () => (await docker.readInvocations()).filter(call => call.args[0] === 'compose' && call.args.includes('up'));
    expect(await activations()).toEqual([]);
    const rejected = await ui.executeConfirmed('approval.request.decide', { artifactId: approvalId, decision: 'reject' }, context);
    expect(rejected, JSON.stringify(rejected)).toMatchObject({ ok: true });
    fixture.takeRequestObservations();
    const edited = await ui.executeConfirmed('actions.policy.set', { profileChange: { kind: 'update', id: change.id,
      expectedRevision: change.revision, profile: { name: 'Deploy after review',
        actions: { [DEPLOYMENT_DEPLOY_ACTION_ID_V1]: { approvalRequiredSurfaces: [] } },
        approvalWaivedSurfaces: { [DEPLOYMENT_DEPLOY_ACTION_ID_V1]: ['agent', 'mcp'] } } } }, context);
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    if (!edited.ok) throw createActionExecuteFailureError(edited);
    const editedChange = (edited.result as { profileChange: { revision: { headerVersion: number; bodyVersion: number } } }).profileChange;
    expect(editedChange.revision.bodyVersion).toBeGreaterThan(change.revision.bodyVersion);
    await waitFor(async () => {
      const held = await fixture!.executeSessionMcpAction(owner,
        { sessionId: session.sessionId, logPath: agent.logPath }, 'actions.policy.get', { profiles: true });
      if (!held.ok) throw createActionExecuteFailureError(held);
      const heldPolicy = ActionPolicyOutputSchemas['actions.policy.get'].parse(held.result);
      expect('profiles' in heldPolicy).toBe(true);
      return 'profiles' in heldPolicy && heldPolicy.profiles.some(profile => profile.id === change.id
        && profile.revision.bodyVersion === editedChange.revision.bodyVersion
        && profile.revision.headerVersion === editedChange.revision.headerVersion);
    }, { context: 'Profile body edit reaches the real Session requester catalog through the change stream' });
    const allowedDeploy = await deploy();
    expect(allowedDeploy.ok, JSON.stringify(allowedDeploy)).toBe(true);
    if (!allowedDeploy.ok) throw createActionExecuteFailureError(allowedDeploy);
    expect(ActionApprovalRequestCreatedResultSchema.safeParse(allowedDeploy.result).success,
      JSON.stringify(allowedDeploy)).toBe(false);
    expect(await activations()).toHaveLength(1);
    expect(await ui.executeConfirmed('actions.policy.set', { profileChange: { kind: 'update', id: change.id,
      expectedRevision: change.revision, profile: { name: 'Stale overwrite' } } }, context))
      .toMatchObject({ ok: false, errorCode: 'currentness_conflict' });
    expect(await ui.execute('actions.policy.get', { profiles: true }, context))
      .toMatchObject({ ok: true, result: { profiles: [{ id: change.id, profile: { name: 'Deploy after review' } }] } });
    for (const audience of ['agent', 'mcp'] as const) {
      const updatePolicy = await ui.executeConfirmed('actions.policy.set', { actionId: 'artifact.update', audience, mode: 'allowed' }, context);
      expect(updatePolicy, JSON.stringify(updatePolicy)).toMatchObject({ ok: true, result: { actionId: 'artifact.update', mode: 'allowed' } });
      const deletePolicy = await ui.executeConfirmed('actions.policy.set', { actionId: 'artifact.delete', audience, mode: 'allowed' }, context);
      expect(deletePolicy, JSON.stringify(deletePolicy)).toMatchObject({ ok: true, result: { actionId: 'artifact.delete', mode: 'allowed' } });
    }
    // Generic Artifact writes remain host calls; they cannot mutate the profile's internal kind.
    mcp = await connectStdioMcp({ command: process.execPath,
      args: [resolve(repoRootDir(), 'apps/cli/src/index.ts'), 'mcp', 'serve'],
      env: { ...process.env, NODE_OPTIONS: fixture.sourceOptions, CI: '1', HAPPIER_HOME_DIR: machine.homeDir,
        HAPPIER_SERVER_URL: fixture.actionServerApiUrl } });
    const refused = await mcp.client.callTool({
      name: 'action_execute', arguments: { actionId: 'artifact.update', input: {
        artifactId: change.id, expectedRevision: editedChange.revision,
        header: { kind: 'approval-profile.v1', name: 'Generic overwrite', title: 'Generic overwrite' }, body: '{}',
      } } });
    expect(refused.isError).toBe(true);
    expect(parseToolJson(refused)).toMatchObject({ errorCode: 'artifact_kind_internal' });
    const deleted = await mcp.client.callTool({ name: 'action_execute', arguments: {
      actionId: 'artifact.delete', input: { artifactId: change.id, expectedRevision: editedChange.revision },
    } });
    expect(deleted.isError).toBe(true);
    expect(parseToolJson(deleted)).toMatchObject({ errorCode: 'artifact_kind_internal' });
  }, 0);
});
