import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createIsolatedFakeClaudeControlShim } from '../../src/testkit/fakeClaude';
import { fetchSessionV2 } from '../../src/testkit/sessions';

describe('Shared approval profiles: native Team default', () => {
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
    const agent = await createIsolatedFakeClaudeControlShim({
      testDir: await mkdtemp(join(tmpdir(), 'ae-p03-f4-native-agent-')),
      invocationId: 'profile-team-default', captureEnvironmentKeys: [], logFullStdin: false,
    });
    const machine = await fixture.enrollDaemon(member, { env: { HAPPIER_CLAUDE_PATH: agent.executablePath } });
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
    expect(await member.executeAsPerson('actions.policy.set', { actionId: 'session.stop', audience: 'agent', mode: 'ask_first' }))
      .toMatchObject({ ok: true, result: { actionId: 'session.stop', mode: 'ask_first' } });
    expect(await member.executeAsPerson('actions.policy.set', { actionId: 'session.spawn_new', audience: 'agent', mode: 'allowed' }))
      .toMatchObject({ ok: true, result: { actionId: 'session.spawn_new', mode: 'allowed' } });
    const spawnInput = {
      executionTarget: machine.target, directory: { kind: 'path', path: machine.workspaceDir },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      primaryTeamId: teamId, terminal: { mode: 'plain' },
    };
    const spawned = await member.execute('session.spawn_new', spawnInput);
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.errorCode);
    const session = SessionSpawnNewActionResultV1Schema.parse(spawned.result);
    expect(session.type).toBe('success');
    if (session.type !== 'success') throw new Error('Team-default Session did not start');
    const inheritedMetadata = await member.readSessionMetadata(session.sessionId);
    expect(inheritedMetadata, JSON.stringify({ approvalProfileId: inheritedMetadata.approvalProfileId,
      approvalProfileTeamOrGroupDerived: inheritedMetadata.approvalProfileTeamOrGroupDerived })).toMatchObject({
      approvalProfileId: profileId, approvalProfileTeamOrGroupDerived: true,
    });
    const nativeSession = { sessionId: session.sessionId, logPath: agent.logPath };
    // Native creation records the real parent relation; a Session may stop its child, never itself.
    const childSpawned = await fixture.executeSessionMcpAction(member, nativeSession, 'session.spawn_new', spawnInput);
    expect(childSpawned.ok, JSON.stringify(childSpawned)).toBe(true);
    if (!childSpawned.ok) throw new Error(childSpawned.errorCode);
    const child = SessionSpawnNewActionResultV1Schema.parse(childSpawned.result);
    if (child.type !== 'success') throw new Error('Native parent did not create its child');
    expect(await fetchSessionV2(fixture.server.baseUrl, member.credentials.token, child.sessionId))
      .toMatchObject({ manager: { sessionId: session.sessionId }, active: true });
    // The inherited waiver cannot loosen the member's Ask. Picking that same id accepts its rows.
    const inheritedStop = await fixture.executeSessionMcpAction(member, nativeSession, 'session.stop', { sessionId: child.sessionId });
    expect(inheritedStop, JSON.stringify(inheritedStop))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    if (!inheritedStop.ok) throw new Error(inheritedStop.errorCode);
    const pending = ActionApprovalRequestCreatedResultSchema.parse(inheritedStop.result);
    expect(await member.executeAsPerson('approval.request.decide', { artifactId: pending.artifactId, decision: 'reject' }))
      .toMatchObject({ ok: true });
    expect(await fixture.executeSessionMcpAction(member, nativeSession, 'session.list', {}))
      .toMatchObject({ ok: false, errorCode: 'action_disabled' });
    const stored = await fetchSessionV2(fixture.server.baseUrl, member.credentials.token, session.sessionId);
    expect(await member.executeAsPerson('session.approval_profile.set', { sessionId: session.sessionId,
      serverId: fixture.serverId, expectedMetadataRevision: stored.metadataVersion, approvalProfileId: profileId }))
      .toMatchObject({ ok: true });
    expect((await member.readSessionMetadata(session.sessionId)).approvalProfileTeamOrGroupDerived ?? false).toBe(false);
    const accepted = await fixture.executeSessionMcpAction(member, nativeSession, 'session.stop', { sessionId: child.sessionId });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    if (!accepted.ok) throw new Error(accepted.errorCode);
    expect(accepted.result).toMatchObject({ stopped: true });
    expect(await fetchSessionV2(fixture.server.baseUrl, member.credentials.token, child.sessionId))
      .toMatchObject({ active: false });
  }, 0);

});
