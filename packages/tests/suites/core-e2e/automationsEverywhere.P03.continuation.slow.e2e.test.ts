import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createIsolatedFakeClaudeControlShim } from '../../src/testkit/fakeClaude';

describe('Shared approval profiles: native continuation', () => {
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

  it('AE.P03.SEC-continue-profile requires review before a retained inherited id becomes a personal pick', async () => {
    const member = await fixture.createAccount('continuing-member');
    const agent = await createIsolatedFakeClaudeControlShim({
      testDir: await mkdtemp(join(tmpdir(), 'ae-p03-continuation-agent-')),
      invocationId: 'profile-continuation', captureEnvironmentKeys: [], logFullStdin: false,
    });
    const machine = await fixture.enrollDaemon(member, { env: { HAPPIER_CLAUDE_PATH: agent.executablePath } });
    await fixture.assertKnownGoodSessionControl(member, machine);
    const teamResult = await owner.executeAsPerson('teams.create', { v: 1,
      initialOwnerAccountId: readAccountIdFromToken(owner.credentials.token), name: 'Continuation approvals', requestKey: randomUUID(),
    }, { presentUserConfirmation: { actionId: 'teams.create' } });
    expect(teamResult.ok, JSON.stringify(teamResult)).toBe(true);
    if (!teamResult.ok) throw new Error(teamResult.errorCode);
    const teamId = TeamSummaryV1Schema.parse(teamResult.result).id;
    expect(await owner.executeAsPerson('teams.members.add', { v: 1, teamId,
      accountId: readAccountIdFromToken(member.credentials.token), role: 'member', historyAccess: 'all_existing',
    }, { presentUserConfirmation: { actionId: 'teams.members.add' } })).toMatchObject({ ok: true });
    const profileResult = await owner.executeAsPerson('actions.policy.set', { profileChange: { kind: 'create', profile: {
      name: 'Inherited continuation profile', actions: { 'session.stop': { approvalRequiredSurfaces: [] } },
      approvalWaivedSurfaces: { 'session.stop': ['agent', 'mcp'] },
    } } });
    expect(profileResult.ok, JSON.stringify(profileResult)).toBe(true);
    if (!profileResult.ok) throw new Error(profileResult.errorCode);
    const profileChange = ActionPolicyOutputSchemas['actions.policy.set'].parse(profileResult.result);
    if (!('profileChange' in profileChange) || !('id' in profileChange.profileChange)
      || typeof profileChange.profileChange.id !== 'string') throw new Error('Profile create did not return its Artifact id');
    const profileId = profileChange.profileChange.id;
    expect(await owner.executeReviewed('artifact.access.grants.set', { artifactId: profileId,
      principal: { kind: 'team', teamId }, accessLevel: 'view' })).toMatchObject({ ok: true });
    expect(await owner.executeAsPerson('teams.policy.set', { v: 1, teamId,
      managedDefaults: { team: { approvalProfileId: profileId }, groups: {} },
    }, { presentUserConfirmation: { actionId: 'teams.policy.set' } })).toMatchObject({ ok: true });
    expect(await member.executeAsPerson('actions.policy.set', { actionId: 'session.stop', audience: 'agent', mode: 'ask_first' }))
      .toMatchObject({ ok: true, result: { actionId: 'session.stop', mode: 'ask_first' } });
    expect(await member.executeAsPerson('actions.policy.set', { actionId: 'session.spawn_new', audience: 'agent', mode: 'allowed' }))
      .toMatchObject({ ok: true, result: { actionId: 'session.spawn_new', mode: 'allowed' } });
    expect(await member.executeAsPerson('actions.policy.set', { actionId: 'session.approval_profile.set', audience: 'agent', mode: 'ask_first' }))
      .toMatchObject({ ok: true, result: { actionId: 'session.approval_profile.set', mode: 'ask_first' } });
    const input = { executionTarget: machine.target, directory: { kind: 'path' as const, path: machine.workspaceDir },
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      primaryTeamId: teamId, terminal: { mode: 'plain' as const } };
    const sourceResult = await member.execute('session.spawn_new', input);
    expect(sourceResult.ok, JSON.stringify(sourceResult)).toBe(true);
    if (!sourceResult.ok) throw new Error(sourceResult.errorCode);
    const source = SessionSpawnNewActionResultV1Schema.parse(sourceResult.result);
    if (source.type !== 'success') throw new Error('Inherited source Session did not start');
    const sourceMetadata = await member.readSessionMetadata(source.sessionId);
    expect(sourceMetadata).toMatchObject({
      approvalProfileId: profileId, approvalProfileTeamOrGroupDerived: true,
    });
    const executeFromSource = (actionId: ActionId, input: unknown) => fixture.executeSessionMcpAction(member,
      { sessionId: source.sessionId, logPath: agent.logPath }, actionId, input);
    const updatedAtMs = Date.now();
    for (const continuation of [
      { sourceContext: { v: 1, kind: 'session_replay', sourceSessionId: source.sessionId, forkPoint: { type: 'latest' } } },
      { configuration: { providerSessionResume: { kind: 'provider_session.v1', providerSessionId: 'retained-provider-session' },
        mode: { value: null, updatedAtMs }, model: { value: null, updatedAtMs, selectionSource: 'inherited' },
        permissionIntent: { value: null, updatedAtMs }, options: {} } },
    ]) {
      // A caller prefilling the source id cannot bypass the existing profile
      // control through either retainsConfiguration branch (SEC-REVIEW-BUILT).
      // The native Agent's real MCP transport supplies its live turn, applied
      // parent selection and causal permission; a Session selector cannot.
      const continued = await executeFromSource('session.spawn_new', { ...input, ...continuation, approvalProfileId: profileId });
      expect(continued.ok, JSON.stringify(continued)).toBe(true);
      if (!continued.ok) throw new Error(continued.errorCode);
      const review = ActionApprovalRequestCreatedResultSchema.parse(continued.result);
      expect(await member.executeAsPerson('approval.request.decide', { artifactId: review.artifactId, decision: 'reject' }))
        .toMatchObject({ ok: true });
    }
    expect(await member.readSessionMetadata(source.sessionId)).toMatchObject({
      approvalProfileId: profileId, approvalProfileTeamOrGroupDerived: true,
    });
    // The inherited Allow still cannot loosen the Account's Ask afterwards.
    expect(await executeFromSource('session.stop', { sessionId: source.sessionId }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  }, 0);

});
