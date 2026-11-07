import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { requesterSessionCredentialPath } from '../sessionEncryption/requesterSessionCredentials';
import { createOnChildExited } from '../sessions/onChildExited';

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

it('keeps persisted requester birth through Stop, physical exit and cold Resume', async () => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control);
  const birth = h.requester;
  const path = requesterSessionCredentialPath({ happyHomeDir: h.f.directory,
    sessionId: h.sessionId, attribution: birth.bootstrap.attribution });
  h.tracked.pid = 2_147_000_000;
  h.tracked.sessionRunnerPid = h.tracked.pid;
  h.tracked.stopRequestedAtMs = Date.now();
  h.pidToTrackedSession.clear();
  h.pidToTrackedSession.set(h.tracked.pid, h.tracked);
  const exited = createOnChildExited({ pidToTrackedSession: h.pidToTrackedSession,
    spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(), getApiMachineForSessions: () => null });
  await exited(h.tracked.pid, { reason: 'process-exited', code: 0, signal: null });
  await expect(access(path)).resolves.toBeUndefined();
  expect(h.tracked.requesterSessionRuntimeContext).toBeUndefined();
  // A cold daemon has no retained PID/attribution hints. Home terminal
  // publication is outside this fixture; discard that in-memory census.
  h.pidToTrackedSession.clear();
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
