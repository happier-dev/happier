import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { requesterSessionCredentialPath } from '../sessionEncryption/requesterSessionCredentials';
import { createOnChildExited } from '../sessions/onChildExited';
import { readStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import { createRunnerIsolationIdentity } from '../agentRuntime/runnerIsolationIdentity';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The listener is an OS boundary. Retained custody, Account admission, runtime
// construction, directory selection and ordinary Resume all remain real.
vi.mock('@/daemon/controlServer', async original => ({
  ...await original<typeof import('@/daemon/controlServer')>(),
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
  },
}));
afterEach(() => { vi.restoreAllMocks(); boundary.control = null; });

it.each(['unchanged', 'renewed', 'other-account'] as const)('native runner admits the exact ordinary Account with %s sign-in', async signIn => {
  const origin = { serverIdentityId: 'srv_ordinary_runner', machineId: 'machine' };
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    ordinaryAccountSession: true, externalActionAccountId: 'requester', homeServerIdentityId: origin.serverIdentityId,
    resolveCurrentMachineExecutionOriginContext: async () => origin,
  });
  const credentials = await readStoredCredentialsForServerId('session-home');
  if (!credentials) throw new Error('Missing fixture credentials');
  if (signIn !== 'unchanged') {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: signIn === 'renewed' ? 'requester' : 'another-account',
      jti: 'runner-renewal', provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
    await writeStoredCredentialsForServerId('session-home', { token, encryption: null });
  }
  const identity = createRunnerIsolationIdentity({ signal: h.signal, serverId: 'session-home',
    serverBaseUrl: 'https://session-home.test', machineId: 'machine', sessionId: h.sessionId,
    credentials, custodianAccountId: 'requester', tracked: h.tracked, origin,
    readOrigin: async () => origin, isCurrent: () => true, releaseRuntime: async () => {},
  });
  await expect(identity.resolve()).resolves.toMatchObject(signIn === 'other-account'
    ? { kind: 'unknown', reason: 'session_requester_unavailable' }
    : { kind: 'isolated', separationRequired: false, requester: { accountId: 'requester' } });
});

it('prefetch starts the requester qualification before the first native launch, which reuses it', async () => {
  const origin = { serverIdentityId: 'srv_ordinary_prefetch', machineId: 'machine' };
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    ordinaryAccountSession: true, externalActionAccountId: 'requester', homeServerIdentityId: origin.serverIdentityId,
    resolveCurrentMachineExecutionOriginContext: async () => origin,
  });
  const credentials = await readStoredCredentialsForServerId('session-home');
  if (!credentials) throw new Error('Missing fixture credentials');
  const homeSessionReads = () => vi.mocked(axios.get).mock.calls.filter(([url]) => String(url).includes('/v2/sessions/')).length;
  const identity = createRunnerIsolationIdentity({ signal: h.signal, serverId: 'session-home',
    serverBaseUrl: 'https://session-home.test', machineId: 'machine', sessionId: h.sessionId,
    credentials, custodianAccountId: 'requester', tracked: h.tracked, origin,
    readOrigin: async () => origin, isCurrent: () => true, releaseRuntime: async () => {},
  });
  const beforePrefetch = homeSessionReads();
  identity.prefetch();
  // The Home qualification read starts at invocation creation, not at the first launch.
  await vi.waitFor(() => expect(homeSessionReads()).toBe(beforePrefetch + 1));
  await expect(identity.resolve()).resolves.toMatchObject({ kind: 'isolated', requester: { accountId: 'requester' } });
  await expect(identity.resolve()).resolves.toMatchObject({ kind: 'isolated' });
  expect(homeSessionReads()).toBe(beforePrefetch + 1);
});

it.each(['unchanged', 'renewed', 'other-account', 'other-daemon-account'] as const)('ordinary owner Resume preserves Account binding with %s sign-in', async signIn => {
  const home = 'srv_ordinary_resume';
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    ordinaryAccountSession: true,
    externalActionAccountId: signIn === 'other-daemon-account' ? 'another-account' : 'requester', homeServerIdentityId: home,
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
  });
  h.tracked.pid = 2_147_000_000;
  h.tracked.sessionRunnerPid = h.tracked.pid;
  h.tracked.stopRequestedAtMs = Date.now();
  h.trackedSessionsByKey.clear();
  h.trackedSessionsByKey.set(h.tracked.trackingKey, h.tracked);
  const exited = createOnChildExited({ trackedSessionsByKey: h.trackedSessionsByKey,
    spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null });
  await exited(h.tracked.pid, { reason: 'process-exited', code: 0, signal: null });
  h.trackedSessionsByKey.clear();
  if (signIn === 'renewed' || signIn === 'other-account') {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: signIn === 'renewed' ? 'requester' : 'another-account',
      jti: 'renewed-terminal', provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
    await writeStoredCredentialsForServerId('session-home', {
      token, encryption: null,
    });
    if (signIn === 'renewed') {
      // Home is the authority boundary: only the renewed fixture bearer can
      // qualify this Session. A JWT subject comparison cannot substitute it.
      const read = vi.mocked(axios.get).getMockImplementation()!;
      vi.mocked(axios.get).mockImplementation(async (...args) => {
        if (String(args[0]).includes('/v2/sessions/') && args[1]?.headers?.Authorization !== `Bearer ${token}`) {
          throw new Error('Retired fixture bearer');
        }
        return read(...args);
      });
    }
  }
  await expect(h.daemon.spawnSession({ existingSessionId: h.sessionId, directory: h.cwd,
    environmentVariables: { 'INVALID=KEY': 'fixture' } }))
    .resolves.toMatchObject({ type: 'error', errorCode: signIn === 'other-account' || signIn === 'other-daemon-account'
      ? 'DAEMON_RPC_UNAVAILABLE' : 'INVALID_ENVIRONMENT_VARIABLES' });
});

it('keeps persisted requester birth through Stop, physical exit and cold Resume', async () => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control);
  const birth = h.requester;
  const path = requesterSessionCredentialPath({ happyHomeDir: h.f.directory,
    sessionId: h.sessionId, attribution: birth.bootstrap.attribution });
  h.tracked.pid = 2_147_000_000;
  h.tracked.sessionRunnerPid = h.tracked.pid;
  h.tracked.stopRequestedAtMs = Date.now();
  h.trackedSessionsByKey.clear();
  h.trackedSessionsByKey.set(h.tracked.trackingKey, h.tracked);
  const exited = createOnChildExited({ trackedSessionsByKey: h.trackedSessionsByKey,
    spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null });
  await exited(h.tracked.pid, { reason: 'process-exited', code: 0, signal: null });
  await expect(access(path)).resolves.toBeUndefined();
  expect(h.tracked.requesterSessionRuntimeContext).toBeUndefined();
  // A cold daemon has no retained PID/attribution hints. Home terminal
  // publication is outside this fixture; discard that in-memory census.
  h.trackedSessionsByKey.clear();
  await expect(h.daemon.spawnSession({ existingSessionId: h.sessionId, directory: h.cwd,
    environmentVariables: { 'INVALID=KEY': 'fixture' } }))
    .resolves.toMatchObject({ type: 'error', errorCode: 'INVALID_ENVIRONMENT_VARIABLES' });
  expect(h.readRequesterRecoveryStage()).toBe('ready');
  const recovered = await h.resolveRequesterRuntime(h.sessionId);
  expect(recovered?.activeServerDir).toBe(birth.activeServerDir);
  expect(recovered?.connectedServicesMaterializationBaseDir).toBe(birth.connectedServicesMaterializationBaseDir);
  await recovered?.dispose();
});

it.each([
  { state: 'retained', sameAccount: false }, { state: 'cold', sameAccount: false }, { state: 'unavailable', sameAccount: false },
  { state: 'cold-unattributed', sameAccount: false },
  { state: 'retained', sameAccount: true }, { state: 'cold', sameAccount: true }, { state: 'unavailable', sameAccount: true },
  { state: 'cold-unattributed', sameAccount: true },
] as const)(
  'ordinary Resume keeps the birth Account home with $state custody (same Account: $sameAccount)', async ({ state, sameAccount }) => {
    const ownerCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester',
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
    const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, false, undefined, undefined,
      sameAccount ? { credentials: ownerCredentials, accountActionCredentials: ownerCredentials,
        externalActionAccountId: 'requester', machineAccess: { custodianAccountId: 'requester', role: 'manage' },
        resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: 'srv_installed_project_fixture' }) } : undefined);
    const birth = h.requester;
    const attribution = birth.bootstrap.attribution;
    expect(birth.activeServerDir).toBe(join(h.f.directory, 'requester-accounts', `account-${attribution.accountId}`));
    expect(birth.connectedServicesMaterializationBaseDir)
      .toBe(join(h.f.directory, 'requester-connected-services', 'requester-accounts', `account-${attribution.accountId}`));
    // Keep the retained Session stamp but no living process. Resume must recover
    // the same private birth even when its original runtime has been retired.
    h.tracked.pid = 2_147_000_000;
    h.tracked.sessionRunnerPid = h.tracked.pid;
    if (state !== 'retained') {
      delete h.tracked.requesterSessionRuntimeContext;
      await birth.dispose();
    }
    if (state === 'cold-unattributed') delete h.tracked.requesterWorkAttributionV1;
    if (state === 'unavailable') {
      // Corrupt only this test's synthetic private file: a present, unreadable
      // birth must never become ordinary custodian Account credentials.
      await writeFile(requesterSessionCredentialPath({ happyHomeDir: h.f.directory, sessionId: h.sessionId, attribution }), '{}');
    }
    const resume = h.daemon.spawnSession({ existingSessionId: h.sessionId, directory: h.cwd,
      // Stop at input validation after Account selection, before any native effect.
      environmentVariables: { 'INVALID=KEY': 'fixture' } });
    if (state === 'unavailable') {
      if (sameAccount) await expect(resume).resolves.toMatchObject({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' });
      else await expect(resume).rejects.toMatchObject({ code: 'requester_session_not_current' });
      expect(h.tracked.requesterSessionRuntimeContext).toBeUndefined();
      return;
    }
    await expect(resume).resolves.toMatchObject({ type: 'error', errorCode: 'INVALID_ENVIRONMENT_VARIABLES' });
    const recovered = h.tracked.requesterSessionRuntimeContext;
    expect(recovered).toBeDefined();
    expect(recovered?.bootstrap.attribution).toEqual(attribution);
    expect(recovered?.activeServerDir).toBe(birth.activeServerDir);
    expect(recovered?.connectedServicesMaterializationBaseDir).toBe(birth.connectedServicesMaterializationBaseDir);
    if (state === 'cold' || state === 'cold-unattributed') expect(recovered).not.toBe(birth);
  },
);
