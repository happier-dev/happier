import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createIsolatedFakeClaudeControlShim } from '../../src/testkit/fakeClaude';
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

  it('AE.P03.F5-project-default captures the project profile over the Team default and preserves creation-time choices', async () => {
    const manager = await fixture.createAccount('project-manager');
    const reader = await fixture.createAccount('project-reader');
    const agent = await createIsolatedFakeClaudeControlShim({
      testDir: await mkdtemp(join(tmpdir(), 'ae-p03-f5-native-agent-')),
      invocationId: 'profile-project-default', captureEnvironmentKeys: [], logFullStdin: false,
    });
    const machine = await fixture.enrollDaemon(manager, { env: { HAPPIER_CLAUDE_PATH: agent.executablePath } });
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
    expect(await manager.executeAsPerson('actions.policy.set', { actionId: 'session.stop', audience: 'agent', mode: 'allowed' }))
      .toMatchObject({ ok: true, result: { actionId: 'session.stop', mode: 'allowed' } });
    expect(await manager.executeAsPerson('actions.policy.set', { actionId: 'session.spawn_new', audience: 'agent', mode: 'allowed' }))
      .toMatchObject({ ok: true, result: { actionId: 'session.spawn_new', mode: 'allowed' } });
    const createdSource = await owner.executeReviewed('projects.sources.create', { serverId: fixture.serverId,
      requestKey: randomUUID(), name: 'Shared project approvals', owner: { kind: 'team', teamId } });
    expect(createdSource.ok, JSON.stringify(createdSource)).toBe(true);
    if (!createdSource.ok) throw new Error(createdSource.errorCode);
    const source = ProjectSourcesReadOutputV1Schema.parse(createdSource.result);
    if (!source.ok) throw new Error(source.error);
    const sourceAddress = { serverId: fixture.serverId, sourceId: source.source.id };
    const saved = await manager.executeReviewed('projects.sources.update', { ...sourceAddress,
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
    const refused = await reader.executeAsPerson('projects.sources.update', { ...sourceAddress,
      expectedRevision: source.source.revision, patch: { sessionDefaults: { expectedRevision: defaultsRevision,
        defaults: { approvalProfileId: teamProfileId } } } });
    expect(refused, JSON.stringify(refused)).toMatchObject({ ok: true, result: { ok: false, error: 'source_access_denied' } });
    expect(await reader.execute('projects.sources.read', sourceAddress)).toMatchObject({ ok: true, result: {
      canManage: false, sessionDefaults: { revision: defaultsRevision, defaults: { approvalProfileId: projectProfileId } },
    } });
    // The recipient is a separately authenticated Account. A's successful
    // defaults write is not evidence of B's effective inheritance (QA-B).
    expect(await reader.executeAsPerson(PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1, { sourceRef: sourceAddress }))
      .toMatchObject({ ok: true, result: { canManageSource: false,
        sourceDefaultsRow: { revision: defaultsRevision, defaults: { approvalProfileId: projectProfileId } },
        context: { projectDefaults: { approvalProfileId: projectProfileId },
          teamDefaults: { team: { approvalProfileId: teamProfileId } } },
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
      const session = SessionSpawnNewActionResultV1Schema.parse(result.result);
      if (session.type !== 'success') throw new Error('Project-default Session did not start');
      return session;
    };
    const projectSession = await spawn();
    expect(await manager.readSessionMetadata(projectSession.sessionId)).toMatchObject({
      approvalProfileId: projectProfileId, approvalProfileTeamOrGroupDerived: true,
    });
    const stopAsAgent = async (parentSessionId: string) => {
      const nativeSession = { sessionId: parentSessionId, logPath: agent.logPath };
      // Each captured parent profile controls its own real MCP call and server-proved child relation.
      const spawned = await fixture.executeSessionMcpAction(manager, nativeSession, 'session.spawn_new', {
        executionTarget: machine.target, directory: { kind: 'path', path: machine.workspaceDir },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        terminal: { mode: 'plain' },
      });
      expect(spawned.ok, JSON.stringify(spawned)).toBe(true);
      if (!spawned.ok) throw createActionExecuteFailureError(spawned);
      const child = SessionSpawnNewActionResultV1Schema.parse(spawned.result);
      if (child.type !== 'success') throw new Error('Native profile parent did not create its child');
      expect(await fetchSessionV2(fixture.server.baseUrl, manager.credentials.token, child.sessionId))
        .toMatchObject({ manager: { sessionId: parentSessionId }, active: true });
      const result = await fixture.executeSessionMcpAction(manager, nativeSession, 'session.stop', { sessionId: child.sessionId });
      if (!result.ok) throw createActionExecuteFailureError(result);
      return { ...result, childSessionId: child.sessionId };
    };
    const projectStop = await stopAsAgent(projectSession.sessionId);
    expect(projectStop, JSON.stringify(projectStop)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });

    // The carrier waiver cannot waive changing everybody's project profile (M4).
    expect(await manager.executeAsPerson('actions.policy.set', { actionId: 'projects.sources.update', audience: 'agent', mode: 'allowed' }))
      .toMatchObject({ ok: true, result: { actionId: 'projects.sources.update', mode: 'allowed' } });
    expect(await manager.executeAsPerson('actions.policy.set', { actionId: 'session.approval_profile.set', audience: 'agent', mode: 'ask_first' }))
      .toMatchObject({ ok: true, result: { actionId: 'session.approval_profile.set', mode: 'ask_first' } });
    const sourceWrite = await fixture.executeSessionMcpAction(manager, { sessionId: projectSession.sessionId, logPath: agent.logPath },
      'projects.sources.update', { ...sourceAddress,
      expectedRevision: source.source.revision, patch: { sessionDefaults: { expectedRevision: defaultsRevision,
        defaults: { approvalProfileId: teamProfileId } } } });
    expect(sourceWrite, JSON.stringify(sourceWrite))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(await manager.execute('projects.sources.read', sourceAddress)).toMatchObject({ ok: true, result: {
      sessionDefaults: { revision: defaultsRevision, defaults: { approvalProfileId: projectProfileId } },
    } });

    // OWNER-1915: the Account owner sets its shared Source's defaults;
    // the audience's Team admin can read them without acquiring owner authority.
    const personalSourceResult = await owner.executeReviewed('projects.sources.create', { serverId: fixture.serverId,
      requestKey: randomUUID(), name: 'Shared personal project approvals',
      audience: [{ principal: { kind: 'team', teamId }, level: 'view' }] });
    expect(personalSourceResult.ok, JSON.stringify(personalSourceResult)).toBe(true);
    if (!personalSourceResult.ok) throw new Error(personalSourceResult.errorCode);
    const personalSource = ProjectSourcesReadOutputV1Schema.parse(personalSourceResult.result);
    if (!personalSource.ok) throw new Error(personalSource.error);
    const personalAddress = { serverId: fixture.serverId, sourceId: personalSource.source.id };
    const personalDefaults = await owner.executeAsPerson('projects.sources.update', { ...personalAddress,
      expectedRevision: personalSource.source.revision, patch: { sessionDefaults: { expectedRevision: 'absent',
        defaults: { approvalProfileId: projectProfileId } } } });
    if (!personalDefaults.ok) throw createActionExecuteFailureError(personalDefaults);
    expect(personalDefaults).toMatchObject({ ok: true, result: {
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
    const personalProjectStop = await stopAsAgent(personalProjectSession.sessionId);
    expect(personalProjectStop, JSON.stringify(personalProjectStop))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });

    // F6: a Machine preference is captured at birth; later edits cannot become
    // an admission-time picker for either an old id or an explicit Account choice.
    const machineDefault = async (id: string) => {
      expect(await manager.executeAsPerson('actions.policy.set', { profileChange: { kind: 'machine_default',
        machineId: machine.target.machineId, id } })).toMatchObject({ ok: true, result: {
        profileChange: { kind: 'machine_default', machineId: machine.target.machineId, id },
      } });
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
      expect(stopped.result, JSON.stringify(stopped)).toMatchObject({ stopped: true });
      expect(await fetchSessionV2(fixture.server.baseUrl, manager.credentials.token, stopped.childSessionId))
        .toMatchObject({ active: false });
    }
    const newMachineStop = await stopAsAgent(newMachineSession.sessionId);
    expect(newMachineStop, JSON.stringify(newMachineStop)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  }, 0);
});
