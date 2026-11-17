import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { ProjectSourcesListOutputV1Schema, ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { TeamMembershipV1Schema } from '@happier-dev/protocol/teams/membership';
import { teamGroupLabelBinding } from '@happier-dev/protocol/teams/groupLabel';
import { PRIVATE_LABEL_RECIPIENT_CENSUS_PATH } from '@happier-dev/protocol/crypto/privateLabelRecipientCensusV1';
import { prepareCliPrivateLabels } from '../../../../apps/cli/src/api/privateLabels';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';

describe('Team setup F: viewer-scoped resource demand', () => {
  let fixture: TeamSetupFFixture;
  let owner: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  let machine: Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;
  let teamId: string;
  let sourceId: string;

  beforeAll(async () => {
    fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'team-setup-f-resources-')),
      dbProvider: process.env.HAPPIER_E2E_DB_PROVIDER === 'sqlite' ? 'sqlite' : 'postgres', observeActionRequests: true });
    owner = await fixture.createAccount('resources-owner');
    machine = await fixture.enrollDaemon(owner);
    await fixture.assertKnownGoodSessionControl(owner, machine);
    expect((await fixture.claimHomeOwner(owner)).result.status).toBe('claimed');
    const createTeam = async (name: string) => {
      const created = await owner.executeReviewed('teams.create', { v: 1, name, requestKey: randomUUID(),
        initialOwnerAccountId: readAccountIdFromToken(owner.credentials.token) });
      if (!created.ok) throw new Error(`Team creation refused (${created.errorCode})`);
      expect(created.ok).toBe(true);
      return TeamSummaryV1Schema.parse(created.result).id;
    };
    teamId = await createTeam('F Resources');
    const otherTeamId = await createTeam('F Other Resources');
    // More unrelated Sources than the requested page make accidental Account-
    // library enumeration visible without turning the fixture size into a limit.
    const sourceFixtures: readonly (readonly [string, string])[] = [['Selected Source', teamId],
      ...Array.from({ length: 12 }, (_, index) => [`Unrelated Source ${index}`, otherTeamId] as const)];
    for (const [name, scope] of sourceFixtures) {
      const created = await owner.executeReviewed('projects.sources.create', { serverId: fixture.serverId,
        name, owner: { kind: 'team', teamId: scope }, requestKey: randomUUID() });
      if (!created.ok) throw new Error(`Source creation refused (${created.errorCode})`);
      expect(created.ok).toBe(true);
      const result = ProjectSourcesReadOutputV1Schema.parse(created.result);
      if (!result.ok) throw new Error(`Source creation refused (${result.error})`);
      expect(result.ok).toBe(true);
      if (scope === teamId) {
        sourceId = result.source.id;
        const defaults = await owner.executeReviewed('projects.sources.update', { serverId: fixture.serverId,
          sourceId, expectedRevision: result.source.revision,
          patch: { sessionDefaults: { expectedRevision: 'absent', defaults: {
            permissionModeByAgentTargetKey: { 'agent:happier.agent.claude/claude': 'read-only' },
            modelByAgentTargetKey: { 'agent:happier.agent.claude/claude': { v: 2, updatedAt: 1,
              ref: { source: 'native', agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'f-resource-source-model' } } },
          } } } });
        expect(defaults).toMatchObject({ ok: true, result: { ok: true } });
      }
    }
  });
  afterAll(async () => { await fixture?.stop(); });

  async function useSelectedSource() {
    const detail = await owner.execute('projects.sources.read', { serverId: fixture.serverId, sourceId });
    if (!detail.ok) throw new Error(`Selected Source unavailable (${detail.errorCode})`);
    expect(detail.ok).toBe(true);
    expect(ProjectSourcesReadOutputV1Schema.parse(detail.result).ok).toBe(true);
    const launched = await owner.executeReviewed('session.spawn_new', { executionTarget: machine.target,
      projectContext: { projectRef: { serverId: fixture.serverId, projectKey: 'f-resource-selected-project' },
        sourceRef: { serverId: fixture.serverId, sourceId } },
      directory: { kind: 'path', path: machine.workspaceDir },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      terminal: { mode: 'plain' } });
    if (!launched.ok) throw new Error(`Resource use refused (${launched.errorCode})`);
    expect(launched.ok).toBe(true);
    const result = SessionSpawnNewActionResultV1Schema.parse(launched.result);
    expect(result.type).toBe('success');
    if (result.type !== 'success') throw new Error(`Resource use failed (${result.type === 'error' ? result.code : result.outcome})`);
    expect(await owner.readSessionMetadata(result.sessionId)).toMatchObject({
      primaryTeamId: teamId,
      permissionMode: 'read-only',
      modelSelectionIntentV2: { v: 2, ref: { source: 'native', modelId: 'f-resource-source-model' } },
    });
  }

  it('TS.F.summaryDemand returns the selected Team Source count without opening resources', async () => {
    await fixture.assertKnownGoodSessionControl(owner, machine);
    fixture.takeRequestObservations();
    const summary = await owner.execute('teams.sharedResources.summary' as ActionId, { v: 1, teamId });
    if (!summary.ok) throw new Error(`Summary unavailable (${summary.errorCode})`);
    expect(summary.ok).toBe(true);
    expect(summary.result).toMatchObject({ teamId, kinds: expect.arrayContaining([
      { kind: 'projectSources', status: 'available', count: 1 },
    ]) });
    const observations = fixture.takeRequestObservations();
    const summaryPath = getActionSpec('teams.sharedResources.summary' as ActionId).serverTransport?.path;
    expect(observations.filter(row => row.path === summaryPath)).toHaveLength(1);
    expect(observations.filter(row => /\/(?:artifacts|machines|sessions|projects\/sources)(?:\/|$)/.test(row.path))).toEqual([]);
    await useSelectedSource();
  });

  it('TS.F.kindPaging uses the existing Source list Action and includes Team ownership without a self-grant', async () => {
    await fixture.assertKnownGoodSessionControl(owner, machine);
    const listed = await owner.execute('projects.sources.list', { serverId: fixture.serverId,
      sharedWithTeamId: teamId, limit: 1 });
    if (!listed.ok) throw new Error(`Source page unavailable (${listed.errorCode})`);
    expect(listed.ok).toBe(true);
    const result = ProjectSourcesListOutputV1Schema.parse(listed.result);
    if (!result.ok) throw new Error(`Source page unavailable (${result.error})`);
    expect(result.ok).toBe(true);
    expect(result.sources.map(source => source.id)).toEqual([sourceId]);
    expect(result.coverage).toEqual({ complete: true, nextCursor: null });
    await useSelectedSource();
  });

  it('TS.F.kindPaging uses actual Group membership for admins and withdraws access on the next read', async () => {
    await fixture.assertKnownGoodSessionControl(owner, machine);
    const viewer = await fixture.createAccount('resources-admin');
    const personal = await viewer.executeReviewed('projects.sources.create', { serverId: fixture.serverId,
      name: 'Viewer identity Source', requestKey: randomUUID() });
    if (!personal.ok) throw new Error(`Identity Source creation refused (${personal.errorCode})`);
    expect(personal.ok).toBe(true);
    const identity = ProjectSourcesReadOutputV1Schema.parse(personal.result);
    if (!identity.ok) throw new Error(`Identity Source creation refused (${identity.error})`);
    const member = await owner.executeReviewed('teams.members.add', { v: 1, teamId,
      accountId: identity.source.createdByAccountId, role: 'admin', historyAccess: 'all_existing' });
    if (!member.ok) throw new Error(`Admin admission refused (${member.errorCode})`);
    expect(member.ok).toBe(true);
    const accountId = TeamMembershipV1Schema.parse(member.result).accountId;
    const groupId = randomUUID();
    const [name] = await prepareCliPrivateLabels({ endpoint: fixture.server.baseUrl,
      token: owner.credentials.token, accountMode: 'e2ee', recipientCensusPath: PRIVATE_LABEL_RECIPIENT_CENSUS_PATH,
      owner: { kind: 'team', teamId }, labels: [{ binding: teamGroupLabelBinding(groupId, 'name'), value: 'Source readers' }] });
    const group = await owner.executeReviewed('teams.groups.create', { v: 1, teamId, groupId, name, requestKey: randomUUID() });
    expect(group.ok).toBe(true);
    const created = await owner.executeReviewed('projects.sources.create', { serverId: fixture.serverId,
      name: 'Group only Source', requestKey: randomUUID(),
      audience: [{ principal: { kind: 'group', teamId, groupId }, level: 'view' }] });
    if (!created.ok) throw new Error(`Group Source creation refused (${created.errorCode})`);
    expect(created.ok).toBe(true);
    const source = ProjectSourcesReadOutputV1Schema.parse(created.result);
    if (!source.ok) throw new Error(`Group Source creation refused (${source.error})`);

    // Owning this personal Source does not make its unrelated Group a selected-
    // Team placement for this viewer (owner ruling, 2026-11-16).
    const ownerRead = await owner.execute('projects.sources.read', { serverId: fixture.serverId, sourceId: source.source.id });
    expect(ownerRead.ok).toBe(true);
    const ownerList = await owner.execute('projects.sources.list', { serverId: fixture.serverId, sharedWithTeamId: teamId });
    if (!ownerList.ok) throw new Error(`Owner Source list refused (${ownerList.errorCode})`);
    expect(ownerList.ok).toBe(true);
    const ownerPage = ProjectSourcesListOutputV1Schema.parse(ownerList.result);
    if (!ownerPage.ok) throw new Error(`Owner Source page refused (${ownerPage.error})`);
    expect(ownerPage.sources.map(row => row.id)).toEqual([sourceId]);
    const ownerSummary = await owner.execute('teams.sharedResources.summary' as ActionId, { v: 1, teamId });
    if (!ownerSummary.ok) throw new Error(`Owner summary refused (${ownerSummary.errorCode})`);
    expect(ownerSummary.ok).toBe(true);
    expect(ownerSummary.result).toMatchObject({ kinds: expect.arrayContaining([
      { kind: 'projectSources', status: 'available', count: 1 },
    ]) });

    for (const state of ['outside', 'joined', 'revoked'] as const) {
      const admitted = state === 'joined';
      if (state === 'joined') {
        expect(await owner.executeReviewed('teams.groups.members.add', { v: 1, teamId, groupId,
          accountId, historyAccess: 'all_existing' })).toMatchObject({ ok: true });
      } else if (state === 'revoked') {
        expect(await owner.executeReviewed('teams.groups.members.remove', { v: 1, teamId, groupId, accountId }))
          .toMatchObject({ ok: true });
      }
      const detail = await viewer.execute('projects.sources.read', { serverId: fixture.serverId, sourceId: source.source.id });
      if (admitted) {
        if (!detail.ok) throw new Error(`Admitted Source read refused (${detail.errorCode})`);
        expect(detail.ok).toBe(true);
        expect(ProjectSourcesReadOutputV1Schema.parse(detail.result)).toMatchObject({ ok: true, source: { id: source.source.id } });
      } else {
        expect(detail).toMatchObject({ ok: false, errorCode: 'source_unavailable' });
      }
      const list = await viewer.execute('projects.sources.list', { serverId: fixture.serverId, sharedWithTeamId: teamId });
      if (!list.ok) throw new Error(`Viewer Source list refused (${list.errorCode})`);
      expect(list.ok).toBe(true);
      const page = ProjectSourcesListOutputV1Schema.parse(list.result);
      if (!page.ok) throw new Error(`Viewer Source list refused (${page.error})`);
      expect(page.sources.some(row => row.id === source.source.id)).toBe(admitted);
      expect(page.sources.some(row => row.id === sourceId)).toBe(true);
      const summary = await viewer.execute('teams.sharedResources.summary' as ActionId, { v: 1, teamId });
      if (!summary.ok) throw new Error(`Viewer summary refused (${summary.errorCode})`);
      expect(summary.ok).toBe(true);
      expect(summary.result).toMatchObject({ kinds: expect.arrayContaining([
        { kind: 'projectSources', status: 'available', count: admitted ? 2 : 1 },
      ]) });
    }
    await useSelectedSource();
  });
});
