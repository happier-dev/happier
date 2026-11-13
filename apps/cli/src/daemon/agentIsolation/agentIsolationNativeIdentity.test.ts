import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand } from '@happier-dev/cli-common/machineSetup';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { deriveAgentIsolationMemberIdentity, type AgentIsolationMemberRequester } from './provisioning';
import { readAgentIsolationNativeIdentity, observeCurrentAgentIsolationLaunchIdentity,
  readAgentIsolationMemberWorkspaceRoot } from './agentIsolationNativeIdentity';
import { readAgentIsolationMemberLaunchIdentity, writeAgentIsolationMemberBinding } from './memberBindings';
import { observeMachineAdminAccess } from '@/machines/adminAccess/observeMachineAdminAccess';
import { buildAgentIsolationProvisioningSteps } from './provisioning';

const filesystem = vi.hoisted(() => ({ home: '', workspace: '', uid: 2401, gid: 2401, mode: 0o700, actual: '' }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    lstat: vi.fn(async (path: Parameters<typeof actual.lstat>[0]) => {
      if (path === filesystem.workspace) return Object.assign(await actual.lstat(filesystem.actual), { uid: 2401, gid: 2500, mode: 0o42770 });
      if (['/srv', '/srv/happier', '/srv/happier/members'].includes(String(path))) return Object.assign(await actual.lstat(filesystem.actual), { uid: 0, gid: 0, mode: 0o40711 });
      if (path !== filesystem.home) return actual.lstat(path);
      return Object.assign(await actual.lstat(filesystem.actual), { uid: filesystem.uid, gid: filesystem.gid, mode: 0o40000 | filesystem.mode });
    }),
    realpath: vi.fn(async (path: Parameters<typeof actual.realpath>[0]) => path === filesystem.home ? filesystem.home : actual.realpath(path)),
  };
});

const requester: AgentIsolationMemberRequester = { kind: 'isolated', separationRequired: true, homeServerIdentityId: 'home-test',
  requester: { serverId: 'saved-profile', accountId: 'member-test', machineId: 'machine-test', installationId: 'installation-test' } };

describe.skipIf(process.platform !== 'linux')('native requester identity observation', () => {
  beforeEach(async () => { filesystem.actual = await mkdtemp(join(tmpdir(), 'happier-native-identity-')); filesystem.uid = 2401; filesystem.gid = 2401; filesystem.mode = 0o700; });
  afterEach(async () => { vi.restoreAllMocks(); await rm(filesystem.actual, { recursive: true, force: true }); });

  function boundary() {
    const identity = deriveAgentIsolationMemberIdentity(requester);
    filesystem.home = identity.home;
    filesystem.workspace = identity.workspaceRoot;
    let marker = identity.ownershipMarker, groups = '2401', home = identity.home, gid = 2401;
    const calls: MachineSetupNativeCommand[] = [];
    const backend = createMachineSetupNativeBackend({ run: async command => {
      calls.push(command);
      if (command.executable === 'getent') {
        if (command.args.includes('passwd')) return { code: 0, stdout: `${identity.username}:x:2401:${gid}:${marker}:${home}:/usr/sbin/nologin\n`, stderr: '' };
        if (command.args.at(-1) === 'engineers') return { code: 0, stdout: 'engineers:x:2500:\n', stderr: '' };
        return { code: command.args.at(-1) === identity.username ? 0 : 2, stdout: `${identity.username}:x:2401:\n`, stderr: '' };
      }
      if (command.executable === 'id') return { code: 0, stdout: `${groups}\n`, stderr: '' };
      throw new Error(`Unexpected native effect ${command.executable}`);
    } });
    return { identity, backend, calls,
      marker(value: string) { marker = value; }, groups(value: string) { groups = value; },
      home(value: string) { home = value; }, gid(value: number) { gid = value; } };
  }

  it('observes the exact root-owned account once without create, password checks or sudoers writes', async () => {
    const fixture = boundary();
    expect(await readAgentIsolationNativeIdentity({ requesterIdentity: requester, expectedUid: 2401 }, fixture.backend))
      .toMatchObject({ username: fixture.identity.username, home: fixture.identity.home, agentUid: 2401, agentGid: 2401 });
    expect(fixture.calls.filter(command => command.executable === 'getent' && command.args.includes('passwd'))).toHaveLength(1);
    expect(fixture.calls.map(command => command.executable)).toEqual(['getent', 'getent', 'id']);
    fixture.groups('2401 27');
    await expect(readAgentIsolationNativeIdentity({ requesterIdentity: requester }, fixture.backend))
      .rejects.toMatchObject({ code: 'agent_isolation_unavailable', details: { phase: 'native_execution_preparation' } });
  });

  it('uses the same observed daemon primary group for setup and runtime roots', async () => {
    const fixture = boundary();
    const identity = await readAgentIsolationNativeIdentity({ requesterIdentity: requester }, fixture.backend);
    const daemonObservation = await observeMachineAdminAccess({ platform: 'linux',
      execFile: async (command, args) => {
        if (command === 'sudo') return { stdout: '' };
        if (command !== 'id') throw new Error('Unexpected native daemon probe');
        return { stdout: ({ '-u': '1001', '-un': 'alice', '-gn': 'engineers', '-Gn': 'engineers' } as Record<string, string>)[args[0]!] ?? '' };
      },
      fileSystem: { lstat: async () => { throw Object.assign(new Error('Absent drop-in'), { code: 'ENOENT' }); }, readFile: async () => '' },
      tailscale: { tailscaleBin: 'tailscale' },
    });
    const setup = { daemonUsername: daemonObservation.daemonUsername ?? '', daemonPrimaryGroup: daemonObservation.daemonPrimaryGroup ?? null,
      binaryPath: '/opt/happier/cli/current/happier', requesterIdentity: requester };
    expect(buildAgentIsolationProvisioningSteps(setup).find(step => step.id === 'member-workspace')).toMatchObject({ group: 'engineers' });
    expect(await Reflect.apply(readAgentIsolationMemberWorkspaceRoot, undefined,
      [identity, fixture.backend, { daemonObservation }])).toMatchObject({ workspaceRoot: identity.workspaceRoot, daemonGid: 2500 });
    // The current directory backend re-resolves its owner. Consolidating that
    // lookup is a separate pending MI-2 cost refinement, outside this group fix.
    expect(fixture.calls.filter(command => command.args.includes('passwd'))).toHaveLength(2);
    fixture.calls.splice(0);
    await expect(Reflect.apply(readAgentIsolationMemberWorkspaceRoot, undefined,
      [identity, fixture.backend, { daemonObservation: { ...daemonObservation, daemonPrimaryGroup: null } }]))
      .rejects.toMatchObject({ code: 'agent_isolation_unavailable', details: { phase: 'native_execution_preparation' } });
    expect(fixture.calls).toHaveLength(0);
  });

  it('refuses a foreign full marker, mismatched stored UID, private primary group drift and home drift', async () => {
    const fixture = boundary();
    fixture.marker('foreign');
    await expect(readAgentIsolationNativeIdentity({ requesterIdentity: requester }, fixture.backend)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    fixture.marker(fixture.identity.ownershipMarker);
    await expect(readAgentIsolationNativeIdentity({ requesterIdentity: requester, expectedUid: 2402 }, fixture.backend)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    fixture.gid(27);
    await expect(readAgentIsolationNativeIdentity({ requesterIdentity: requester }, fixture.backend)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    fixture.gid(2401); fixture.home('/foreign-home');
    await expect(readAgentIsolationNativeIdentity({ requesterIdentity: requester }, fixture.backend)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
  });

  it('refuses nonprivate or foreign-owned home metadata', async () => {
    const fixture = boundary();
    filesystem.mode = 0o750;
    await expect(readAgentIsolationNativeIdentity({ requesterIdentity: requester }, fixture.backend)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    filesystem.mode = 0o700; filesystem.uid = 2402;
    await expect(readAgentIsolationNativeIdentity({ requesterIdentity: requester }, fixture.backend)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
  });

  it('requires a committed private binding and reuses one native observation for a bound launch', async () => {
    const fixture = boundary();
    const input = { requesterIdentity: requester, activeServerDir: filesystem.actual };
    await expect(readAgentIsolationMemberLaunchIdentity(input, fixture.backend)).rejects.toMatchObject({
      code: 'agent_isolation_unavailable', details: { phase: 'native_identity_binding' } });
    await writeAgentIsolationMemberBinding(filesystem.actual, await readAgentIsolationNativeIdentity(input, fixture.backend));
    fixture.calls.splice(0);
    expect(await readAgentIsolationMemberLaunchIdentity(input, fixture.backend)).toMatchObject({
      digest: fixture.identity.digest, agentUid: 2401, agentGid: 2401 });
    expect(fixture.calls.map(command => command.executable)).toEqual(['getent', 'getent', 'id']);
  });

  it('carries cancellation through the member workspace root observation without another account lookup', async () => {
    const fixture = boundary();
    const identity = await readAgentIsolationNativeIdentity({ requesterIdentity: requester }, fixture.backend);
    for (const abortBefore of [true, false]) {
      const controller = new AbortController();
      if (abortBefore) controller.abort();
      let observations = 0;
      const backend = { observe: async (step: { id: string }) => {
        observations++;
        controller.abort();
        return { stepId: step.id, status: 'satisfied' as const, facts: { uid: identity.agentUid, gid: 2500 } };
      } };
      await expect(Reflect.apply(readAgentIsolationMemberWorkspaceRoot, undefined,
        [identity, backend, { signal: controller.signal, daemonObservation: {
          daemonIdentity: 'nonRoot', daemonUid: 1200, daemonUsername: 'daemon', daemonPrimaryGroup: 'daemon-private',
        } }])).rejects.toMatchObject({ name: 'AbortError' });
      expect(observations).toBe(abortBefore ? 0 : 1);
    }
  });

  it('requires the exact parent-qualified projection at the shim without a second native account observation', async () => {
    const fixture = boundary();
    const expected = await readAgentIsolationNativeIdentity({ requesterIdentity: requester }, fixture.backend);
    vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(2401);
    const current = { username: fixture.identity.username, uid: 2401, gid: 2401, homedir: fixture.identity.home };
    const observations = fixture.calls.length;
    // The preceding public helper accepts this unqualified current member.
    // Its OS boundary is genuine; no internal identity logic is mocked.
    await expect(Reflect.apply(observeCurrentAgentIsolationLaunchIdentity, undefined,
      [current, undefined])).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    // Reflect keeps the regression executable against the preceding helper
    // signature; the deciding behavior is the real public native assertion.
    const assertCurrent = (actual = current, projection: unknown = expected) =>
      Reflect.apply(observeCurrentAgentIsolationLaunchIdentity, undefined, [actual, projection]);
    expect(await assertCurrent()).toEqual({ agentUid: 2401, agentGid: 2401, home: fixture.identity.home });
    expect(fixture.calls).toHaveLength(observations);
    await expect(assertCurrent(current, null)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    await expect(assertCurrent({ ...current, uid: 0 })).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    await expect(assertCurrent(current, { ...expected, agentUid: 2402 })).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    await expect(assertCurrent(current, { ...expected, home: '/foreign-home' })).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
  });
});

// Native process execution is the genuine OS boundary beneath this observer.
vi.mock('@happier-dev/cli-common/process', () => ({ execFileWithDeadline: vi.fn() }));

const agentUid = (process.getuid?.() ?? 0) + 10_000;
const passwd = `happier-agent:x:${agentUid}:2001::/var/lib/happier-agent:/usr/sbin/nologin\n`;

function nativeBoundary(options: Readonly<{ groups?: string; daemonGroup?: string }> = {}) {
  vi.mocked(execFileWithDeadline).mockImplementation(async (command, args) => {
    if (command === 'getent' && args.join(' ') === '--service=files passwd happier-agent') return { stdout: passwd, stderr: '' };
    if (command === 'id' && args.join(' ') === '-G happier-agent') return { stdout: options.groups ?? '2001 3001\n', stderr: '' };
    if (command === 'getent' && args.join(' ') === '-- group daemon-operators') return { stdout: options.daemonGroup ?? 'daemon-operators:x:4001:daemon\n', stderr: '' };
    throw new Error('Unexpected native identity command');
  });
}

describe('Agent isolation native identity observation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not read groups when the existing Session caller only needs UID and home', async () => {
    nativeBoundary();
    expect(await readAgentIsolationNativeIdentity()).toEqual({ agentUid, agentGid: 2001, home: '/var/lib/happier-agent' });
    expect(execFileWithDeadline).toHaveBeenCalledTimes(1);
  });

  it('reports actual primary/supplementary groups and the observed daemon group id on demand', async () => {
    nativeBoundary({ groups: '3001 2001 3001\n' });
    const signal = new AbortController().signal;
    expect(await readAgentIsolationNativeIdentity(signal, undefined, 'daemon-operators')).toEqual({ agentUid, agentGid: 2001, home: '/var/lib/happier-agent',
      groups: { agentGroupIds: [2001, 3001], daemonGroupId: 4001 } });
    expect(vi.mocked(execFileWithDeadline).mock.calls.every(call => call[2].signal === signal)).toBe(true);
  });

  it('retains actual daemon-group membership for the host to refuse rather than hiding it', async () => {
    nativeBoundary({ groups: '2001 4001\n' });
    expect(await readAgentIsolationNativeIdentity(undefined, undefined, 'daemon-operators')).toMatchObject({
      groups: { agentGroupIds: [2001, 4001], daemonGroupId: 4001 },
    });
  });

  it.each(['', '2001 unknown', '2001 -1', '2001 1.5', '2001 9007199254740992', '3001'])
    ('refuses missing, malformed or inconsistent native Agent group evidence %j', async groups => {
      nativeBoundary({ groups });
      await expect(readAgentIsolationNativeIdentity(undefined, undefined, 'daemon-operators')).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    });

  it.each(['', 'other-group:x:4001:daemon\n', 'daemon-operators:x:not-a-gid:daemon\n', 'daemon-operators:x:4001:daemon\nother:x:4002:\n'])
    ('refuses an unavailable or mismatched native daemon group %j', async daemonGroup => {
      nativeBoundary({ daemonGroup });
      await expect(readAgentIsolationNativeIdentity(undefined, undefined, 'daemon-operators')).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    });

  it('fails closed if group observation fails instead of reusing a primary-group guess', async () => {
    nativeBoundary();
    vi.mocked(execFileWithDeadline).mockResolvedValueOnce({ stdout: passwd, stderr: '' })
      .mockRejectedValueOnce(new Error('Native group observation unavailable'));
    await expect(readAgentIsolationNativeIdentity(undefined, undefined, 'daemon-operators')).rejects.toMatchObject({ code: 'agent_isolation_unavailable',
      details: { reason: 'agent_group_facts_unavailable' } });
  });
});
