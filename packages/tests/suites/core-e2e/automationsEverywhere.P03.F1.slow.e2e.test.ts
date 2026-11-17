import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectUiActionClient } from '@happier-tests/ui-action-client';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createCredentialedAccountArtifactStore } from '../../../../apps/cli/src/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import type { TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { startAutomationsEverywhereDeploymentFixture } from '../../src/testkit/automationsEverywhereDeployment';
import { connectStdioMcp, parseToolJson } from '../../src/testkit/externalMcp';
import { repoRootDir } from '../../src/testkit/paths';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

describe('Shared approval profiles', () => {
  let fixture: TeamSetupFFixture | undefined;
  let ui: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
  let mcp: Awaited<ReturnType<typeof connectStdioMcp>> | undefined;
  afterEach(async () => {
    try {
      await mcp?.client.close();
      await mcp?.transport.close();
      await ui?.close();
    } finally { mcp = undefined; ui = undefined; await fixture?.stop(); fixture = undefined; }
  }, 0);

  it('AE.P03.F1-own-profile stores the profile in an Artifact, edits by revision and refuses generic writes', async () => {
    const deployment = await startAutomationsEverywhereDeploymentFixture(await mkdtemp(join(tmpdir(), 'ae-p03-profile-')));
    fixture = deployment.fixture;
    const { actor: owner, machine, deployInput, docker } = deployment;
    const session = await fixture.assertKnownGoodSessionControl(owner, machine);
    ui = await connectUiActionClient({ serverUrl: fixture.actionServerApiUrl, addressAnchorUrl: fixture.server.baseUrl, credentials: owner.uiCredentials });
    await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machine.target.machineId), { timeoutMs: 60_000 });
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
      serverId: ui.serverId, actionCaller: { kind: 'host' as const } };
    const askProfile = { name: 'Deploy review', actions: { [DEPLOYMENT_DEPLOY_ACTION_ID_V1]: { approvalRequiredSurfaces: ['agent', 'mcp'] } } };
    const created = await ui.execute('actions.policy.set', { profileChange: { kind: 'create', profile: askProfile } }, context);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.errorCode);
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
    const unchanged = await ui.execute('actions.policy.set', { profileChange: { kind: 'update', id: change.id,
      expectedRevision: change.revision, profile: askProfile } }, context);
    expect(unchanged).toMatchObject({ ok: true, result: { profileChange: { revision: change.revision } } });
    expect(fixture.takeRequestObservations().filter(row => row.method !== 'GET' && row.path !== '/v1/artifacts/read'
      && /^\/v[12]\/(?:artifacts|account\/settings)(?:\/|\?|$)/u.test(row.path))).toEqual([]);
    for (const audience of ['agent', 'mcp'] as const) {
      expect(await owner.execute('actions.policy.set', { actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1, audience, mode: 'allowed' }))
        .toMatchObject({ ok: true });
    }
    const stored = await fetchSessionV2(fixture.server.baseUrl, owner.credentials.token, session.sessionId);
    expect(await owner.execute('session.approval_profile.set', { sessionId: session.sessionId, serverId: fixture.serverId,
      expectedMetadataRevision: stored.metadataVersion, approvalProfileId: change.id })).toMatchObject({ ok: true });
    mcp = await connectStdioMcp({ command: process.execPath,
      args: [resolve(repoRootDir(), 'apps/cli/src/index.ts'), 'mcp', 'serve', '--session', session.sessionId],
      env: { ...process.env, NODE_OPTIONS: fixture.sourceOptions, CI: '1', HAPPIER_HOME_DIR: machine.homeDir,
        HAPPIER_SERVER_URL: fixture.actionServerApiUrl } });
    const deploy = () => mcp!.client.callTool({ name: 'action_execute', arguments: {
      actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1, input: deployInput } });
    const firstDeploy = deploy();
    let firstReply: Awaited<typeof firstDeploy> | undefined;
    let firstFailure: unknown;
    void firstDeploy.then(value => { firstReply = value; }, error => { firstFailure = error; });
    let approvalId: string | undefined;
    await waitFor(async () => {
      if (firstFailure) throw firstFailure;
      if (firstReply) {
        expect(firstReply.isError, JSON.stringify(parseToolJson(firstReply))).not.toBe(true);
        approvalId = ActionApprovalRequestCreatedResultSchema.parse(parseToolJson(firstReply)).artifactId;
        return true;
      }
      const listed = await owner.execute('approval.request.list', { status: 'open', actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1 });
      if (!listed.ok) throw new Error(listed.errorCode);
      const result = listed.result as { items?: readonly { artifactId: string }[] };
      approvalId = result.items?.[0]?.artifactId;
      return Boolean(approvalId);
    }, { failFast: true, context: 'Own saved profile makes daemon deployment ask' });
    const activations = async () => (await docker.readInvocations()).filter(call => call.args[0] === 'compose' && call.args.includes('up'));
    expect(await activations()).toEqual([]);
    expect(await owner.execute('approval.request.decide', { artifactId: approvalId!, decision: 'reject' })).toMatchObject({ ok: true });
    await firstDeploy;
    fixture.takeRequestObservations();
    const edited = await ui.execute('actions.policy.set', { profileChange: { kind: 'update', id: change.id,
      expectedRevision: change.revision, profile: { name: 'Deploy after review',
        actions: { [DEPLOYMENT_DEPLOY_ACTION_ID_V1]: { approvalRequiredSurfaces: [] } },
        approvalWaivedSurfaces: { [DEPLOYMENT_DEPLOY_ACTION_ID_V1]: ['agent', 'mcp'] } } } }, context);
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error(edited.errorCode);
    const editedChange = (edited.result as { profileChange: { revision: { headerVersion: number; bodyVersion: number } } }).profileChange;
    expect(editedChange.revision.bodyVersion).toBeGreaterThan(change.revision.bodyVersion);
    const changes: ReturnType<TeamSetupFFixture['takeRequestObservations']> = [];
    await waitFor(() => {
      changes.push(...fixture!.takeRequestObservations());
      return changes.some(row => row.path === '/v1/artifacts/read'
        || (row.method === 'GET' && /^\/v[12]\/artifacts(?:\/|\?|$)/u.test(row.path)));
    }, { context: 'Profile body edit refreshes the daemon held catalog from the change stream' });
    const allowedDeploy = deploy();
    let allowedReply: Awaited<typeof allowedDeploy> | undefined;
    let allowedFailure: unknown;
    void allowedDeploy.then(value => { allowedReply = value; }, error => { allowedFailure = error; });
    await waitFor(async () => {
      if (allowedFailure) throw allowedFailure;
      if (allowedReply) {
        expect(allowedReply.isError, JSON.stringify(parseToolJson(allowedReply))).not.toBe(true);
        if (ActionApprovalRequestCreatedResultSchema.safeParse(parseToolJson(allowedReply)).success)
          throw new Error('Edited profile still asks for deployment');
      }
      return (await activations()).length === 1;
    }, { failFast: true, context: 'Edited own profile allows the next daemon deployment' });
    await allowedDeploy;
    expect(await activations()).toHaveLength(1);
    expect(await ui.execute('actions.policy.set', { profileChange: { kind: 'update', id: change.id,
      expectedRevision: change.revision, profile: { name: 'Stale overwrite' } } }, context))
      .toMatchObject({ ok: false, errorCode: 'currentness_conflict' });
    expect(await ui.execute('actions.policy.get', { profiles: true }, context))
      .toMatchObject({ ok: true, result: { profiles: [{ id: change.id, profile: { name: 'Deploy after review' } }] } });
    for (const audience of ['agent', 'mcp'] as const) {
      expect(await owner.execute('actions.policy.set', { actionId: 'artifact.update', audience, mode: 'allowed' }))
        .toMatchObject({ ok: true });
      expect(await owner.execute('actions.policy.set', { actionId: 'artifact.delete', audience, mode: 'allowed' }))
        .toMatchObject({ ok: true });
    }
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
