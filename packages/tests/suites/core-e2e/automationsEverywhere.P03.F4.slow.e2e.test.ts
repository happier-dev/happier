import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { fetchSessionV2 } from '../../src/testkit/sessions';

describe('Shared approval profiles: Team default', () => {
  let fixture: TeamSetupFFixture;
  let owner: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  beforeAll(async () => {
    fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'ae-p03-team-profile-')),
      observeActionRequests: true });
    owner = await fixture.createAccount('owner');
    await fixture.claimHomeOwner(owner);
  }, 0);
  beforeEach(() => { fixture.takeRequestObservations(); });
  afterAll(async () => { await fixture?.stop(); }, 0);

  it('AE.P03.F4-team-default-tighten captures the Team default without consenting to looser rows', async () => {
    const member = await fixture.createAccount('member');
    const machine = await fixture.enrollDaemon(member);
    await fixture.assertKnownGoodSessionControl(member, machine);
    const created = await owner.executeAsPerson('teams.create', { v: 1, initialOwnerAccountId: readAccountIdFromToken(owner.credentials.token), name: 'Approval defaults', requestKey: randomUUID() },
      { presentUserConfirmation: { actionId: 'teams.create' } });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error(created.errorCode);
    const teamId = TeamSummaryV1Schema.parse(created.result).id;
    expect(await owner.executeAsPerson('teams.members.add', { v: 1, teamId,
      accountId: readAccountIdFromToken(member.credentials.token), role: 'member', historyAccess: 'from_membership' },
    { presentUserConfirmation: { actionId: 'teams.members.add' } })).toMatchObject({ ok: true });

    // R12: readability is not checked by teams.policy.set. This discriminates
    // the missing profile field independently of Artifact creation (Plan C U1).
    expect(await owner.executeAsPerson('teams.policy.set', { v: 1, teamId,
      managedDefaults: { team: { approvalProfileId: 'not-yet-shared' }, groups: {} } },
    { presentUserConfirmation: { actionId: 'teams.policy.set' } })).toMatchObject({ ok: true });

    const profileResult = await owner.executeAsPerson('actions.policy.set', { profileChange: { kind: 'create', profile: {
      name: 'Team release defaults',
      actions: { 'session.stop': { approvalRequiredSurfaces: [] }, 'session.list': { enabled: false } },
      approvalWaivedSurfaces: { 'session.stop': ['agent', 'mcp'] },
    } } });
    expect(profileResult.ok).toBe(true);
    if (!profileResult.ok) throw new Error(profileResult.errorCode);
    const profileChange = ActionPolicyOutputSchemas['actions.policy.set'].parse(profileResult.result);
    if (!('profileChange' in profileChange) || !('id' in profileChange.profileChange)
      || typeof profileChange.profileChange.id !== 'string') throw new Error('Profile create did not return its Artifact id');
    const profileId = profileChange.profileChange.id;
    expect(await owner.executeReviewed('artifact.access.grants.set', { artifactId: profileId,
      principal: { kind: 'team', teamId }, accessLevel: 'view' })).toMatchObject({ ok: true });
    expect(await owner.executeAsPerson('teams.policy.set', { v: 1, teamId,
      managedDefaults: { team: { approvalProfileId: profileId }, groups: {} } },
    { presentUserConfirmation: { actionId: 'teams.policy.set' } })).toMatchObject({ ok: true });
    expect(await member.execute('actions.policy.set', { actionId: 'session.stop', audience: 'agent', mode: 'ask_first' }))
      .toMatchObject({ ok: true });
    const spawned = await member.execute('session.spawn_new', {
      executionTarget: machine.target, directory: { kind: 'path', path: machine.workspaceDir },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      primaryTeamId: teamId, terminal: { mode: 'plain' },
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.errorCode);
    const session = SessionSpawnNewResultV1Schema.parse(spawned.result);
    expect(session.type).toBe('success');
    if (session.type !== 'success') throw new Error('Team-default Session did not start');
    expect(await member.readSessionMetadata(session.sessionId)).toMatchObject({
      approvalProfileId: profileId, approvalProfileTeamOrGroupDerived: true,
    });
    // The real Action admission retains the member's Ask despite the Team
    // profile's waiver. Picking that same id explicitly accepts the rows.
    expect(await member.execute('session.stop', { sessionId: session.sessionId }, {
      surface: 'mcp', authority: 'account_automation', defaultSessionId: session.sessionId,
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(await member.execute('session.list', {}, {
      surface: 'mcp', authority: 'account_automation', defaultSessionId: session.sessionId,
    })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    const stored = await fetchSessionV2(fixture.server.baseUrl, member.credentials.token, session.sessionId);
    expect(await member.execute('session.approval_profile.set', { sessionId: session.sessionId,
      serverId: fixture.serverId, expectedMetadataRevision: stored.metadataVersion, approvalProfileId: profileId }))
      .toMatchObject({ ok: true });
    expect((await member.readSessionMetadata(session.sessionId)).approvalProfileTeamOrGroupDerived ?? false).toBe(false);
    const accepted = await member.execute('session.stop', { sessionId: session.sessionId }, {
      surface: 'mcp', authority: 'account_automation', defaultSessionId: session.sessionId,
    });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    if (!accepted.ok) throw new Error(accepted.errorCode);
    expect(accepted.result).not.toMatchObject({ kind: 'approval_request_created' });
  }, 0);

  it('AE.P03.F5-project-default captures the project profile over the Team default and preserves creation-time choices', async () => {
    const manager = await fixture.createAccount('project-manager');
    const reader = await fixture.createAccount('project-reader');
    const machine = await fixture.enrollDaemon(manager);
    await fixture.assertKnownGoodSessionControl(manager, machine);
    const teamResult = await owner.executeAsPerson('teams.create', { v: 1, initialOwnerAccountId: readAccountIdFromToken(owner.credentials.token), name: 'Project approval defaults', requestKey: randomUUID() },
      { presentUserConfirmation: { actionId: 'teams.create' } });
    expect(teamResult.ok, JSON.stringify(teamResult)).toBe(true);
    if (!teamResult.ok) throw new Error(teamResult.errorCode);
    const teamId = TeamSummaryV1Schema.parse(teamResult.result).id;
    for (const [account, role] of [[manager, 'admin'], [reader, 'member']] as const) {
      expect(await owner.executeAsPerson('teams.members.add', { v: 1, teamId, role, historyAccess: 'from_membership',
        accountId: readAccountIdFromToken(account.credentials.token) },
      { presentUserConfirmation: { actionId: 'teams.members.add' } })).toMatchObject({ ok: true });
    }
    const createProfile = async (name: string, asks: boolean) => {
      const result = await owner.executeAsPerson('actions.policy.set', { profileChange: { kind: 'create', profile: {
        name, actions: { 'session.stop': { approvalRequiredSurfaces: asks ? ['agent', 'mcp'] : [] } },
        ...(asks ? {} : { approvalWaivedSurfaces: { 'session.stop': ['agent', 'mcp'] } }),
      } } });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      const parsed = ActionPolicyOutputSchemas['actions.policy.set'].parse(result.result);
      if (!('profileChange' in parsed) || !('id' in parsed.profileChange)
        || typeof parsed.profileChange.id !== 'string') throw new Error('Profile create did not return its Artifact id');
      const id = parsed.profileChange.id;
      expect(await owner.executeReviewed('artifact.access.grants.set', { artifactId: id,
        principal: { kind: 'team', teamId }, accessLevel: 'view' })).toMatchObject({ ok: true });
      return id;
    };
    const teamProfileId = await createProfile('Team allows stops', false);
    const projectProfileId = await createProfile('Project asks before stops', true);
    expect(await owner.executeAsPerson('teams.policy.set', { v: 1, teamId,
      managedDefaults: { team: { approvalProfileId: teamProfileId }, groups: {} } },
    { presentUserConfirmation: { actionId: 'teams.policy.set' } })).toMatchObject({ ok: true });
    expect(await manager.execute('actions.policy.set', { actionId: 'session.stop', audience: 'agent', mode: 'allowed' }))
      .toMatchObject({ ok: true });
    const createdSource = await owner.execute('projects.sources.create', { serverId: fixture.serverId,
      requestKey: randomUUID(), name: 'Shared project approvals', owner: { kind: 'team', teamId } });
    expect(createdSource.ok, JSON.stringify(createdSource)).toBe(true);
    if (!createdSource.ok) throw new Error(createdSource.errorCode);
    const source = ProjectSourcesReadOutputV1Schema.parse(createdSource.result);
    if (!source.ok) throw new Error(source.error);
    const sourceAddress = { serverId: fixture.serverId, sourceId: source.source.id };
    const saved = await manager.execute('projects.sources.update', { ...sourceAddress,
      expectedRevision: source.source.revision, patch: { sessionDefaults: { expectedRevision: 'absent',
        defaults: { approvalProfileId: projectProfileId } } } });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    if (!saved.ok) throw new Error(saved.errorCode);
    const savedSource = ProjectSourcesReadOutputV1Schema.parse(saved.result);
    expect(savedSource).toMatchObject({ ok: true, source: { revision: source.source.revision },
      sessionDefaults: { defaults: { approvalProfileId: projectProfileId } } });
    if (!savedSource.ok || !savedSource.sessionDefaults) throw new Error('Project defaults leaf missing');
    const defaultsRevision = savedSource.sessionDefaults.revision;
    // A visible Source does not confer its manager's write authority.
    const refused = await reader.execute('projects.sources.update', { ...sourceAddress,
      expectedRevision: source.source.revision, patch: { sessionDefaults: { expectedRevision: defaultsRevision,
        defaults: { approvalProfileId: teamProfileId } } } });
    expect(refused).toMatchObject({ ok: true, result: { ok: false, error: 'source_access_denied' } });
    expect(await reader.execute('projects.sources.read', sourceAddress)).toMatchObject({ ok: true, result: {
      canManage: false, sessionDefaults: { revision: defaultsRevision, defaults: { approvalProfileId: projectProfileId } },
    } });
    const projectContext = { sourceRef: sourceAddress,
      projectRef: { serverId: fixture.serverId, projectKey: `approval-project-${randomUUID()}` } };
    const spawn = async (approvalProfileId?: string | null, selectedProject: typeof projectContext | false = projectContext) => {
      const result = await manager.execute('session.spawn_new', { executionTarget: machine.target,
        directory: { kind: 'path', path: machine.workspaceDir }, primaryTeamId: teamId,
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        terminal: { mode: 'plain' }, ...(selectedProject ? { projectContext: selectedProject } : {}),
        ...(approvalProfileId === undefined ? {} : { approvalProfileId }),
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      const session = SessionSpawnNewResultV1Schema.parse(result.result);
      if (session.type !== 'success') throw new Error('Project-default Session did not start');
      return session;
    };
    const projectSession = await spawn();
    expect(await manager.readSessionMetadata(projectSession.sessionId)).toMatchObject({
      approvalProfileId: projectProfileId, approvalProfileTeamOrGroupDerived: true,
    });
    const stopAsAgent = (sessionId: string) => manager.execute('session.stop', { sessionId }, {
      surface: 'mcp', authority: 'account_automation', defaultSessionId: sessionId,
    });
    expect(await stopAsAgent(projectSession.sessionId)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });

    // The carrier waiver cannot waive changing everybody's project profile (M4).
    expect(await manager.execute('actions.policy.set', { actionId: 'projects.sources.update', audience: 'agent', mode: 'allowed' }))
      .toMatchObject({ ok: true });
    expect(await manager.execute('actions.policy.set', { actionId: 'session.approval_profile.set', audience: 'agent', mode: 'ask_first' }))
      .toMatchObject({ ok: true });
    expect(await manager.execute('projects.sources.update', { ...sourceAddress,
      expectedRevision: source.source.revision, patch: { sessionDefaults: { expectedRevision: defaultsRevision,
        defaults: { approvalProfileId: teamProfileId } } } },
    { surface: 'mcp', authority: 'account_automation', defaultSessionId: projectSession.sessionId }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(await manager.execute('projects.sources.read', sourceAddress)).toMatchObject({ ok: true, result: {
      sessionDefaults: { revision: defaultsRevision, defaults: { approvalProfileId: projectProfileId } },
    } });

    // OWNER-1915: a shared Account-owned Source uses the same defaults leaf,
    // existing manager admission and tighten-only application; no Move is needed.
    const personalSourceResult = await owner.execute('projects.sources.create', { serverId: fixture.serverId,
      requestKey: randomUUID(), name: 'Shared personal project approvals',
      audience: [{ principal: { kind: 'team', teamId }, level: 'view' }] });
    expect(personalSourceResult.ok, JSON.stringify(personalSourceResult)).toBe(true);
    if (!personalSourceResult.ok) throw new Error(personalSourceResult.errorCode);
    const personalSource = ProjectSourcesReadOutputV1Schema.parse(personalSourceResult.result);
    if (!personalSource.ok) throw new Error(personalSource.error);
    const personalAddress = { serverId: fixture.serverId, sourceId: personalSource.source.id };
    expect(await manager.execute('projects.sources.update', { ...personalAddress,
      expectedRevision: personalSource.source.revision, patch: { sessionDefaults: { expectedRevision: 'absent',
        defaults: { approvalProfileId: projectProfileId } } } })).toMatchObject({ ok: true, result: {
      ok: true, source: { owner: { kind: 'account', accountId: readAccountIdFromToken(owner.credentials.token) } },
      sessionDefaults: { defaults: { approvalProfileId: projectProfileId } },
    } });
    expect(await reader.execute('projects.sources.read', personalAddress)).toMatchObject({ ok: true, result: {
      canManage: false, sessionDefaults: { defaults: { approvalProfileId: projectProfileId } },
    } });
    const personalProjectSession = await spawn(undefined, { ...projectContext, sourceRef: personalAddress });
    expect(await manager.readSessionMetadata(personalProjectSession.sessionId)).toMatchObject({
      approvalProfileId: projectProfileId, approvalProfileTeamOrGroupDerived: true,
    });
    expect(await stopAsAgent(personalProjectSession.sessionId))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });

    // F6: a Machine preference is captured at birth; later edits cannot become
    // an admission-time picker for either an old id or an explicit Account choice.
    const machineDefault = async (id: string) => {
      expect(await manager.execute('actions.policy.set', { profileChange: { kind: 'machine_default',
        machineId: machine.target.machineId, id } })).toMatchObject({ ok: true });
    };
    await machineDefault(teamProfileId);
    const machineSession = await spawn(undefined, false);
    const accountSession = await spawn(null, false);
    expect(await manager.readSessionMetadata(machineSession.sessionId)).toMatchObject({
      approvalProfileId: teamProfileId, approvalProfileTeamOrGroupDerived: false,
    });
    expect(await manager.readSessionMetadata(accountSession.sessionId)).toMatchObject({
      approvalProfileId: null, approvalProfileTeamOrGroupDerived: false,
    });
    await machineDefault(projectProfileId);
    const newMachineSession = await spawn(undefined, false);
    expect(await manager.readSessionMetadata(newMachineSession.sessionId)).toMatchObject({
      approvalProfileId: projectProfileId, approvalProfileTeamOrGroupDerived: false,
    });
    expect(await manager.readSessionMetadata(machineSession.sessionId)).toMatchObject({ approvalProfileId: teamProfileId });
    expect(await manager.readSessionMetadata(accountSession.sessionId)).toMatchObject({ approvalProfileId: null });
    for (const oldSession of [machineSession, accountSession]) {
      const stopped = await stopAsAgent(oldSession.sessionId);
      expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
      if (!stopped.ok) throw new Error(stopped.errorCode);
      expect(stopped.result).not.toMatchObject({ kind: 'approval_request_created' });
    }
    expect(await stopAsAgent(newMachineSession.sessionId)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  }, 0);
});
