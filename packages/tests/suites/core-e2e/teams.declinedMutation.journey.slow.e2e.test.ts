import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { createCliActionExecutorFromCredentials } from '../../../../apps/cli/src/session/actions/createCliActionExecutorFromCredentials';
import { teamCreateFailureLabel, teamMutationFailureLabel } from '../../../../apps/ui/sources/components/settings/teams/teamMutationPresentation';
import { createRunDirs } from '../../src/testkit/runDir';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';

const run = createRunDirs({ runLabel: 'teams-declined-mutation' });
let fixture: TeamSetupFFixture | undefined;
let postgres: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
afterEach(async () => {
  try { await fixture?.stop(); } finally {
    await postgres?.stop(); fixture = undefined; postgres = undefined;
  }
}, 0);

it('a member can approve a Team mutation, then reject or cancel it without an effect or a permission failure', async () => {
  postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  fixture = await startTeamSetupFFixture({ testDir: run.testDir('decline'), dbProvider: 'postgres',
    serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl } });
  const member = await fixture.createAccount('member');
  await fixture.claimHomeOwner(member);
  const machine = await fixture.enrollDaemon(member);
  await fixture.assertKnownGoodMachineControl(member, machine);
  expect(await member.execute('machines.command.run', { command: 'echo team-approval-control' }, {
    presentUserConfirmation: { actionId: 'machines.command.run' },
    externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir } },
  })).toMatchObject({ ok: true, result: { exitCode: 0, stdout: expect.stringContaining('team-approval-control') } });
  const created = await member.executeReviewed('teams.create', { v: 1, name: 'Before approval',
    requestKey: randomUUID(), initialOwnerAccountId: readAccountIdFromToken(member.auth.token) });
  expect(created).toMatchObject({ ok: true });
  if (!created.ok) throw new Error(`Team creation refused (${created.errorCode})`);
  const team = TeamSummaryV1Schema.parse(created.result);
  const policy = await member.execute('actions.policy.set', {
    actionId: 'teams.update', audience: 'cli', mode: 'ask_first',
  }, { presentUserConfirmation: { actionId: 'actions.policy.set' } });
  expect(policy, JSON.stringify(policy)).toMatchObject({ ok: true });
  expect(await member.execute('actions.policy.get', { actionId: 'teams.update', audience: 'cli' }))
    .toMatchObject({ ok: true, result: { mode: 'ask_first' } });

  // The identical authenticated CLI waiter first proves that an accepted Ask
  // changes this Team. A broken fixture must not masquerade as a refusal RED.
  for (const decision of ['approve', 'reject', 'cancel'] as const) {
    let requested = false;
    const lifetime = new AbortController();
    const executor = createCliActionExecutorFromCredentials({ credentials: member.credentials,
      readCredentials: async () => member.credentials, serverId: fixture.serverId,
      serverIdentityId: fixture.serverId, serverApiUrl: fixture.actionServerApiUrl,
      onApprovalRequested: async artifactId => {
        requested = true;
        const decided = await member.execute('approval.request.decide', { artifactId, decision });
        expect(decided).toMatchObject({ ok: true });
      },
    }).bindInvocation(lifetime.signal, { actionId: 'teams.update', signal: lifetime.signal, surface: 'cli' });
    const result = await executor.execute('teams.update', {
      v: 1, teamId: team.id, name: decision === 'approve' ? 'Approved' : 'Must not be written',
    }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: fixture.serverId, serverIdentityId: fixture.serverId, actionRequestId: randomUUID(),
      signal: lifetime.signal }).finally(() => lifetime.abort());
    expect(requested, `${decision} reaches the real Inbox Ask: ${JSON.stringify(result)}`).toBe(true);
    if (decision === 'approve') {
      expect(result).toMatchObject({ ok: true });
    } else {
      expect(result).toMatchObject({ ok: false,
        errorCode: decision === 'reject' ? 'approval_rejected' : 'approval_canceled' });
      if (result.ok) throw new Error('Declined mutation executed');
      // The Team presenter consumes this canonical classifier to stay silent.
      expect(isActionApprovalDeclinedErrorCode(result.errorCode)).toBe(true);
      expect(isActionApprovalDeclinedErrorCode('team_forbidden')).toBe(false);
      const failure = { kind: 'forbidden' as const, retryable: false, code: result.errorCode };
      expect(teamMutationFailureLabel(failure)).toBeNull();
      expect(teamCreateFailureLabel(failure, false)).toBeNull();
      expect(teamMutationFailureLabel({ ...failure, code: 'team_forbidden' })).not.toBeNull();
    }
    const read = await member.execute('teams.get', { v: 1, teamId: team.id });
    expect(read).toMatchObject({ ok: true, result: { id: team.id, name: 'Approved' } });
  }
}, 0);
