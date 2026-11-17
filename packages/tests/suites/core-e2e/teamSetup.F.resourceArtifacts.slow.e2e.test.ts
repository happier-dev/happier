import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { teamGroupLabelBinding } from '@happier-dev/protocol/teams/groupLabel';
import { PRIVATE_LABEL_RECIPIENT_CENSUS_PATH } from '@happier-dev/protocol/crypto/privateLabelRecipientCensusV1';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { prepareCliPrivateLabel } from '../../../../apps/cli/src/api/privateLabels';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createIsolatedFakeClaudeControlShim, readFakeClaudeLogEvents, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';

describe('Team setup F: Artifact resource discovery', () => {
  let fixture: TeamSetupFFixture;
  let owner: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  let member: typeof owner;
  let admin: typeof owner;
  let machine: Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;
  let agent: Awaited<ReturnType<typeof createIsolatedFakeClaudeControlShim>>;
  let teamId: string;
  let groupId: string;
  let promptId: string;
  let documentId: string;
  let workflowId: string;
  let otherId: string;
  let privateGroupId: string;

  async function invoke(account: typeof owner, actionId: ActionId, input: unknown) {
    const result = await account.executeReviewed(actionId, input);
    if (!result.ok) throw new Error(`${actionId} refused (${result.errorCode})`);
    return result.result;
  }

  beforeAll(async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'team-setup-f-artifacts-'));
    fixture = await startTeamSetupFFixture({ testDir,
      observeActionRequests: true,
      dbProvider: process.env.HAPPIER_E2E_DB_PROVIDER === 'sqlite' ? 'sqlite' : 'postgres' });
    owner = await fixture.createAccount('artifact-owner');
    member = await fixture.createAccount('artifact-member');
    admin = await fixture.createAccount('artifact-admin');
    agent = await createIsolatedFakeClaudeControlShim({ testDir: join(testDir, 'agent'),
      invocationId: 'artifact-resource-use', captureEnvironmentKeys: [], logFullStdin: false, captureStartupInstructions: true });
    machine = await fixture.enrollDaemon(member, { env: { HAPPIER_CLAUDE_PATH: agent.executablePath } });
    // P04: the actual admitted native path must work before feature setup can
    // produce a meaningful missing-resource RED.
    await fixture.assertKnownGoodSessionControl(member, machine);
    await waitForFakeClaudeInvocation(agent.logPath, invocation => invocation.mode === 'sdk');
    expect((await fixture.claimHomeOwner(owner)).result.status).toBe('claimed');
    teamId = TeamSummaryV1Schema.parse(await invoke(owner, 'teams.create', {
      v: 1, name: 'Artifact discovery', requestKey: randomUUID(), initialOwnerAccountId: readAccountIdFromToken(owner.credentials.token),
    })).id;
    for (const [account, role] of [[member, 'member'], [admin, 'admin']] as const) {
      await invoke(owner, 'teams.members.add', { v: 1, teamId, role,
        accountId: readAccountIdFromToken(account.credentials.token), historyAccess: 'from_membership' });
    }
    groupId = randomUUID();
    const name = await prepareCliPrivateLabel({ endpoint: fixture.server.baseUrl, token: owner.credentials.token,
      accountId: readAccountIdFromToken(owner.credentials.token), accountMode: 'e2ee',
      recipientCensusPath: PRIVATE_LABEL_RECIPIENT_CENSUS_PATH, owner: { kind: 'team', teamId },
      binding: teamGroupLabelBinding(groupId, 'name'), value: 'Project readers' });
    await invoke(owner, 'teams.groups.create', { v: 1, teamId, groupId, name, requestKey: randomUUID() });
    await invoke(owner, 'teams.groups.members.add', { v: 1, teamId, groupId,
      accountId: readAccountIdFromToken(member.credentials.token), historyAccess: 'from_membership' });
    const prompt = async (title: string) => {
      const created = ArtifactActionOutputSchemasV1['artifact.create'].parse(await invoke(owner, 'artifact.create', {
        header: { v: 1, kind: 'prompt_doc.v2', title },
        body: JSON.stringify({ v: 1, markdown: title, createdAtMs: 1, updatedAtMs: 1 }),
      }));
      return created.artifactId;
    };
    promptId = await prompt('Selected Team prompt');
    documentId = await prompt('Selected Project document');
    privateGroupId = await prompt('Group only');
    const artifact = async (header: Record<string, unknown>, artifactId = randomUUID()) => {
      return ArtifactActionOutputSchemasV1['artifact.create'].parse(await invoke(owner, 'artifact.create', {
        artifactId, header, body: '{}',
      })).artifactId;
    };
    workflowId = randomUUID();
    await artifact({ kind: 'workflow-definition.v1', definitionId: workflowId,
      revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Selected Workflow' } }, workflowId);
    otherId = await artifact({ kind: 'contributed.team-fixture.v1', title: 'Contributed ordinary Artifact' });
    await prompt('Unshared prompt');
    for (const artifactId of [promptId, documentId, workflowId, otherId]) {
      await invoke(owner, 'artifact.access.grants.set', { artifactId, principal: { kind: 'team', teamId }, accessLevel: 'view' });
    }
    for (const artifactId of [promptId, privateGroupId]) {
      await invoke(owner, 'artifact.access.grants.set', { artifactId,
        principal: { kind: 'group', teamId, groupId }, accessLevel: 'view' });
    }
    const source = ProjectSourcesReadOutputV1Schema.parse(await invoke(owner, 'projects.sources.create', {
      serverId: fixture.serverId, owner: { kind: 'team', teamId }, name: 'Document project', requestKey: randomUUID(),
    }));
    if (!source.ok) throw new Error(`Source creation refused (${source.error})`);
    await invoke(owner, 'projects.sources.update', { serverId: fixture.serverId, sourceId: source.source.id,
      expectedRevision: source.source.revision, patch: { attachment: { kind: 'attach', attachment: {
        purpose: 'context', entry: { id: 'document', ref: { kind: 'doc', artifactId: documentId },
          enabled: true, placement: 'system_append' },
      } } } });
    const selectedDocument = ArtifactActionOutputSchemasV1['artifact.get'].parse(await invoke(owner, 'artifact.get', {
      artifactId: documentId,
    })).artifact;
    if (!selectedDocument) throw new Error('Shared document disappeared before owner edit');
    await invoke(owner, 'artifact.update', { artifactId: documentId, expectedRevision: selectedDocument.revision,
      header: selectedDocument.header,
      body: JSON.stringify({ v: 1, markdown: 'Edited shared document context', createdAtMs: 1, updatedAtMs: 2 }),
    });
  });
  afterAll(async () => { await fixture?.stop(); });

  async function list(account: typeof owner, kind: string, limit = 50, cursor?: string) {
    fixture.takeRequestObservations();
    const result = ArtifactActionOutputSchemasV1['artifact.list'].parse(await invoke(account, 'artifact.list', {
      sharedWithTeamId: teamId, teamResourceKind: kind, limit, ...(cursor ? { cursor } : {}),
    }));
    const artifactRequests = fixture.takeRequestObservations().filter(request => request.path.startsWith('/v1/artifacts'));
    expect(artifactRequests).toHaveLength(1);
    const request = artifactRequests[0]!;
    const url = new URL(request.path, fixture.server.baseUrl);
    expect(request.method).toBe('GET');
    expect(url.pathname).toBe('/v1/artifacts');
    expect(url.searchParams.get('sharedWithTeamId')).toBe(teamId);
    expect(url.searchParams.get('teamResourceKind')).toBe(kind);
    expect(url.searchParams.has('includeBody')).toBe(false);
    return result;
  }

  it('TS.F.kindPaging discovers one Artifact bucket, applies Group privacy and uses the selected document on the daemon', async () => {
    await fixture.assertKnownGoodSessionControl(member, machine);
    const workflows = await list(member, 'workflows', 1);
    expect(workflows.items.map(item => item.artifactId)).toEqual([workflowId]);
    const documents = await list(member, 'projectDocuments');
    expect(documents.items.map(item => item.artifactId)).toEqual([documentId]);
    const prompts = await list(member, 'prompts');
    expect(new Set(prompts.items.map(item => item.artifactId))).toEqual(new Set([promptId, privateGroupId]));
    expect(prompts.items.find(item => item.artifactId === promptId)?.sharedWithTeamScope).toBe('team_and_group');
    expect(prompts.items.find(item => item.artifactId === privateGroupId)?.sharedWithTeamScope).toBe('group');
    expect((await list(admin, 'prompts')).items.map(item => item.artifactId)).toEqual([promptId]);
    expect(new Set((await list(owner, 'prompts')).items.map(item => item.artifactId))).toEqual(new Set([promptId, privateGroupId]));
    expect((await list(member, 'otherArtifacts')).items.map(item => item.artifactId)).toEqual([otherId]);
    const selected = await invoke(member, 'artifact.get', { artifactId: documentId });
    expect(ArtifactActionOutputSchemasV1['artifact.get'].parse(selected).artifact?.artifactId).toBe(documentId);
    const launchedAfter = Date.now();
    const launched = SessionSpawnNewActionResultV1Schema.parse(await invoke(member, 'session.spawn_new', {
      executionTarget: machine.target, directory: { kind: 'path', path: machine.workspaceDir },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, terminal: { mode: 'plain' },
      promptStack: [{ id: 'selected-document', ref: { kind: 'doc', artifactId: documentId }, enabled: true, placement: 'system_append' }],
    }));
    expect(launched.type).toBe('success');
    if (launched.type !== 'success') throw new Error(`Resource use refused (${launched.code})`);
    expect(await member.readSessionMetadata(launched.sessionId)).toMatchObject({ work: { promptStack: [expect.objectContaining({
      ref: expect.objectContaining({ artifactId: documentId }),
    })] } });
    await invoke(member, 'session.message.send', { sessionId: launched.sessionId,
      message: 'Use the selected shared document.', reply: 'wait' });
    await waitForFakeClaudeInvocation(agent.logPath, item => item.mode === 'sdk'
      && typeof item.ts === 'number' && item.ts >= launchedAfter);
    expect(await readFakeClaudeLogEvents(agent.logPath)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'startup_instructions', text: expect.stringContaining('Edited shared document context') }),
    ]));
    await invoke(owner, 'artifact.access.grants.remove', { artifactId: privateGroupId, principal: { kind: 'group', teamId, groupId } });
    expect((await list(member, 'prompts')).items.map(item => item.artifactId)).toEqual([promptId]);
  });

  it('TS.F.summaryDemand counts disjoint Artifact buckets without granting an administrator Group access', async () => {
    await fixture.assertKnownGoodSessionControl(member, machine);
    const summary = await invoke(admin, 'teams.sharedResources.summary' as ActionId, { v: 1, teamId });
    expect(summary).toMatchObject({ teamId, kinds: expect.arrayContaining([
      { kind: 'projectDocuments', status: 'available', count: 1 },
      { kind: 'prompts', status: 'available', count: 1 },
      { kind: 'workflows', status: 'available', count: 1 },
      { kind: 'otherArtifacts', status: 'available', count: 1 },
    ]) });
  });
});
