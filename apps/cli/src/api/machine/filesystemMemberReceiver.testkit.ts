import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, onTestFinished, vi } from 'vitest';
import { z } from 'zod/mini';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createAgentIsolationEffectsBoundary, createAgentIsolationMemberPreparationBoundary, runAgentIsolationMemberReadinessBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { buildAgentIsolationProvisioningSteps, deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { writeAgentIsolationMemberBinding } from '@/daemon/agentIsolation/memberBindings';
import { resolveAgentIsolationMemberCliRuntime } from '@/daemon/agentIsolation/memberCliRuntime';
import { resolveManagedMachineEnrollmentAgentIsolationV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { readAgentIsolationSnapshot } from '@/daemon/agentIsolation/agentIsolationPolicy';
import { configuration } from '@/configuration';
import { resolveCliTsxTsconfigPath } from '@/utils/spawnHappyCLI';
import { projectPath } from '@/projectPath';
import { MachineAgentIsolationPreviewResultV1Schema, readMachineAgentIsolationPolicyV1 } from '@happier-dev/protocol';
import type { MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';

const installedCli = '/opt/happier/cli/current/happier';
const memberCli = resolveAgentIsolationMemberCliRuntime(installedCli).executable;

const nativeOs = vi.hoisted(() => ({
  home: undefined as undefined | { path: string; backing: string; workspaceRoot: string; workspaceBacking: string; uid: number },
  sharedHome: undefined as string | undefined,
  readinessFailure: false,
  readinessProbes: 0,
  spawn: undefined as undefined | ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess | undefined),
  processStatuses: new Map<string, string>(),
  daemonUnreadableSource: undefined as string | undefined,
}));

export function nativeFilesystemMemberBoundary() { return nativeOs; }

// Only native OS observation/process boundaries are substituted. Installed
// ingress, member preparation/store, launch frame, filesystem and transfer
// owners below remain their production implementations.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual,
    open: async (path: Parameters<typeof actual.open>[0], flags: Parameters<typeof actual.open>[1], mode?: Parameters<typeof actual.open>[2]) => {
      if (String(path) === nativeOs.daemonUnreadableSource) throw Object.assign(new Error('Requester owns private scratch'), { code: 'EACCES' });
      return actual.open(nativeOs.processStatuses.get(String(path)) ?? path, flags, mode);
    },
    readFile: async (path: Parameters<typeof actual.readFile>[0], ...args: unknown[]) => {
      if (String(path) === nativeOs.daemonUnreadableSource) throw Object.assign(new Error('Requester owns private scratch'), { code: 'EACCES' });
      return Reflect.apply(actual.readFile, actual, [path, ...args]);
    },
    async lstat(path: Parameters<typeof actual.lstat>[0]) {
      return String(path) === nativeOs.home?.path ? Object.assign(await actual.lstat(nativeOs.home.backing),
        { uid: nativeOs.home.uid, gid: nativeOs.home.uid, mode: 0o40700 }) : actual.lstat(path);
    },
    async realpath(path: Parameters<typeof actual.realpath>[0]) {
      if (String(path) === nativeOs.home?.path) { await actual.realpath(nativeOs.home.backing); return String(path); }
      if (String(path) === nativeOs.home?.workspaceRoot) { await actual.realpath(nativeOs.home.workspaceBacking); return String(path); }
      return actual.realpath(path);
    },
  };
});
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: (command: string, args: readonly string[] = [], options: SpawnOptions = {}) =>
    nativeOs.spawn?.(command, args, options) ?? actual.spawn(command, args, options) };
});
vi.mock('@happier-dev/cli-common/process', async original => {
  const actual = await original<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...args: Parameters<typeof actual.execFileWithDeadline>) => {
    if (args[0] === 'getent' && JSON.stringify(args[1]) === JSON.stringify(['--service=files', 'passwd', 'happier-agent'])
      && nativeOs.sharedHome) return { stdout: `happier-agent:x:2402:2402::${nativeOs.sharedHome}:/usr/sbin/nologin\n`, stderr: '' };
    const readiness = await runAgentIsolationMemberReadinessBoundary({ request: args,
      nativeHome: nativeOs.home, sharedHome: nativeOs.sharedHome, fail: nativeOs.readinessFailure });
    if (readiness) { nativeOs.readinessProbes++; return readiness; }
    return actual.execFileWithDeadline(...args);
  } };
});

// A genuine child receives the exact production native frame. Its filesystem
// boundary supplies a virtual native home and a constructed EACCES neighbor;
// this proves installed source wiring, NOT kernel cross-UID isolation. No
// serialized identity, policy, executable, arguments or pointers are rewritten.
const nativeWorker = String.raw`
const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const { dirname, join, sep } = require('node:path');
let buffered = Buffer.alloc(0);
async function receive(chunk) {
  buffered = Buffer.concat([buffered, chunk]);
  if (buffered.length < 12) return;
  if (buffered.subarray(0, 8).toString() !== 'HAPAGT1\n') throw new Error('frame_invalid');
  const length = buffered.readUInt32BE(8);
  if (buffered.length < 12 + length) return;
  process.stdin.pause(); process.stdin.off('data', receiveChunk);
  const payload = JSON.parse(buffered.subarray(12, 12 + length).toString('utf8'));
  if (payload.executable !== process.env.HAPPIER_TEST_NATIVE_CLI || JSON.stringify(payload.args) !== '["filesystem-effect"]')
    throw new Error('native_command_changed');
  const nativeHome = payload.nativeIdentity?.home ?? process.env.HAPPIER_TEST_SHARED_NATIVE_HOME;
  if (!nativeHome) throw new Error('native_home_missing');
  // Model the run-as OS boundary independently of the parent daemon's UID.
  process.geteuid = () => payload.nativeIdentity?.agentUid ?? 2402;
  const backing = process.env.HAPPIER_TEST_MEMBER_HOME;
  const workspaceRoot = payload.cwd;
  const workspaceBacking = process.env.HAPPIER_TEST_MEMBER_WORKSPACE;
  const foreign = process.env.HAPPIER_TEST_FOREIGN_ROOT;
  const nativePath = path => {
    if (typeof path !== 'string') return path;
    if (path === foreign || path.startsWith(foreign + sep)) throw Object.assign(new Error('constructed native EACCES'), { code: 'EACCES' });
    if (workspaceBacking && (path === workspaceRoot || path.startsWith(workspaceRoot + sep))) return workspaceBacking + path.slice(workspaceRoot.length);
    return path === nativeHome || path.startsWith(nativeHome + sep) ? backing + path.slice(nativeHome.length) : path;
  };
  for (const name of ['access', 'readFile', 'writeFile', 'open', 'stat', 'lstat', 'realpath', 'readdir', 'mkdir', 'mkdtemp', 'rm', 'unlink', 'chmod']) {
    const original = fs[name];
    fs[name] = async (path, ...args) => original(nativePath(path), ...args);
  }
  for (const name of ['copyFile', 'rename']) {
    const original = fs[name];
    fs[name] = async (source, destination, ...args) => original(nativePath(source), nativePath(destination), ...args);
  }
  // Configuration and executable discovery use the same virtual native home.
  for (const name of ['existsSync', 'mkdirSync', 'chmodSync', 'accessSync', 'openSync']) {
    const original = fsSync[name];
    fsSync[name] = (path, ...args) => original(nativePath(path), ...args);
  }
  const execFile = childProcess.execFile;
  childProcess.execFile = (file, ...args) => execFile(nativePath(file), ...args);
  syncBuiltinESMExports();
  Object.assign(process.env, payload.environment);
  // The real shim supplies the frame environment, not the source launcher's
  // PATH. Inheriting it here would hide a missing native discovery projection.
  process.env.PATH = payload.environment.PATH ?? '';
  await fs.mkdir(payload.runtimeHome, { recursive: true });
  process.send({ kind: 'frame', identity: payload.nativeIdentity, executable: payload.executable,
    args: payload.args, cwd: payload.cwd, runtimeHome: payload.runtimeHome, materialCount: payload.selectedMaterials.length });
  const remainder = buffered.subarray(12 + length); buffered = Buffer.alloc(0);
  if (remainder.length) process.stdin.unshift(remainder);
  // Import only the real finite entry; its own dependency graph owns loading.
  process.send({ kind: 'phase', phase: 'importing_native_owner' });
  const { runFilesystemEffectInternal } = await import(process.env.HAPPIER_TEST_FILESYSTEM_INTERNAL);
  process.send({ kind: 'phase', phase: 'native_owner_imported' });
  setImmediate(() => process.stdin.resume());
  await runFilesystemEffectInternal(process.stdin, process.stdout);
  process.send({ kind: 'phase', phase: 'native_owner_settled' });
  process.disconnect();
}
function receiveChunk(chunk) { void receive(chunk).catch(error => {
  process.stderr.write(JSON.stringify({ code: error?.code ?? 'fixture_native_worker_failed' }) + '\n');
  process.exit(1);
}); }
process.stdin.on('data', receiveChunk);
`;

type InstalledFilesystemMachineFixture = Awaited<ReturnType<typeof createInstalledFilesystemMachineFixture>>;
type NativeFilesystemFrame = Readonly<{ identity?: { username: string; agentUid: number; agentGid: number; home: string };
  executable: string; args: string[]; cwd: string; runtimeHome: string; materialCount: number }>;
type NativeFilesystemInvoke = (method: string, params: unknown, accountId?: string, role?: 'use' | 'manage',
  correlation?: 'request' | 'trace') => ReturnType<InstalledFilesystemMachineFixture['receive']>;
/** Explicit so declaration emit does not serialize the whole composed fixture (TS7056). */
export type NativeFilesystemMemberFixture = Omit<InstalledFilesystemMachineFixture, 'invoke'> & Readonly<{
  member: string;
  foreign: string;
  identity: ReturnType<typeof deriveAgentIsolationMemberIdentity>;
  sharedHome: string;
  frames: NativeFilesystemFrame[];
  children: ChildProcess[];
  runAsUsers: string[];
  invoke: NativeFilesystemInvoke;
  invokeFromHome: NativeFilesystemInvoke;
  preparation: ReturnType<typeof createAgentIsolationMemberPreparationBoundary> | undefined;
}>;

export async function createNativeFilesystemMemberFixture(options: Readonly<{ registerCleanup?: NonNullable<Parameters<typeof createInstalledFilesystemMachineFixture>[0]>['registerCleanup']; accountId?: string; legacy?: boolean; coldPolicy?: 'managed' | 'legacy' | 'reviewedMember'; startupFailure?: true; cleanupRefused?: true; foreignLauncher?: true }> = {}): Promise<NativeFilesystemMemberFixture> {
  let preparation: ReturnType<typeof createAgentIsolationMemberPreparationBoundary> | undefined;
  const coldPolicy = options.coldPolicy === 'managed'
    ? resolveManagedMachineEnrollmentAgentIsolationV1({ kind: 'dedicatedDaemonUser', username: 'happier',
      serviceMode: 'user', role: 'server', adminAccessAtCreation: 'preauthorized' })!
    : { enabled: true };
  let metadata: Record<string, unknown> = { agentIsolation: options.coldPolicy === 'reviewedMember' ? { enabled: false } : coldPolicy };
  let metadataVersion = 1;
  const metadataPort: MachineMetadataFieldPortV1 = { read: async () => ({ status: 'ready', metadata, metadataVersion }),
    compareAndSwap: async input => {
      if (input.expectedMetadataVersion !== metadataVersion) return { status: 'conflict', metadata, metadataVersion };
      metadata = input.metadata; metadataVersion++; return { status: 'applied', metadata, metadataVersion };
    } };
  const readSnapshot = () => readAgentIsolationSnapshot({ metadata: { status: 'ready', metadataVersion, metadata },
    daemonState: { runtimeId: 'current' }, runtimeId: 'current', platform: 'linux' });
  const f = await createInstalledFilesystemMachineFixture({
    registerSessions: true,
    ...(options.registerCleanup ? { registerCleanup: options.registerCleanup } : {}),
    ...(options.accountId === 'requester' ? { boundSessionId: 'owner-agent-files' } : {}), agentIsolation: {
    managedHappierBinaryPath: installedCli,
    memberManagedHappierBinaryPath: memberCli,
    read: () => ({ ...(options.coldPolicy === 'reviewedMember' ? readSnapshot() : readAgentIsolationSnapshot({
      metadata: { status: 'ready', metadataVersion: 1, metadata: { agentIsolation: options.coldPolicy ? coldPolicy : { enabled: true,
        ...(!options.legacy ? { memberProvisioning: 'linuxUsersV1' as const } : {}) } } },
      // First use has reviewed policy but no global native readiness. Member
      // preparation must produce its own native fact before the Codex payload.
      daemonState: { runtimeId: 'current', ...(options.coldPolicy ? {} : {
        agentIsolation: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } }) },
      runtimeId: 'current', platform: 'linux',
    })), workspaceRoots: options.legacy ? [projectPath()] : [] }),
    readMember: async input => {
      if (!preparation) throw new Error('Member preparation fixture is not ready');
      return preparation.members.read(input);
    },
    prepareMember: async input => {
      if (!preparation) throw new Error('Member preparation fixture is not ready');
      const result = await preparation.members.prepare(input);
      if (result.kind !== 'ready') throw Object.assign(new Error('Existing native member preparation was refused'),
        { code: 'agent_isolation_unavailable', rpcErrorCode: 'agent_isolation_unavailable' });
      return result;
    },
  } });
  const requesterIdentity = { kind: 'isolated' as const, separationRequired: options.accountId !== 'requester', homeServerIdentityId: f.homeServerIdentityId,
    requester: { serverId: f.homeServerIdentityId, accountId: options.accountId ?? 'member-a', machineId: f.machineId,
      installationId: f.installation.installationId } };
  const identity = deriveAgentIsolationMemberIdentity(requesterIdentity);
  preparation = createAgentIsolationMemberPreparationBoundary({ activeServerDir: configuration.activeServerDir,
    requesterIdentity, custodianAccountId: 'requester', encryptionMode: 'plain', uid: 2401,
    readinessFailure: () => nativeOs.readinessFailure,
    ...(options.coldPolicy === 'reviewedMember' ? { metadataPort } : {}) });
  if (options.legacy) preparation.setPolicy({ enabled: true });
  if (options.coldPolicy) preparation.setPolicy(coldPolicy);
  else for (const step of buildAgentIsolationProvisioningSteps({ requesterIdentity, daemonUsername: 'happier', daemonPrimaryGroup: 'happier',
    binaryPath: installedCli })) preparation.installed.add(step.id);
  const member = join(f.directory, 'member-home');
  const workspace = join(f.directory, 'member-workspace');
  const foreign = join(f.directory, 'neighbor-private');
  await mkdir(member); await mkdir(workspace); await mkdir(foreign);
  await writeFile(join(member, 'owned.dat'), Buffer.from([0, 255, 1, 254]));
  await writeFile(join(foreign, 'private.dat'), 'neighbor fixture');
  const sharedHome = '/var/lib/happier/agent';
  if (options.legacy) nativeOs.sharedHome = sharedHome;
  nativeOs.home = { path: options.legacy ? sharedHome : identity.home, backing: member,
    workspaceRoot: options.legacy ? projectPath() : identity.workspaceRoot, workspaceBacking: workspace, uid: options.legacy ? 2402 : 2401 };
  if (!options.coldPolicy && !options.legacy) await writeAgentIsolationMemberBinding(configuration.activeServerDir, { ...identity, agentUid: 2401, agentGid: 2401 });
  const frames: NativeFilesystemFrame[] = [];
  const children: ChildProcess[] = [];
  const runAsUsers: string[] = [];
  const phases: string[] = [];
  const startedAt = Date.now();
  const recordPhase = (phase: string) => { phases.push(`${phase}@${Date.now() - startedAt}ms`); };
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const foreignStatus = join(f.directory, 'native-process-status');
  if (options.foreignLauncher) await writeFile(foreignStatus, 'Uid:\t2401\t2401\t2401\t2401\n');
  nativeOs.spawn = (command, args, spawnOptions) => {
    if (command !== 'sudo') return undefined;
    if (options.coldPolicy === 'reviewedMember') {
      // The OS worker cannot start before the real setup owner commits the
      // exact requesting person's binding. No internal preparation is mocked.
      expect(JSON.parse(readFileSync(join(configuration.activeServerDir, 'agent-isolation', 'members', `${identity.digest}.json`), 'utf8')))
        .toMatchObject({ accountId: requesterIdentity.requester.accountId, username: identity.username,
          uid: 2401, home: identity.home });
    }
    expect(args).toEqual(['-n', '-u', options.legacy ? 'happier-agent' : identity.username,
      '--', options.legacy ? installedCli : memberCli, 'agent-launch']);
    // The real shared home is Agent-owned 0700. Reject the daemon-side chdir
    // before substituting this fixture's actual source-child working directory.
    if (options.legacy && spawnOptions.cwd === sharedHome) throw Object.assign(
      new Error('Constructed daemon chdir into private Agent home'), { code: 'EACCES' });
    runAsUsers.push(args[2]!);
    const sourceRuntime = pathToFileURL(join(projectPath(), '..', '..', 'packages/cli-common/registerSourceRuntime.mjs')).href;
    const childArgs = options.startupFailure || options.cleanupRefused
      ? ['-e', options.startupFailure
        ? 'process.stdin.once("data", () => { process.stderr.write("agent_launch_failed\\n"); process.exit(1); });'
        // The payload pipe has ended while its run-as launcher still owns
        // cleanup. Its root-first signal will be refused at the OS boundary.
        : 'process.stdin.once("data", () => { process.stdout.end(); process.stdin.resume(); setInterval(() => {}, 1000); });']
      : ['--conditions=happier-source', '--import', sourceRuntime, '-e', nativeWorker];
    const child = actual.spawn(process.execPath, childArgs, {
      ...spawnOptions, cwd: projectPath(), env: { PATH: process.env.PATH, HOME: member, TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
        HAPPIER_TEST_NATIVE_CLI: options.legacy ? installedCli : memberCli,
        HAPPIER_TEST_MEMBER_HOME: member, ...(!options.legacy ? { HAPPIER_TEST_MEMBER_WORKSPACE: workspace } : {}),
        ...(options.legacy ? { HAPPIER_TEST_SHARED_NATIVE_HOME: sharedHome } : {}), HAPPIER_TEST_FOREIGN_ROOT: foreign,
        HAPPIER_TEST_FILESYSTEM_INTERNAL: join(projectPath(), 'src/rpc/handlers/fileSystem/filesystemEffectInternal.ts') },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    if (options.foreignLauncher && child.pid) nativeOs.processStatuses.set(`/proc/${child.pid}/status`, foreignStatus);
    child.stdout?.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) {
        try {
          const response: unknown = JSON.parse(line);
          recordPhase(response && typeof response === 'object' && 'value' in response
            && response.value && typeof response.value === 'object' && 'ready' in response.value
            ? 'native_initialized' : 'native_response_received');
        } catch { recordPhase('native_stdout_unparsed'); }
      }
    });
    child.stdin?.once('finish', () => { recordPhase('native_stdin_eof'); });
    child.on('message', message => {
      if (message && typeof message === 'object' && 'kind' in message && message.kind === 'phase'
        && 'phase' in message && typeof message.phase === 'string'
        && ['importing_configuration', 'configuration_imported', 'importing_effect_dispatch', 'effect_dispatch_imported',
          'importing_effect_admission', 'effect_admission_imported', 'importing_action_rpc_registrar', 'action_rpc_registrar_imported',
          'importing_byte_owner', 'byte_owner_imported', 'importing_native_owner', 'native_owner_imported', 'native_owner_settled'].includes(message.phase)) recordPhase(message.phase);
      const parsed = z.object({ kind: z.literal('frame'), identity: z.optional(z.object({ username: z.string(), agentUid: z.number(), agentGid: z.number(), home: z.string() })),
        executable: z.string(), args: z.array(z.string()), cwd: z.string(), runtimeHome: z.string(), materialCount: z.number() }).safeParse(message);
      if (parsed.success) frames.push(parsed.data);
    });
    return child;
  };
  (options.registerCleanup ?? onTestFinished)(async () => {
    const stalled = children.some(child => child.exitCode === null && child.signalCode === null);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill('SIGKILL'); await closed;
    }
    if (stalled) throw new Error(`Native filesystem fixture did not settle; closed phases: ${phases.join(',') || 'before_frame'}`);
  });
  let correlationNumber = 0;
  const invoke = (source?: 'authenticated_home_socket'): NativeFilesystemInvoke => async (
    method, params, accountId = 'member-a', role = 'use', correlation = 'request',
  ) => {
    const before = f.admissionChecks();
    const correlationId = `filesystem-native-${++correlationNumber}`;
    const result = await f.rpcHandlerManager.handleRequest({ method: `machine:${method}`, params,
      ...(correlation === 'trace' ? { traceId: correlationId } : { requestId: correlationId }),
      callerAuthority: 'present_user', machineAdmission: { actorAccountId: accountId, custodianAccountId: 'requester',
        machineId: f.machineId, installationId: f.installation.installationId, role, encryptionMode: 'plain' } }, undefined, source);
    expect(f.admissionChecks() - before).toBe(source === 'authenticated_home_socket' ? 0 : 1);
    return result;
  };
  if (options.coldPolicy === 'reviewedMember') {
    const native = createAgentIsolationEffectsBoundary({ installationId: f.installation.installationId,
      installedCli, readRoots: () => [], readSessionsToReplace: () => 0, publishStatus: async () => {} });
    registerDaemonMachineAgentIsolationRpcHandlers(f.rpcHandlerManager, {
      target: () => ({ serverId: f.serverId, machineId: f.machineId, installationId: f.installation.installationId, custodianAccountId: 'requester' }),
      readCanonicalHomeServerIdentityId: () => f.homeServerIdentityId, read: readSnapshot, captureMetadataPort: () => metadataPort,
      effects: native.effects, runActionOperation: preparation.runtime.runActionOperation,
    });
    const desired = { machineId: f.machineId, enabled: true, memberProvisioning: 'linuxUsersV1' as const };
    const invokeSetup = invoke();
    const preview = MachineAgentIsolationPreviewResultV1Schema.parse(await invokeSetup('machines.agentIsolation.preview', desired, 'requester', 'manage'));
    if (preview.kind !== 'ready') throw new Error('Reviewed member setup was not previewable');
    expect(await invokeSetup('machines.agentIsolation.set', { ...desired, expectedMetadataVersion: preview.metadataVersion,
      expectedPolicy: preview.policy, expectedPlanDigest: preview.plan.planDigest }, 'requester', 'manage')).toMatchObject({ kind: 'accepted' });
    expect(readMachineAgentIsolationPolicyV1(metadata)).toMatchObject({ status: 'ready', policy: { enabled: true, memberProvisioning: 'linuxUsersV1' } });
    expect(native.boundaryFailures).toEqual([]);
  }
  return { ...f, member, foreign, identity, sharedHome, frames, children, runAsUsers,
    invoke: invoke(), invokeFromHome: invoke('authenticated_home_socket'), preparation };
}

export function resetNativeFilesystemMemberBoundary(): void {
  nativeOs.home = undefined; nativeOs.sharedHome = undefined; nativeOs.spawn = undefined;
  nativeOs.readinessFailure = false; nativeOs.readinessProbes = 0; nativeOs.processStatuses.clear();
  nativeOs.daemonUnreadableSource = undefined; vi.restoreAllMocks();
}

export function assertNativeInvocation(f: Awaited<ReturnType<typeof createNativeFilesystemMemberFixture>>, legacy = false): void {
  expect(f.frames).toHaveLength(1);
  const frame = f.frames[0]!;
  expect(frame.identity).toEqual(legacy ? undefined : {
    username: f.identity.username, agentUid: 2401, agentGid: 2401, home: f.identity.home,
  });
  expect(frame.executable).toBe(legacy ? installedCli : memberCli);
  expect(frame.args).toEqual(['filesystem-effect']);
  expect(frame.cwd).toBe(legacy ? f.sharedHome : f.identity.workspaceRoot);
  expect(frame.runtimeHome.startsWith(`${legacy ? f.sharedHome : f.identity.home}/runtime/operations/`)).toBe(true);
  expect(frame.materialCount).toBe(0);
  expect(f.runAsUsers).toEqual([legacy ? 'happier-agent' : f.identity.username]);
  expect(f.children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
}

