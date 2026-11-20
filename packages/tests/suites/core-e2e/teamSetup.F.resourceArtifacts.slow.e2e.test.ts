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
import { WorkflowDefinitionCreateResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
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
  let prepareMachine: ReturnType<TeamSetupFFixture['prepareSessionControl']>;
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
    [owner, member, admin, agent] = await Promise.all([
      fixture.createAccount('artifact-owner'),
      fixture.createAccount('artifact-member'),
      fixture.createAccount('artifact-admin'),
      createIsolatedFakeClaudeControlShim({ testDir: join(testDir, 'agent'),
        invocationId: 'artifact-resource-use', captureEnvironmentKeys: [], logFullStdin: false, captureStartupInstructions: true }),
    ]);
    prepareMachine = fixture.prepareSessionControl(member, { env: { HAPPIER_CLAUDE_PATH: agent.executablePath } });
    expect((await fixture.claimHomeOwner(owner)).result.status).toBe('claimed');
    await prepareResources();
  });
  afterAll(async () => { await fixture?.stop(); });

  async function prepareResources() {
    return owner.withPersonActionClient(async execute => {
      const seed = async (actionId: ActionId, input: unknown) => {
        const result = await execute(actionId, input);
        if (!result.ok) throw new Error(`Artifact fixture ${actionId} refused (${result.errorCode})`);
        return result.result;
      };
      teamId = TeamSummaryV1Schema.parse(await seed('teams.create', {
        v: 1, name: 'Artifact discovery', requestKey: randomUUID(), initialOwnerAccountId: readAccountIdFromToken(owner.credentials.token),
      })).id;
      for (const [account, role] of [[member, 'member'], [admin, 'admin']] as const) {
        await seed('teams.members.add', { v: 1, teamId, role,
          accountId: readAccountIdFromToken(account.credentials.token), historyAccess: 'from_membership' });
      }
      groupId = randomUUID();
      const name = await prepareCliPrivateLabel({ endpoint: fixture.server.baseUrl, token: owner.credentials.token,
        accountId: readAccountIdFromToken(owner.credentials.token), accountMode: 'e2ee',
        recipientCensusPath: PRIVATE_LABEL_RECIPIENT_CENSUS_PATH, owner: { kind: 'team', teamId },
        binding: teamGroupLabelBinding(groupId, 'name'), value: 'Project readers' });
      await seed('teams.groups.create', { v: 1, teamId, groupId, name, requestKey: randomUUID() });
      await seed('teams.groups.members.add', { v: 1, teamId, groupId,
        accountId: readAccountIdFromToken(member.credentials.token), historyAccess: 'from_membership' });
      const prompt = async (title: string) => {
        const created = ArtifactActionOutputSchemasV1['artifact.create'].parse(await seed('artifact.create', {
          header: { v: 1, kind: 'prompt_doc.v2', title },
          body: JSON.stringify({ v: 1, markdown: title, createdAtMs: 1, updatedAtMs: 1 }),
        }));
        return created.artifactId;
      };
      promptId = await prompt('Selected Team prompt');
      documentId = await prompt('Selected Project document');
      privateGroupId = await prompt('Group only');
      const savedWorkflow = WorkflowDefinitionCreateResultV1Schema.parse(await seed('workflow.definition.create', {
        definitionId: randomUUID(), metadata: { title: 'Selected Workflow' },
        definition: { version: 1,
          defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            conversation: { kind: 'fresh' }, terminal: { mode: 'plain' } },
          blocks: [{ kind: 'step', id: 'selected-workflow', inputMode: 'none',
            document: { text: '', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
        },
      }));
      workflowId = savedWorkflow.definitionId;
      otherId = ArtifactActionOutputSchemasV1['artifact.create'].parse(await seed('artifact.create', {
        artifactId: randomUUID(), header: { kind: 'contributed.team-fixture.v1', title: 'Contributed ordinary Artifact' }, body: '{}',
      })).artifactId;
      await prompt('Unshared prompt');
      for (const artifactId of [promptId, documentId, workflowId, otherId]) {
        await seed('artifact.access.grants.set', { artifactId, principal: { kind: 'team', teamId }, accessLevel: 'view' });
      }
      for (const artifactId of [promptId, privateGroupId]) {
        await seed('artifact.access.grants.set', { artifactId,
          principal: { kind: 'group', teamId, groupId }, accessLevel: 'view' });
      }
      const source = ProjectSourcesReadOutputV1Schema.parse(await seed('projects.sources.create', {
        serverId: fixture.serverId, owner: { kind: 'team', teamId }, name: 'Document project', requestKey: randomUUID(),
      }));
      if (!source.ok) throw new Error(`Source creation refused (${source.error})`);
      await seed('projects.sources.update', { serverId: fixture.serverId, sourceId: source.source.id,
        expectedRevision: source.source.revision, patch: { attachment: { kind: 'attach', attachment: {
          purpose: 'context', entry: { id: 'document', ref: { kind: 'doc', artifactId: documentId },
            enabled: true, placement: 'system_append' },
        } } } });
      const selectedDocument = ArtifactActionOutputSchemasV1['artifact.get'].parse(await seed('artifact.get', {
        artifactId: documentId,
      })).artifact;
      if (!selectedDocument) throw new Error('Shared document disappeared before owner edit');
      await seed('artifact.update', { artifactId: documentId, expectedRevision: selectedDocument.revision,
        header: selectedDocument.header,
        body: JSON.stringify({ v: 1, markdown: 'Edited shared document context', createdAtMs: 1, updatedAtMs: 2 }),
      });
    }, { surface: 'coreAction' });
  }

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
    const machine = await prepareMachine();
    await waitForFakeClaudeInvocation(agent.logPath, invocation => invocation.mode === 'sdk');
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
    await prepareMachine();
    const summary = await invoke(admin, 'teams.sharedResources.summary' as ActionId, { v: 1, teamId });
    expect(summary).toMatchObject({ teamId, kinds: expect.arrayContaining([
      { kind: 'projectDocuments', status: 'available', count: 1 },
      { kind: 'prompts', status: 'available', count: 1 },
      { kind: 'workflows', status: 'available', count: 1 },
      { kind: 'otherArtifacts', status: 'available', count: 1 },
    ]) });
  });
});
