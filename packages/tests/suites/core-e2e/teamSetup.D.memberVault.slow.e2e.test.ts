import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectUiActionClient } from '@happier-tests/ui-action-client';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { TeamInvitationCreateResultV1Schema } from '@happier-dev/protocol/teams/invitation';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { SharedSavedSecretMutationOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { SavedSecretResourceContentV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceContentSchemaV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createRunDirs } from '../../src/testkit/runDir';
import { createIsolatedFakeClaudeControlShim, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'team-member-vault' });

describe('Team setup member-local vault references', () => {
  let fixture: TeamSetupFFixture | undefined;
  const clients: Awaited<ReturnType<typeof connectUiActionClient>>[] = [];

  afterEach(async () => {
    const failures: unknown[] = [];
    for (const close of [...clients.splice(0).map(client => () => client.close()),
      () => fixture?.stop()]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    fixture = undefined;
    if (failures.length) throw new AggregateError(failures, 'Member vault fixture cleanup failed');
  });

  it('TS.D.memberVault shares only references and acquires each member native vault through their real daemon', async () => {
    const testDir = run.testDir('member-vault');
    fixture = await startTeamSetupFFixture({ testDir });
    const baseUrl = fixture.server.baseUrl;
    const member = async (name: string, invitationToken?: string) => {
      const directory = join(testDir, name);
      const bin = join(directory, 'bin');
      const workspace = join(directory, 'workspace');
      await Promise.all([mkdir(bin, { recursive: true }), mkdir(workspace, { recursive: true })]);
      const account = await fixture!.createAccount(name);
      const ui = await connectUiActionClient({ serverUrl: baseUrl, credentials: account.uiCredentials });
      clients.push(ui);
      await waitFor(() => ui.isAccountReady(), { timeoutMs: 60_000 });
      if (invitationToken) {
        expect(await ui.executeConfirmed('teams.invitations.accept', { v: 1, token: invitationToken }, {
          surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: ui.serverId,
        })).toMatchObject({ ok: true });
      }
      const sentinel = `synthetic-${name}-vault-value`;
      // The external 1Password CLI is the boundary. Each daemon has a distinct native identity.
      await writeFile(join(bin, 'op'), `#!${process.execPath}\nif (process.argv[2] === 'whoami') { process.stdout.write(${JSON.stringify(name)}); process.exit(0); }\nif (process.argv[2] !== 'read' || process.argv[3] !== 'op://Development/API/token') process.exit(1);\nprocess.stdout.write(${JSON.stringify(sentinel)});\n`, { mode: 0o700 });
      const agent = await createIsolatedFakeClaudeControlShim({ testDir: directory, invocationId: name,
        captureEnvironmentKeys: ['TEAM_VAULT_SENTINEL'], logFullStdin: false });
      const enrolled = await fixture!.enrollDaemon(account, { env: {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, HAPPIER_CLAUDE_PATH: agent.executablePath,
      } });
      const machineId = enrolled.target.machineId;
      await waitFor(() => ui.isAccountReady() && ui.isMachineActive(machineId), { timeoutMs: 60_000 });
      return { account, ui, machineId, workspace, agent, sentinel, opPath: join(bin, 'op') };
    };
    const first = await member('member-a');
    const ui = first.ui;
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const }, serverId: ui.serverId };
    expect(await ui.execute('machines.setup.plan', {
      homeId: ui.serverId, machineId: first.machineId,
    }, context)).toMatchObject({ ok: true });
    await fixture.claimHomeOwner(first.account);
    const control = await ui.executeConfirmed('daemon.filesystem.listDirectory', {
      rootPath: first.workspace, path: '.',
    }, { ...context, externalActionTarget: { kind: 'machine', machineId: first.machineId } });
    expect(control).toMatchObject({ ok: true, result: { success: true, entries: [] } });
    const created = await ui.executeConfirmed('teams.create', { v: 1, name: 'Vault reference test',
      initialOwnerAccountId: readAccountIdFromToken(first.account.credentials.token), requestKey: randomUUID() }, context);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(`Team creation failed: ${created.errorCode}`);
    const team = TeamSummaryV1Schema.parse(created.result);
    const content = SavedSecretResourceContentV1Schema.parse({ v: 2, name: 'Development API', kind: 'token',
      source: { kind: 'external', contribution: { pluginId: 'happier.secret-source.onepassword', localId: 'onepassword' },
        account: 'team.1password.com', reference: 'op://Development/API/token',
        metadata: { vault: { id: 'development', name: 'Development' }, item: { id: 'api', title: 'API' },
          field: { id: 'token', title: 'token', kind: 'CONCEALED' } } } });
    const resourceId = randomUUID();
    const shared = await ui.executeConfirmed('secrets.shared.create', { resourceId, displayName: content.name, kind: content.kind,
      encryptionMode: 'plain', storedContent: { t: 'plain', v: content }, teamGrants: [team.id] }, context);
    expect(shared).toMatchObject({ ok: true });
    if (!shared.ok) throw new Error(`Reference sharing failed: ${shared.errorCode}`);
    expect(SharedSavedSecretMutationOutputV1Schema.parse(shared.result)).toMatchObject({ resourceId, revision: 1 });
    const invitation = await ui.executeConfirmed('teams.invitations.create', { v: 1, teamId: team.id,
      role: 'member', historyAccess: 'from_membership', recipientEmail: null, requestKey: randomUUID() }, context);
    expect(invitation.ok).toBe(true);
    if (!invitation.ok) throw new Error(`Invitation refused: ${invitation.errorCode}`);
    const { joinUrl } = TeamInvitationCreateResultV1Schema.parse(invitation.result);
    if (!joinUrl) throw new Error('Invitation join URL missing');
    const token = new URL(joinUrl).pathname.split('/').at(-1);
    if (!token) throw new Error('Invitation token missing');
    const launchWithOwnVault = async (requester: Awaited<ReturnType<typeof member>>, unavailable = false) => {
      const requesterContext = { ...context, serverId: requester.ui.serverId };
      const profileId = randomUUID();
      const profile = await requester.ui.executeConfirmed('launch_profiles.create', { expectedRevision: 'absent',
        profile: { v: 2, id: profileId, name: 'Member vault task', createdAt: 1, updatedAt: 1,
          envVarRequirements: [{ name: 'TEAM_VAULT_SENTINEL', kind: 'secret', required: true }] } }, requesterContext);
      expect(profile).toMatchObject({ ok: true, result: { status: 'updated' } });
      const launched = await requester.ui.executeConfirmed('session.spawn_new', {
        executionTarget: { serverId: requester.ui.serverId, machineId: requester.machineId },
        directory: { kind: 'path', path: requester.workspace }, profileId,
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        terminal: { mode: 'plain' }, secretReferenceOverlay: { v: 1,
          bindings: { TEAM_VAULT_SENTINEL: { ref: formatSharedSavedSecretRefV1(resourceId), revision: 1 } } },
      }, requesterContext);
      if (unavailable) {
        expect(launched).toMatchObject({ ok: true, result: { type: 'error', code: 'spawn_failed',
          providerError: { code: 'provider_secret_unavailable', savedSecretReason: 'reference_unavailable' } } });
        return;
      }
      expect(launched).toMatchObject({ ok: true, result: { type: 'success' } });
      const invocation = await waitForFakeClaudeInvocation(requester.agent.logPath, value => value.mode === 'sdk');
      expect(invocation.environmentAttestation).toMatchObject({ TEAM_VAULT_SENTINEL: {
        present: true, sha256: createHash('sha256').update(requester.sentinel).digest('hex'),
      } });
    };
    await launchWithOwnVault(first);
    await first.ui.close();
    clients.splice(clients.indexOf(first.ui), 1);
    const second = await member('member-b', token);
    await launchWithOwnVault(second);
    // A's available vault must never rescue B's failed native acquisition.
    await writeFile(second.opPath, `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
    await launchWithOwnVault(second, true);
  });
});
