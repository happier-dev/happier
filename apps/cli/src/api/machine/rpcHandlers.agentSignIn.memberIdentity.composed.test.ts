import { mkdir } from 'node:fs/promises';
import type { ChildProcess, ExecFileOptions, SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { buildAgentIsolationProvisioningSteps, deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { createAgentIsolationMemberPreparationBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { writeAgentIsolationMemberBinding } from '@/daemon/agentIsolation/memberBindings';
import { configuration } from '@/configuration';
import '@/api/api';
import { AGENT_SIGN_IN_STATUS_RPC_METHOD, AgentSignInStatusResponseSchema } from '@happier-dev/protocol/daemon/agentSignIn';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';

const os = vi.hoisted(() => ({
  home: undefined as undefined | { path: string; workspaceRoot: string; directory: string; username: string; uid: number },
  spawn: undefined as undefined | ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess | undefined),
  execFile: undefined as undefined | ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess | undefined),
}));

// Genuine native observation and filesystem boundaries. Selector, binding,
// materializer, admission, finite operation, supervisor and native auth parsing stay real.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual,
    async lstat(path: Parameters<typeof actual.lstat>[0]) {
      if (String(path) === os.home?.path) return Object.assign(await actual.lstat(os.home.directory),
        { uid: os.home.uid, gid: os.home.uid, mode: 0o40700 });
      return actual.lstat(path);
    },
    async realpath(path: Parameters<typeof actual.realpath>[0]) {
      return String(path) === os.home?.path || String(path) === os.home?.workspaceRoot ? String(path) : actual.realpath(path);
    },
  };
});
vi.mock('fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual,
    async lstat(path: Parameters<typeof actual.lstat>[0]) {
      if (String(path) === os.home?.path) return Object.assign(await actual.lstat(os.home.directory),
        { uid: os.home.uid, gid: os.home.uid, mode: 0o40700 });
      return actual.lstat(path);
    },
    async realpath(path: Parameters<typeof actual.realpath>[0]) {
      return String(path) === os.home?.path || String(path) === os.home?.workspaceRoot ? String(path) : actual.realpath(path);
    },
  };
});
vi.mock('@happier-dev/cli-common/machineSetup', async original => {
  const actual = await original<typeof import('@happier-dev/cli-common/machineSetup')>();
  return { ...actual, createMachineSetupNativeBackend: () => ({
    async observe(step: import('@happier-dev/protocol/machines/setup/machineRecipeV1').MachineRecipeStepV1) {
      const found = step.kind === 'user' && step.username === os.home?.username;
      return { stepId: step.id, status: found ? 'satisfied' : 'unavailable',
        facts: found ? { present: true, uid: os.home!.uid, gid: os.home!.uid } : { present: false } };
    },
    async apply() { throw new Error('Status cannot provision native state'); },
  }) };
});
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: (command: string, args: readonly string[] = [], options: SpawnOptions = {}) =>
    os.spawn?.(command, args, options) ?? actual.spawn(command, args, options),
    execFile(command: string, args: readonly string[], options: ExecFileOptions,
      callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void) {
      const child = os.execFile?.(command, args, options);
      if (!child) return actual.execFile(command, args, options, callback);
      let stdout = ''; let stderr = ''; let processError: Error | null = null;
      child.stdout?.on('data', chunk => { stdout += String(chunk); });
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      child.once('error', error => { processError = error; });
      child.once('close', code => callback(processError ?? (code === 0 ? null : new Error('Native fixture process failed')), stdout, stderr));
      return child;
    } };
});
afterEach(() => { os.home = undefined; os.spawn = undefined; os.execFile = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture() {
  let memberPreparation: ReturnType<typeof createAgentIsolationMemberPreparationBoundary> | undefined;
  const f = await createInstalledFilesystemMachineFixture({ agentIsolation: {
    managedHappierBinaryPath: '/opt/happier/cli/current/happier',
    read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1',
      status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [] }),
    readMember: async input => {
      if (!memberPreparation) throw new Error('Native member fixture is not ready');
      return memberPreparation.members.read(input);
    },
    prepareMember: async () => { throw new Error('Status must not provision a member'); },
  } });
  // Home discovery is a genuine HTTP boundary on older installed receivers.
  const features = FeaturesResponseSchema.parse({ features: {}, capabilities: {
    serverIdentity: { serverIdentityId: f.homeServerIdentityId }, connectedServices: { qualifiedAccounts: { protocolVersion: 4 } },
  } });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(features)));
  const requesterIdentity = { kind: 'isolated' as const, separationRequired: true,
    homeServerIdentityId: f.homeServerIdentityId,
    requester: { serverId: f.serverId, accountId: 'member-a', machineId: 'machine', installationId: f.installation.installationId } };
  const identity = deriveAgentIsolationMemberIdentity(requesterIdentity);
  memberPreparation = createAgentIsolationMemberPreparationBoundary({ requesterIdentity,
    activeServerDir: configuration.activeServerDir, custodianAccountId: 'requester', encryptionMode: 'plain', uid: 2401 });
  // The OS boundary reports an already completed owner setup. The real member
  // operation still checks policy, native facts, binding and local custody.
  for (const step of buildAgentIsolationProvisioningSteps({ requesterIdentity, daemonUsername: 'happier',
    daemonPrimaryGroup: 'happier', binaryPath: '/opt/happier/cli/current/happier' })) memberPreparation.installed.add(step.id);
  const memberDirectory = join(f.directory, 'member-home'); await mkdir(memberDirectory);
  os.home = { path: identity.home, workspaceRoot: identity.workspaceRoot,
    directory: memberDirectory, username: identity.username, uid: 2401 };
  await writeAgentIsolationMemberBinding(configuration.activeServerDir, { ...identity, agentUid: 2401, agentGid: 2401 });
  return { ...f, memberSetupLaunches: () => memberPreparation?.launches.length ?? 0 };
}

  it('reports the member native sign-in without borrowing owner credentials or provisioning a missing member', async () => {
    const f = await fixture();
    writeExecutableShimSync({ dir: f.directory, fileName: 'cursor-agent',
      contents: '#!/bin/sh\nprintf \'%s\\n\' \'{"user":{"email":"owner@example.invalid"}}\'\n' });
    const nativeProbeEnv = createEnvKeyScope(['HAPPIER_CURSOR_PATH', 'PATH', 'CURSOR_API_KEY']);
    nativeProbeEnv.patch({ HAPPIER_CURSOR_PATH: join(f.directory, 'cursor-agent'),
      PATH: `${f.directory}:${process.env.PATH ?? ''}`, CURSOR_API_KEY: 'fixture-owner-credential' });
    onTestFinished(() => nativeProbeEnv.restore());
    // This isolated bundled-plugin fixture has no stored Account. The installed
    // Machine above retains its real authenticated Home admission separately.
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.cursor'],
        scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() },
        accountStorageDependencies: { readCredentials: async () => null },
      } });
    onTestFinished(() => runtime.dispose());
    const agentId = [...runtime.registry.contributes.agentDefinitionsById]
      .find(([, agent]) => agent.identity?.pluginId === 'happier.agent.cursor')?.[0];
    if (!agentId) throw new Error('Cursor fixture is not admitted');
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const observed: unknown[] = [];
    let output = '{}';
    // Real native-process boundary substitute: receive the canonical launch
    // frame, report only identity facts, and supply native CLI stdout. All
    // admission, binding, placement, Exec and auth parsing remain real.
    os.spawn = (command, args) => {
      if (command !== 'sudo') return undefined;
      expect(args.slice(0, 3)).toEqual(['-n', '-u', os.home?.username]);
      const child = Object.assign(new actual.ChildProcess(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      });
      void readAgentLaunchFrame(child.stdin, undefined, true).then(payload => {
        if ('executable' in payload) {
          observed.push({ uid: payload.nativeIdentity?.agentUid, home: payload.nativeIdentity?.home,
            borrowedOwnerCredential: !!payload.environment.CURSOR_API_KEY, materials: payload.selectedMaterials.length });
          child.stdout.end(output);
        } else child.stdout.end();
        child.stderr.end();
        child.exitCode = 0;
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      }).catch(error => {
        child.stderr.end(String(error));
        child.exitCode = 1;
        child.emit('exit', 1, null);
        child.emit('close', 1, null);
      });
      return child;
    };
    os.execFile = os.spawn;
    const invoke = async () => {
      const admissions = f.admissionChecks();
      const result = AgentSignInStatusResponseSchema.parse(await f.rpcHandlerManager.handleRequest({
        method: `machine:${AGENT_SIGN_IN_STATUS_RPC_METHOD}`, params: { agentId }, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'requester', machineId: f.machineId,
          installationId: f.installation.installationId, role: 'use', encryptionMode: 'plain' },
      }));
      expect(f.admissionChecks() - admissions).toBe(1);
      return result;
    };
    expect(await invoke(), JSON.stringify(observed)).toMatchObject({ status: 'signedOut', signInScope: 'member' });
    output = '{"user":{"email":"member@example.invalid"}}';
    const signedIn = await invoke();
    expect(signedIn, JSON.stringify({ observed, signedIn })).toMatchObject({ status: 'signedIn', signInScope: 'member' });
    expect(signedIn).not.toHaveProperty('accountLabel');
    expect(observed).toEqual([0, 1].map(() => ({ uid: 2401, home: os.home?.path,
      borrowedOwnerCredential: false, materials: 0 })));
    const setupLaunches = f.memberSetupLaunches();
    os.home = undefined;
    expect(await invoke()).toMatchObject({ status: 'unknown', signInScope: 'member' });
    expect(observed).toHaveLength(2);
    expect(f.memberSetupLaunches()).toBe(setupLaunches);
  });
