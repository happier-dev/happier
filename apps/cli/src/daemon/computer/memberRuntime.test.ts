import { spawn } from 'node:child_process';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach, onTestFinished } from 'vitest';
import type { ApiMachineClient } from '@/api/apiMachine';
import { buildAgentIsolationProvisioningSteps, deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { prepareRequesterNativeOperation } from '@/daemon/agentIsolation/prepareNativeOperation';
import { createAgentIsolationMemberPreparationBoundary, runAgentIsolationMemberReadinessBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { writeAgentIsolationMemberBinding } from '@/daemon/agentIsolation/memberBindings';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import type { HostAgentIsolationLaunchContext, HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { AgentLaunchOperationMaterialization } from '@/daemon/agentIsolation/agentLaunchMaterials';
import { prepareMemberComputerRuntime } from './memberRuntime';

const nativeOs = vi.hoisted(() => ({
  home: undefined as undefined | { path: string; uid: number },
  readinessFailure: false,
  readinessProbes: 0,
}));

// Only OS dispatch/metadata are substituted. Native preparation, provisioning,
// binding, readiness, material projection and Exec all run their real owners.
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(() => { throw new Error('fixture_native_spawn_refusal'); }),
}));
vi.mock('@happier-dev/cli-common/process', async importOriginal => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...args: Parameters<typeof actual.execFileWithDeadline>) => {
    const readiness = await runAgentIsolationMemberReadinessBoundary({ request: args,
      nativeHome: nativeOs.home, fail: nativeOs.readinessFailure });
    if (readiness) { nativeOs.readinessProbes++; return readiness; }
    return actual.execFileWithDeadline(...args);
  } };
});

describe('member desktop launch custody', () => {
  afterEach(() => { nativeOs.home = undefined; nativeOs.readinessFailure = false; nativeOs.readinessProbes = 0;
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it.skipIf(process.platform !== 'linux').each([false, true])('uses native member readiness before Exec and never lends the owner display (readiness refused: %s)', async readinessFailure => {
    const identity = { kind: 'isolated', separationRequired: true, requester: {
      serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation',
    } } satisfies HostRequesterExecutionIdentity;
    const requesterIdentity = { ...identity, homeServerIdentityId: 'home' };
    const member = { ...deriveAgentIsolationMemberIdentity(requesterIdentity), agentUid: 2402, agentGid: 2402 };
    const directory = await filesystem.mkdtemp(join(tmpdir(), 'happier-computer-native-preparation-'));
    onTestFinished(() => filesystem.rm(directory, { recursive: true, force: true }));
    const preparation = createAgentIsolationMemberPreparationBoundary({ activeServerDir: directory,
      requesterIdentity, custodianAccountId: 'owner', encryptionMode: 'plain', uid: member.agentUid });
    for (const step of buildAgentIsolationProvisioningSteps({ requesterIdentity, daemonUsername: 'happier',
      daemonPrimaryGroup: 'happier', binaryPath: preparation.effects.installedCli })) preparation.installed.add(step.id);
    await writeAgentIsolationMemberBinding(directory, member);
    nativeOs.home = { path: member.home, uid: member.agentUid };
    nativeOs.readinessFailure = readinessFailure;
    const realpath = filesystem.realpath;
    const lstat = filesystem.lstat;
    vi.spyOn(filesystem, 'realpath').mockImplementation(async path => String(path) === member.workspaceRoot || String(path) === member.home
      ? String(path) : realpath(path));
    vi.spyOn(filesystem, 'lstat').mockImplementation(async path => String(path) === member.home
      ? Object.assign(await lstat(directory), { uid: member.agentUid, gid: member.agentGid, mode: 0o40700 }) : lstat(path));
    vi.stubEnv('DISPLAY', ':owner'); vi.stubEnv('XAUTHORITY', '/owner/cookie'); vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/owner/bus');
    let readMaterial: (() => AgentLaunchOperationMaterialization | undefined) | undefined;
    let selectedMaterial: AgentLaunchOperationMaterialization | undefined;
    const machine: HostAgentIsolationLaunchContext = {
      managedHappierBinaryPath: preparation.effects.installedCli,
      read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'unavailable', code: 'metadata_unavailable' }, workspaceRoots: [] }),
      async prepareMember(input) {
        const result = await preparation.members.prepare(input);
        if (result.kind !== 'ready') throw new Error('Native member fixture preparation was refused');
        return result;
      },
    };
    const prepareNativeOperation: ApiMachineClient['prepareNativeOperation'] = async input => {
      readMaterial = input.readMaterial;
      return prepareRequesterNativeOperation(input, { machine, homeServerIdentityId: 'home', machineId: 'machine',
        installationId: 'installation', reloadController: createPluginReloadController() });
    };
    vi.mocked(spawn).mockClear();
    vi.mocked(spawn).mockImplementationOnce(() => { selectedMaterial = readMaterial?.(); throw new Error('fixture_native_spawn_refusal'); });
    const result = prepareMemberComputerRuntime({ prepareNativeOperation, identity, placement: 'member' });
    if (readinessFailure) {
      await expect(result).rejects.toMatchObject({ code: 'agent_isolation_unavailable', details: {
        reason: 'payload_not_accessible', phase: 'native_execution_preparation' } });
      expect(spawn).not.toHaveBeenCalled();
      return;
    }
    await expect(result).rejects.toMatchObject({ code: 'plugin_exec_spawn_failed' });
    expect(nativeOs.readinessProbes).toBe(1);
    const call = vi.mocked(spawn).mock.calls.at(-1)!;
    expect(call[0]).toBe('sudo');
    expect(call[1]).toEqual(['-n', '-u', member.username, '--', preparation.effects.installedCli, 'agent-launch']);
    const options = call[2];
    expect(options?.env).not.toHaveProperty('DISPLAY');
    expect(options?.env).not.toHaveProperty('XAUTHORITY');
    expect(options?.env).not.toHaveProperty('DBUS_SESSION_BUS_ADDRESS');
    expect(selectedMaterial?.environment.TMPDIR).toMatch(new RegExp(`^${member.home}/`));
    expect(selectedMaterial?.selectedMaterials).toEqual([]);
  });

  it.skipIf(process.platform !== 'linux')('consumes canonical daemon placement without native member preparation or owner display inheritance', async () => {
    vi.stubGlobal('process', { ...process, execPath: '/fixture/happier' });
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_RUNTIME', 'bun');
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED', undefined);
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_ENTRYPOINT', '/fixture/embedded/index.mjs');
    vi.stubEnv('DISPLAY', ':owner'); vi.stubEnv('XAUTHORITY', '/owner/cookie');
    const identity = { kind: 'isolated', separationRequired: true, requester: {
      serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation',
    } } satisfies HostRequesterExecutionIdentity;
    const agentIsolation: HostAgentIsolationLaunchContext = { requesterIdentity: identity,
      read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) };
    const prepareNativeOperation: ApiMachineClient['prepareNativeOperation'] = input => prepareRequesterNativeOperation(input, {
      machine: agentIsolation, homeServerIdentityId: 'home', machineId: 'machine', installationId: 'installation',
      reloadController: createPluginReloadController(),
    });
    vi.mocked(spawn).mockClear();
    await expect(prepareMemberComputerRuntime({ prepareNativeOperation, identity, placement: 'daemon', agentIsolation }))
      .rejects.toMatchObject({ code: 'plugin_exec_spawn_failed' });
    expect(vi.mocked(spawn)).toHaveBeenCalledOnce();
    const call = vi.mocked(spawn).mock.calls[0]!;
    expect(call[0]).toBe('/fixture/happier');
    expect(call[1]).toEqual(['computer-effect']);
    expect(call[2]?.env).not.toHaveProperty('DISPLAY');
    expect(call[2]?.env).not.toHaveProperty('XAUTHORITY');
  });
});
