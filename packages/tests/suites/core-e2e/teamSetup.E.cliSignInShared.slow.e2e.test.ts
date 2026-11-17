import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';

let fixture: TeamSetupFFixture;
let owner: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
let member: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
let machine: Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;

beforeAll(async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'team-setup-e-cli-shared-'));
  const nativeConfig = join(testDir, 'gh-config');
  const nativeHome = join(testDir, 'native-home');
  const nativeGitGlobal = join(testDir, 'git-global');
  const nativeGitSystem = join(testDir, 'git-system');
  await Promise.all([mkdir(nativeConfig), mkdir(nativeHome), writeFile(nativeGitGlobal, ''), writeFile(nativeGitSystem, '')]);
  fixture = await startTeamSetupFFixture({ testDir });
  owner = await fixture.createAccount('native-owner');
  member = await fixture.createAccount('native-member');
  machine = await fixture.enrollDaemon(owner, { env: { GH_CONFIG_DIR: nativeConfig,
    HOME: nativeHome, USERPROFILE: nativeHome, GIT_CONFIG_GLOBAL: nativeGitGlobal, GIT_CONFIG_SYSTEM: nativeGitSystem,
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined } });
  await fixture.assertKnownGoodSessionControl(owner, machine);
});
afterAll(async () => { await fixture?.stop(); });

it('TS.E.S4 admits shared-OS native login only with Manage through the real sign-in Action', async () => {
  expect(await owner.execute('machines.agents.signIn.status', { machineId: machine.target.machineId, agentId: 'claude' }))
    .toMatchObject({ ok: true, result: { nativeLogin: 'login_terminal' } });
  const principal = { kind: 'account' as const, accountId: readAccountIdFromToken(member.credentials.token) };
  if (!principal.accountId) throw new Error('Requester account identity unavailable');
  const grantConfirmation = { presentUserConfirmation: { actionId: 'machines.access.grant.set' as const } };
  const useGrant = await owner.executeAsPerson('machines.access.grant.set', { ...machine.target, principal, level: 'use' }, grantConfirmation);
  expect(useGrant, useGrant.ok ? undefined : useGrant.errorCode).toMatchObject({ ok: true });
  // The canonical status route requires Use. Shared-OS native login still
  // requires Manage from the existing terminal execution-identity owner.
  const memberStatus = await member.execute('machines.agents.signIn.status', { machineId: machine.target.machineId, agentId: 'claude' });
  expect(memberStatus, JSON.stringify(memberStatus)).toMatchObject({ ok: true, result: { nativeLogin: 'login_terminal' } });
  const request = { machineId: machine.target.machineId, agentId: 'happier.scm.forge.github/gh', method: 'native' };
  // This is a real installed gh and an empty private config; no fake CLI.
  const startConfirmation = { presentUserConfirmation: { actionId: 'machines.agents.signIn.start' as const } };
  expect(await member.execute('machines.agents.signIn.start', request, startConfirmation))
    .toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
  const manageGrant = await owner.executeAsPerson('machines.access.grant.set', { ...machine.target, principal, level: 'admin' }, grantConfirmation);
  expect(manageGrant, manageGrant.ok ? undefined : manageGrant.errorCode).toMatchObject({ ok: true });
  const opened = await member.execute('machines.agents.signIn.start', request, startConfirmation);
  expect(opened).toMatchObject({ ok: true, result: { terminalId: expect.any(String) } });
  if (!opened.ok || !opened.result || typeof opened.result !== 'object'
    || !('terminalId' in opened.result) || typeof opened.result.terminalId !== 'string')
    throw new Error('Manage native sign-in refused');
  expect(await member.execute('machines.agents.signIn.cancel', { machineId: machine.target.machineId,
    agentId: request.agentId, terminalId: opened.result.terminalId },
  { presentUserConfirmation: { actionId: 'machines.agents.signIn.cancel' } })).toMatchObject({ ok: true, result: { ok: true } });
});
