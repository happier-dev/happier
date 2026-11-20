import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectUiActionClient, connectUiPersonActionClient } from '@happier-tests/ui-action-client';

import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { ActionExecuteResultSchema, createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { createCredentialedAccountArtifactStore } from '../../../../apps/cli/src/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { waitFor } from '../../src/testkit/timing';
import { repoRootDir } from '../../src/testkit/paths';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';

type OwnerReviewRequest = Readonly<{
  serverUrl: string;
  addressAnchorUrl: string;
  accountSecret: number[];
  artifactId: string;
  teamId: string;
}>;

const ownerReviewRequestPath = process.env.HAPPIER_E2E_PROFILE_REVOCATION_REVIEW_REQUEST;
if (ownerReviewRequestPath) {
  // A separate client process keeps the recipient's live UI Account mounted.
  // Only this case is registered in the child; it cannot start the fixture again.
  it('AE.P03.F8 isolated owner review', async () => {
    const request: OwnerReviewRequest = JSON.parse(await readFile(ownerReviewRequestPath, 'utf8'));
    const ownerUi = await connectUiPersonActionClient({ serverUrl: request.serverUrl,
      addressAnchorUrl: request.addressAnchorUrl, accountSecret: Uint8Array.from(request.accountSecret) });
    try {
      const result = await ownerUi.executeConfirmed('artifact.access.grants.remove', {
        artifactId: request.artifactId, principal: { kind: 'team', teamId: request.teamId },
      }, { surface: 'ui', authority: 'present_user', serverId: ownerUi.serverId, actionCaller: { kind: 'host' } });
      await writeFile(`${ownerReviewRequestPath}.result`, JSON.stringify(result), { mode: 0o600 });
    } finally { await ownerUi.close(); }
  }, 0);
} else {

describe('Shared approval profiles: recipients', () => {
  let fixture: TeamSetupFFixture;
  let owner: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  let recipient: typeof owner;
  let machine: Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;
  let teamId: string;
  let ui: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;

  beforeAll(async () => {
    fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'ae-p03-sharing-')),
      observeActionRequests: true });
    owner = await fixture.createAccount('owner');
    await fixture.claimHomeOwner(owner);
    recipient = await fixture.createAccount('recipient');
    machine = await fixture.enrollDaemon(recipient);
    await fixture.assertKnownGoodSessionControl(recipient, machine);
    const team = await owner.executeAsPerson('teams.create', { v: 1, initialOwnerAccountId: readAccountIdFromToken(owner.credentials.token), name: 'Shared approvals', requestKey: randomUUID() },
      { presentUserConfirmation: { actionId: 'teams.create' } });
    expect(team.ok, JSON.stringify(team)).toBe(true);
    if (!team.ok) throw new Error(team.errorCode);
    teamId = TeamSummaryV1Schema.parse(team.result).id;
    expect(await owner.executeAsPerson('teams.members.add', { v: 1, teamId, role: 'member', historyAccess: 'from_membership',
      accountId: readAccountIdFromToken(recipient.credentials.token) },
    { presentUserConfirmation: { actionId: 'teams.members.add' } })).toMatchObject({ ok: true });
  }, 0);
  afterEach(async () => { await ui?.close(); ui = undefined; }, 0);
  afterAll(async () => { await fixture?.stop(); }, 0);

  async function connectRecipient() {
    ui = await connectUiActionClient({ serverUrl: fixture.actionServerApiUrl, addressAnchorUrl: fixture.server.baseUrl, credentials: recipient.uiCredentials });
    await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machine.target.machineId), { timeoutMs: 60_000 });
    return { surface: 'ui' as const, authority: 'present_user' as const, serverId: ui.serverId,
      actionCaller: { kind: 'host' as const } };
  }

  async function uiProfiles() {
    if (!ui) throw new Error('Recipient UI is not connected');
    const result = await ui.execute('actions.policy.get', { profiles: true }, { surface: 'ui', authority: 'present_user',
      serverId: ui.serverId, actionCaller: { kind: 'host' } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    const listed = ActionPolicyOutputSchemas['actions.policy.get'].parse(result.result);
    if (!('profiles' in listed)) throw new Error('UI profile list missing');
    return listed.profiles;
  }

  async function createSharedProfile() {
    const created = await owner.executeAsPerson('actions.policy.set', { profileChange: { kind: 'create', profile: {
      name: 'Shared stop policy', actions: { 'session.stop': { approvalRequiredSurfaces: [] } },
      approvalWaivedSurfaces: { 'session.stop': ['agent', 'mcp'] },
    } } });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.errorCode);
    const result = ActionPolicyOutputSchemas['actions.policy.set'].parse(created.result);
    if (!('profileChange' in result) || result.profileChange.kind !== 'create') throw new Error('Profile creation did not return its Artifact');
    const profile = result.profileChange;
    const granted = await owner.executeReviewed('artifact.access.grants.set', { artifactId: profile.id,
      principal: { kind: 'team', teamId }, accessLevel: 'view' });
    const creation = !granted.ok ? await runWithServerHttpBaseUrl(fixture.actionServerApiUrl, async () => {
      const [ownerRead, recipientRead] = await Promise.all([
        createCredentialedAccountArtifactStore(owner.credentials).read(profile.id),
        createCredentialedAccountArtifactStore(recipient.credentials).read(profile.id),
      ]);
      return { profileId: profile.id, expectedOwner: readAccountIdFromToken(owner.credentials.token),
        ownerRead: ownerRead ? { ownerAccountId: ownerRead.ownerAccountId, access: ownerRead.access } : null,
        recipientRead: recipientRead ? { ownerAccountId: recipientRead.ownerAccountId, access: recipientRead.access } : null };
    }) : undefined;
    expect(granted.ok, JSON.stringify({ granted, creation })).toBe(true);
    return profile;
  }

  async function profiles(account: typeof owner) {
    const result = await account.execute('actions.policy.get', { profiles: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    const listed = ActionPolicyOutputSchemas['actions.policy.get'].parse(result.result);
    if (!('profiles' in listed)) throw new Error('Profile list missing');
    return listed.profiles;
  }

  it('AE.P03.F2-share publishes a Can-use Team grant through the existing Artifact owner', async () => {
    const profile = await createSharedProfile();
    expect(await profiles(recipient)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: profile.id, access: 'view' }),
    ]));
    await connectRecipient();
    expect(await uiProfiles()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: profile.id, access: 'view' }),
    ]));
    expect(await owner.executeReviewed('artifact.access.grants.list', { artifactId: profile.id })).toMatchObject({ ok: true,
      result: { grants: [expect.objectContaining({ principal: { kind: 'team', teamId }, accessLevel: 'view' })] } });
  }, 0);

  it('AE.P03.F3-use-shared lets a recipient pick the profile while refusing Can-use edits', async () => {
    const profile = await createSharedProfile();
    const context = await connectRecipient();
    expect(await uiProfiles()).toEqual(expect.arrayContaining([expect.objectContaining({ id: profile.id, access: 'view' })]));
    const spawned = await ui!.execute('session.spawn_new', {
      executionTarget: machine.target, directory: { kind: 'path', path: machine.workspaceDir },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      terminal: { mode: 'plain' }, approvalProfileId: profile.id,
    }, context);
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.errorCode);
    const session = SessionSpawnNewActionResultV1Schema.parse(spawned.result);
    expect(session.type).toBe('success');
    if (session.type !== 'success') throw new Error('Shared-profile Session did not start');
    expect((await recipient.readSessionMetadata(session.sessionId)).approvalProfileId).toBe(profile.id);
    expect(await recipient.executeWithApproval('actions.policy.set', { profileChange: { kind: 'update', id: profile.id,
      expectedRevision: profile.revision, profile: { name: 'Recipient rewrite' } } }, artifactId =>
      ui!.executeConfirmed('approval.request.decide', { artifactId, decision: 'approve' }, context))).toMatchObject({
      ok: false, errorCode: 'forbidden',
    });
    expect(await ui!.executeConfirmed('actions.policy.set', { profileChange: { kind: 'update', id: profile.id,
      expectedRevision: profile.revision, profile: { name: 'Recipient UI rewrite' } } }, context)).toMatchObject({
      ok: false, errorCode: 'forbidden',
    });
  }, 0);

  it('AE.P03.F8-revoke-edit drops revoked profile rows before the next recipient admission', async () => {
    const profile = await createSharedProfile();
    expect(await recipient.executeAsPerson('actions.policy.set', { actionId: 'session.stop', audience: 'agent', mode: 'ask_first' }))
      .toMatchObject({ ok: true, result: { actionId: 'session.stop', mode: 'ask_first' } });
    const spawned = await recipient.executeReviewed('session.spawn_new', {
      executionTarget: machine.target, directory: { kind: 'path', path: machine.workspaceDir },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      terminal: { mode: 'plain' }, approvalProfileId: profile.id,
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.errorCode);
    const session = SessionSpawnNewActionResultV1Schema.parse(spawned.result);
    if (session.type !== 'success') throw new Error('Revocation Session did not start');
    await connectRecipient();
    expect(await profiles(recipient)).toEqual(expect.arrayContaining([expect.objectContaining({ id: profile.id })]));
    expect(await uiProfiles()).toEqual(expect.arrayContaining([expect.objectContaining({ id: profile.id })]));
    const reviewDir = await mkdtemp(join(tmpdir(), 'ae-p03-owner-review-'));
    const requestPath = join(reviewDir, 'request.json');
    const request: OwnerReviewRequest = { serverUrl: fixture.actionServerApiUrl,
      addressAnchorUrl: fixture.server.baseUrl, accountSecret: Array.from(owner.auth.accountSigningSeed),
      artifactId: profile.id, teamId };
    await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
    try {
      await runLoggedCommand({ command: process.execPath,
        args: ['scripts/run-vitest-with-heartbeat.mjs', '--config', 'vitest.core.slow.config.ts',
          'suites/core-e2e/automationsEverywhere.P03.sharing.slow.e2e.test.ts',
          '--testNamePattern', '^AE\\.P03\\.F8 isolated owner review$'],
        cwd: join(repoRootDir(), 'packages/tests'),
        env: { ...process.env, HAPPIER_E2E_PROFILE_REVOCATION_REVIEW_REQUEST: requestPath },
        stdoutPath: join(reviewDir, 'owner-review.stdout.log'), stderrPath: join(reviewDir, 'owner-review.stderr.log'),
        timeoutMs: null });
      const revoked = ActionExecuteResultSchema.parse(JSON.parse(await readFile(`${requestPath}.result`, 'utf8')));
      if (!revoked.ok) throw createActionExecuteFailureError(revoked);
      expect(revoked).toMatchObject({ ok: true, result: { artifactId: profile.id, changed: true } });
    } finally {
      await Promise.all([rm(requestPath, { force: true }), rm(`${requestPath}.result`, { force: true })]);
    }
    expect(await profiles(recipient)).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: profile.id })]));
    await waitFor(async () => !(await uiProfiles()).some(row => row.id === profile.id), { timeoutMs: 60_000 });
    const caller = { surface: 'mcp' as const, authority: 'account_automation' as const,
      defaultSessionId: session.sessionId,
      actionCaller: { kind: 'session' as const, sessionId: session.sessionId, starterDepth: 0, turnDepth: 0 } };
    const expectedMissing = { ok: true, result: { kind: 'approval_request_created',
      approvalProfile: { status: 'missing', requestedId: profile.id } } };
    const cliAdmission = await recipient.execute('session.stop', { sessionId: session.sessionId }, caller);
    expect(cliAdmission, JSON.stringify(cliAdmission)).toMatchObject(expectedMissing);
    const uiAdmission = await ui!.execute('session.stop', { sessionId: session.sessionId }, { ...caller, serverId: ui!.serverId });
    expect(uiAdmission, JSON.stringify(uiAdmission)).toMatchObject(expectedMissing);
    // Confirm the read so an approval request cannot stand in for the access result.
    // The Artifact owner withholds inaccessible documents through its nullable read.
    const refusedRead = await ui!.executeConfirmed('artifact.get', { artifactId: profile.id }, {
      surface: 'ui', authority: 'present_user', serverId: ui!.serverId, actionCaller: { kind: 'host' },
    });
    expect(refusedRead, JSON.stringify(refusedRead)).toEqual({ ok: true, result: { artifact: null } });
  }, 0);
});
}
