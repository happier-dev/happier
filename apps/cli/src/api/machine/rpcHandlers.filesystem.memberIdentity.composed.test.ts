import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod/mini';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createAgentIsolationEffectsBoundary, createAgentIsolationMemberPreparationBoundary, runAgentIsolationMemberReadinessBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { buildAgentIsolationProvisioningSteps, deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { readAgentIsolationMemberBindingForAccount, writeAgentIsolationMemberBinding } from '@/daemon/agentIsolation/memberBindings';
import { resolveManagedMachineEnrollmentAgentIsolationV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { readAgentIsolationSnapshot } from '@/daemon/agentIsolation/agentIsolationPolicy';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { resolveCliTsxTsconfigPath } from '@/utils/spawnHappyCLI';
import { projectPath } from '@/projectPath';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { MachineAgentIsolationPreviewResultV1Schema, readMachineAgentIsolationPolicyV1 } from '@happier-dev/protocol';
import type { MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { logger } from '@/ui/logger';

const nativeOs = vi.hoisted(() => ({
  home: undefined as undefined | { path: string; backing: string; workspaceRoot: string; workspaceBacking: string; uid: number },
  sharedHome: undefined as string | undefined,
  readinessFailure: false,
  readinessProbes: 0,
  spawn: undefined as undefined | ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess | undefined),
  processStatuses: new Map<string, string>(),
}));

// Only native OS observation/process boundaries are substituted. Installed
// ingress, member preparation/store, launch frame, filesystem and transfer
// owners below remain their production implementations.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual,
    open: (path: Parameters<typeof actual.open>[0], flags: Parameters<typeof actual.open>[1], mode?: Parameters<typeof actual.open>[2]) =>
      actual.open(nativeOs.processStatuses.get(String(path)) ?? path, flags, mode),
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
afterEach(() => { nativeOs.home = undefined; nativeOs.sharedHome = undefined; nativeOs.spawn = undefined;
  nativeOs.readinessFailure = false; nativeOs.readinessProbes = 0; nativeOs.processStatuses.clear(); vi.restoreAllMocks(); });

// A genuine child receives the exact production native frame. Its filesystem
// boundary supplies a virtual native home and a constructed EACCES neighbor;
// this proves installed source wiring, NOT kernel cross-UID isolation. No
// serialized identity, policy, executable, arguments or pointers are rewritten.
const nativeWorker = String.raw`
const fs = require('node:fs/promises');
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
  if (payload.executable !== '/opt/happier/cli/current/happier' || JSON.stringify(payload.args) !== '["filesystem-effect"]')
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

async function fixture(options: Readonly<{ accountId?: string; legacy?: boolean; coldPolicy?: 'managed' | 'legacy' | 'reviewedMember'; startupFailure?: true; cleanupRefused?: true; foreignLauncher?: true }> = {}) {
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
    ...(options.accountId === 'requester' ? { boundSessionId: 'owner-agent-files' } : {}), agentIsolation: {
    managedHappierBinaryPath: '/opt/happier/cli/current/happier',
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
    ...(options.coldPolicy === 'reviewedMember' ? { metadataPort } : {}) });
  if (options.legacy) preparation.setPolicy({ enabled: true });
  if (options.coldPolicy) preparation.setPolicy(coldPolicy);
  else for (const step of buildAgentIsolationProvisioningSteps({ requesterIdentity, daemonUsername: 'happier', daemonPrimaryGroup: 'happier',
    binaryPath: '/opt/happier/cli/current/happier' })) preparation.installed.add(step.id);
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
  const frames: Array<Readonly<{ identity?: { username: string; agentUid: number; agentGid: number; home: string };
    executable: string; args: string[]; cwd: string; runtimeHome: string; materialCount: number }>> = [];
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
      '--', '/opt/happier/cli/current/happier', 'agent-launch']);
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
  onTestFinished(async () => {
    const stalled = children.some(child => child.exitCode === null && child.signalCode === null);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill('SIGKILL'); await closed;
    }
    if (stalled) throw new Error(`Native filesystem fixture did not settle; closed phases: ${phases.join(',') || 'before_frame'}`);
  });
  let correlationNumber = 0;
  const invoke = async (method: string, params: unknown, accountId = 'member-a', role: 'use' | 'manage' = 'use', correlation: 'request' | 'trace' = 'request') => {
    const before = f.admissionChecks();
    const correlationId = `filesystem-native-${++correlationNumber}`;
    const result = await f.receive({ method: `machine:${method}`, params,
      ...(correlation === 'trace' ? { traceId: correlationId } : { requestId: correlationId }),
      callerAuthority: 'present_user', machineAdmission: { actorAccountId: accountId, custodianAccountId: 'requester',
        machineId: f.machineId, installationId: f.installation.installationId, role, encryptionMode: 'plain' } });
    expect(f.admissionChecks() - before).toBe(1);
    return result;
  };
  if (options.coldPolicy === 'reviewedMember') {
    const native = createAgentIsolationEffectsBoundary({ installationId: f.installation.installationId,
      installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0, publishStatus: async () => {} });
    registerDaemonMachineAgentIsolationRpcHandlers(f.rpcHandlerManager, {
      target: () => ({ serverId: f.serverId, machineId: f.machineId, installationId: f.installation.installationId, custodianAccountId: 'requester' }),
      readCanonicalHomeServerIdentityId: () => f.homeServerIdentityId, read: readSnapshot, captureMetadataPort: () => metadataPort,
      effects: native.effects, runActionOperation: preparation.runtime.runActionOperation,
    });
    const desired = { machineId: f.machineId, enabled: true, memberProvisioning: 'linuxUsersV1' as const };
    const preview = MachineAgentIsolationPreviewResultV1Schema.parse(await invoke('machines.agentIsolation.preview', desired, 'requester', 'manage'));
    if (preview.kind !== 'ready') throw new Error('Reviewed member setup was not previewable');
    expect(await invoke('machines.agentIsolation.set', { ...desired, expectedMetadataVersion: preview.metadataVersion,
      expectedPolicy: preview.policy, expectedPlanDigest: preview.plan.planDigest }, 'requester', 'manage')).toMatchObject({ kind: 'accepted' });
    expect(readMachineAgentIsolationPolicyV1(metadata)).toMatchObject({ status: 'ready', policy: { enabled: true, memberProvisioning: 'linuxUsersV1' } });
    expect(native.boundaryFailures).toEqual([]);
  }
  return { ...f, member, foreign, identity, sharedHome, frames, children, runAsUsers, invoke, preparation };
}

async function admittedOwnerAgentFileContext(f: Awaited<ReturnType<typeof createInstalledFilesystemMachineFixture>>): Promise<RpcHandlerContext> {
  const sessionId = 'owner-agent-files';
  expect(f.bootstrap.getBoundSessionId()).toBe(sessionId);
  const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'account_automation',
    requesterSessionBootstrap: f.bootstrap,
    machineAdmission: { actorAccountId: f.bootstrap.attribution.accountId, custodianAccountId: 'requester',
      machineId: f.machineId, installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: () => f.bootstrap.isCurrent(),
    localActionContext: { authority: 'account_automation', surface: 'mcp', actionRequestId: 'owner-agent-file-read',
      actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } } };
  const selected = selectHostRequesterExecutionIdentity({ rpcContext: context,
    hostHomeServerIdentityId: f.homeServerIdentityId, hostCustodianAccountId: 'requester',
    hostExecutionTarget: { machineId: f.machineId, installationId: f.installation.installationId },
    sessionRequester: f.bootstrap.attribution, sessionRequesterHomeServerIdentityId: f.bootstrap.homeServerIdentityId,
    sessionCustodianAccountId: 'requester' });
  expect(selected).toEqual({ kind: 'isolated', requester: f.bootstrap.attribution, separationRequired: false });
  return context;
}

function assertNativeInvocation(f: Awaited<ReturnType<typeof fixture>>, legacy = false): void {
  expect(f.frames).toHaveLength(1);
  const frame = f.frames[0]!;
  expect(frame.identity).toEqual(legacy ? undefined : {
    username: f.identity.username, agentUid: 2401, agentGid: 2401, home: f.identity.home,
  });
  expect(frame.executable).toBe('/opt/happier/cli/current/happier');
  expect(frame.args).toEqual(['filesystem-effect']);
  expect(frame.cwd).toBe(legacy ? f.sharedHome : f.identity.workspaceRoot);
  expect(frame.runtimeHome.startsWith(`${legacy ? f.sharedHome : f.identity.home}/runtime/operations/`)).toBe(true);
  expect(frame.materialCount).toBe(0);
  expect(f.runAsUsers).toEqual([legacy ? 'happier-agent' : f.identity.username]);
  expect(f.children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
}

async function installCliProbe(f: Awaited<ReturnType<typeof fixture>>, agent: 'claude' | 'codex' = 'claude') {
  const bin = join(f.directory, 'cli-bin');
  const ownerMarker = join(f.directory, 'owner-cli-probe');
  const memberMarker = join(f.directory, 'member-cli-probe');
  await mkdir(bin);
  await writeFile(join(bin, agent), `#!${process.execPath}\n`
    + `const { appendFileSync } = require('node:fs');\n`
    + `const member = [${JSON.stringify(f.member)}, ${JSON.stringify(f.identity.home)}].includes(process.env.HOME);\n`
    + `appendFileSync(member ? ${JSON.stringify(memberMarker)} : ${JSON.stringify(ownerMarker)}, 'probe\\n');\n`
    + `console.log(member ? '2.3.4' : '1.2.3');\n`, { mode: 0o700 });
  const environment = createEnvKeyScope(['PATH', 'HAPPIER_CLAUDE_PATH', 'HAPPIER_CODEX_PATH']);
  environment.patch({ PATH: `${bin}:${process.env.PATH ?? ''}`, HAPPIER_CLAUDE_PATH: undefined, HAPPIER_CODEX_PATH: undefined });
  onTestFinished(() => environment.restore());
  return { ownerMarker, memberMarker, request: {
    requests: [{ id: `cli.${agent}`, params: { bypassCache: true, verifyVersion: true } }],
  } };
}

describe.skipIf(process.platform !== 'linux')('installed Machine filesystem native member receiver', () => {
  it('retains a shared Use requesters refused folder and worker UID in the daemon log', async () => {
    const f = await fixture({ legacy: true });
    const warnings = vi.spyOn(logger, 'warnLocalFile');
    expect(await f.invoke(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
      { directory: { kind: 'path', path: f.foreign } })).toEqual({ ok: false, code: 'invalid_directory' });
    expect(warnings).toHaveBeenCalledWith('[sessionCreation] Directory preflight refused', expect.objectContaining({
      branch: 'directory_readiness', directoryKind: 'path', requestedDirectory: f.foreign,
      directory: f.foreign, effectiveUid: 2402, transportRequestId: 'filesystem-native-1',
    }));
    assertNativeInvocation(f, true);
  }, 120_000);
  it('keeps a fresh owners reviewed-member background folder status read-only', async () => {
    const f = await fixture({ accountId: 'requester', coldPolicy: 'reviewedMember', startupFailure: true });
    const result = await f.invoke(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
      { directory: { kind: 'path', path: '~' } }, 'requester', 'manage');
    expect(f.preparation?.mutations).toEqual([]);
    expect(result).toMatchObject({ code: 'agent_isolation_unavailable' });
    expect(f.children).toEqual([]);
    expect(await readAgentIsolationMemberBindingForAccount({ activeServerDir: configuration.activeServerDir,
      homeServerIdentityId: f.homeServerIdentityId, machineId: f.machineId, installationId: f.installation.installationId }, 'requester')).toBeNull();
  }, 120_000);
  it('rejects preparation intent for a fresh owners managed request before native setup', async () => {
    const f = await fixture({ accountId: 'requester', coldPolicy: 'reviewedMember', startupFailure: true });
    const result = await f.invoke(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
      { directory: { kind: 'managed' }, prepareAgentIsolationMember: true }, 'requester', 'manage');
    expect(f.preparation?.mutations).toEqual([]);
    expect(f.children).toEqual([]);
    expect(result).not.toMatchObject({ ok: true });
  }, 120_000);
  it('prepares a fresh owners member before a deliberate Session folder preflight', async () => {
    const f = await fixture({ accountId: 'requester', coldPolicy: 'reviewedMember', startupFailure: true });
    const scope = { activeServerDir: configuration.activeServerDir, homeServerIdentityId: f.homeServerIdentityId,
      machineId: f.machineId, installationId: f.installation.installationId };
    expect(await readAgentIsolationMemberBindingForAccount(scope, 'requester')).toBeNull();
    const prepared = await f.invoke(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
      { directory: { kind: 'path', path: '~' }, prepareAgentIsolationMember: true }, 'requester', 'manage');
    // The genuine OS child exits at the boundary; internal preparation must
    // already have committed the selected binding before that child starts.
    expect(prepared).toMatchObject({ errorCode: 'filesystem_identity_custody_unavailable' });
    expect(await readAgentIsolationMemberBindingForAccount(scope, 'requester'))
      .toMatchObject({ username: f.identity.username, uid: 2401 });
    expect(f.preparation?.mutations).toContain('agent-account');
    expect(f.runAsUsers).toEqual([f.identity.username]);
  }, 120_000);
  it.each([false, true])('preflights the owners Agent directory as its member (denied=%s)', async denied => {
    const f = await fixture({ accountId: 'requester' });
    const result = await f.invoke(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
      { directory: { kind: 'path', path: denied ? f.foreign : '~' } }, 'requester');
    expect(result).toEqual(denied ? { ok: false, code: 'invalid_directory' } : {
      ok: true, directory: f.member, directoryKind: 'path', directoryCreationRequired: false, checkout: null,
    });
    assertNativeInvocation(f);
  }, 120_000);
  it.each(['request', 'trace'] as const)('preflights a Use grantee session directory in its native member home (%s correlation)', async correlation => {
    const f = await fixture();
    expect(await f.invoke(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
      { directory: { kind: 'path', path: '~' } }, 'member-a', 'use', correlation)).toEqual({
      // This OS-boundary fixture backs the member's HOME at f.member.
      ok: true, directory: f.member, directoryKind: 'path', directoryCreationRequired: false, checkout: null,
    });
    expect(await f.invoke(RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE,
      { directory: { kind: 'path', path: '~' } }, 'member-a', 'use')).toMatchObject({ errorCode: 'agent_isolation_unavailable' });
    assertNativeInvocation(f);
  }, 120_000);
  it('detects managed Codex from the public install home as a Use member without borrowing daemon home', async () => {
    const f = await fixture();
    const probe = await installCliProbe(f, 'codex');
    const installHome = join(f.directory, 'public-install');
    const bin = join(installHome, 'tools', 'providers', 'codex', 'current', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'codex'), await readFile(join(f.directory, 'cli-bin', 'codex')), { mode: 0o755 });
    const environment = createEnvKeyScope(['PATH', 'HAPPIER_FIRST_PARTY_INSTALL_HOME']);
    environment.patch({ PATH: '', HAPPIER_FIRST_PARTY_INSTALL_HOME: installHome });
    onTestFinished(() => environment.restore());
    await expect(f.invoke(RPC_METHODS.CAPABILITIES_DETECT, probe.request, 'member-a', 'use'))
      .resolves.toMatchObject({ results: { 'cli.codex': { ok: true, data: { available: true, version: '2.3.4' } } } });
    expect(await readFile(probe.ownerMarker, 'utf8').catch(() => '')).toBe('');
    expect(await readFile(probe.memberMarker, 'utf8')).not.toBe('');
    assertNativeInvocation(f);
  }, 120_000);
  it('keeps the member setup owners typed refusal in native preparation', async () => {
    const f = await fixture({ coldPolicy: 'managed' });
    if (!f.preparation) throw new Error('Missing member preparation boundary');
    f.machine.registerMachineAgentIsolationRoutes(f.preparation.effects);
    // The installed Machine has no published member policy. Its real setup
    // owner refuses before any native mutation; preserve that decided result.
    const requesterIdentity = { kind: 'isolated' as const, separationRequired: true,
      requester: f.identity.requester, homeServerIdentityId: f.homeServerIdentityId };
    await expect(f.machine.prepareAgentIsolationMember({ requesterIdentity, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'agent_isolation_unavailable', details: {
        reason: 'member_setup_required', phase: 'native_execution_preparation', outcome: 'not_applied', reasonCode: 'denied',
      } });
    expect(f.preparation.mutations).toEqual([]);
  }, 120_000);

  it('prepares first-use Codex model-picker invocation for a Use grantee', async () => {
    const f = await fixture({ coldPolicy: 'managed' });
    const scope = { activeServerDir: configuration.activeServerDir, homeServerIdentityId: f.homeServerIdentityId,
      machineId: f.machineId, installationId: f.installation.installationId };
    expect(await readAgentIsolationMemberBindingForAccount(scope, 'member-a')).toBeNull();
    const result = await f.invoke(RPC_METHODS.CAPABILITIES_INVOKE,
      { id: 'cli.codex', method: 'probeModels', params: {} }, 'member-a', 'use');
    expect(result).toMatchObject({ ok: true });
    expect(await readAgentIsolationMemberBindingForAccount(scope, 'member-a'))
      .toMatchObject({ username: f.identity.username, uid: 2401 });
    expect(nativeOs.readinessProbes).toBe(1);
    assertNativeInvocation(f);
  }, 120_000);

  it.each(['managed', 'legacy'] as const)('prepares first-use Codex for a Use grantee only with reviewed member consent (%s)', async policy => {
    const f = await fixture({ coldPolicy: policy });
    const probe = await installCliProbe(f, 'codex');
    const scope = { activeServerDir: configuration.activeServerDir, homeServerIdentityId: f.homeServerIdentityId,
      machineId: f.machineId, installationId: f.installation.installationId };
    expect(await readAgentIsolationMemberBindingForAccount(scope, 'member-a')).toBeNull();
    const result = await f.invoke(RPC_METHODS.CAPABILITIES_DETECT, probe.request, 'member-a', 'use');
    if (policy === 'legacy') {
      expect(result).toMatchObject({ code: 'agent_isolation_unavailable' });
      expect(f.preparation.mutations).toEqual([]);
      expect(nativeOs.readinessProbes).toBe(0);
      expect(f.runAsUsers).toEqual([]);
      expect(await readAgentIsolationMemberBindingForAccount(scope, 'member-a')).toBeNull();
      expect(await readFile(probe.memberMarker, 'utf8').catch(() => '')).toBe('');
    } else {
      expect(result).toMatchObject({ protocolVersion: 1, results: { 'cli.codex': {
        ok: true, data: { available: true, version: '2.3.4' },
      } } });
      expect(f.preparation.mutations).toContain('agent-account');
      // One member qualification for the whole capability operation, never
      // another Home admission or one native probe per discovery sub-step.
      expect(nativeOs.readinessProbes).toBe(1);
      expect(await readAgentIsolationMemberBindingForAccount(scope, 'member-a'))
        .toMatchObject({ username: f.identity.username, uid: 2401 });
      expect(await readFile(probe.memberMarker, 'utf8')).not.toBe('');
      assertNativeInvocation(f);
    }
    expect(await readFile(probe.ownerMarker, 'utf8').catch(() => '')).toBe('');
  }, 120_000);

  it.each(['launcher-exit', 'cleanup-refused'] as const)('settles native Codex discovery after %s', async failure => {
    const f = await fixture(failure === 'launcher-exit' ? { startupFailure: true } : { cleanupRefused: true });
    const probe = await installCliProbe(f, 'codex');
    const kill = process.kill.bind(process);
    let refused = false;
    // Sudo's root-owned launcher is a genuine OS signal boundary. Ingress,
    // member preparation, framing and channel handling remain real.
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (failure === 'cleanup-refused' && signal && signal !== 0 && f.children.some(child => child.pid === pid)) {
        refused = true;
        throw Object.assign(new Error('Constructed run-as signal refusal'), { code: 'EPERM' });
      }
      return kill(pid, signal);
    });
    try {
      await expect(f.invoke(RPC_METHODS.CAPABILITIES_DETECT, probe.request, 'member-a', 'use'))
        .resolves.toMatchObject(failure === 'launcher-exit' ? { errorCode: 'filesystem_identity_custody_unavailable' } : { code: 'indeterminate' });
      expect(refused).toBe(failure === 'cleanup-refused');
      expect(f.runAsUsers).toEqual([f.identity.username]);
      expect(await readFile(probe.ownerMarker, 'utf8').catch(() => '')).toBe('');
    } finally {
      for (const child of f.children) if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
        child.kill('SIGKILL'); await closed;
      }
    }
  });

  it('settles successful member Codex discovery through EOF without signalling the run-as launcher', async () => {
    // Procfs reports the native run-as principal, not the daemon's. Keep the
    // real census/refusal owner rather than replacing its decision or signals.
    const f = await fixture({ coldPolicy: 'managed', foreignLauncher: true });
    const probe = await installCliProbe(f, 'codex');
    await expect(f.invoke(RPC_METHODS.CAPABILITIES_DETECT, probe.request, 'member-a', 'use'))
      .resolves.toMatchObject({ protocolVersion: 1, results: { 'cli.codex': {
        ok: true, data: { available: true, version: '2.3.4' },
      } } });
    expect(await readFile(probe.memberMarker, 'utf8')).not.toBe('');
    expect(await readFile(probe.ownerMarker, 'utf8').catch(() => '')).toBe('');
    assertNativeInvocation(f);
    expect(f.children.map(child => ({ code: child.exitCode, signal: child.signalCode })))
      .toEqual([{ code: 0, signal: null }]);
  }, 120_000);

  it('refuses the Codex payload when the prepared member fails its native readiness probe', async () => {
    const f = await fixture({ coldPolicy: 'managed' });
    const probe = await installCliProbe(f, 'codex');
    nativeOs.readinessFailure = true;
    expect(await f.invoke(RPC_METHODS.CAPABILITIES_DETECT, probe.request, 'member-a', 'use'))
      .toMatchObject({ code: 'agent_isolation_unavailable' });
    expect(f.preparation.mutations).toContain('agent-account');
    expect(f.runAsUsers).toEqual([]);
    expect(await readFile(probe.memberMarker, 'utf8').catch(() => '')).toBe('');
    expect(await readFile(probe.ownerMarker, 'utf8').catch(() => '')).toBe('');
  }, 120_000);

  it.each(['owner', 'member'] as const)('detects the normal CLI usefully as the admitted %s without a daemon deputy', async placement => {
    const f = await fixture();
    const probe = await installCliProbe(f);
    // The production cli.claude definition owns private_read + process. This
    // drives its real snapshot/version probe, not a test capability or service.
    const result = await f.invoke(RPC_METHODS.CAPABILITIES_DETECT, probe.request,
      placement === 'owner' ? 'requester' : 'member-a');
    const detection = z.object({ results: z.object({ 'cli.claude': z.object({
      error: z.optional(z.object({ code: z.optional(z.string()), message: z.string() })),
    }) }) }).parse(result).results['cli.claude'];
    expect(detection.error).toBeUndefined();
    expect(result).toMatchObject({ protocolVersion: 1, results: { 'cli.claude': {
      ok: true, data: { available: true, version: placement === 'owner' ? '1.2.3' : '2.3.4' },
    } } });
    const observed = async (path: string) => readFile(path, 'utf8').catch(() => '');
    expect(await observed(placement === 'owner' ? probe.ownerMarker : probe.memberMarker)).not.toBe('');
    expect(await observed(placement === 'owner' ? probe.memberMarker : probe.ownerMarker)).toBe('');
    if (placement === 'member') assertNativeInvocation(f);
    else expect(f.runAsUsers).toHaveLength(0);
  }, 120_000);

  it.each(['unknown', 'foreign'] as const)('refuses %s Machine custody before a capability probe payload', async custody => {
    const f = await fixture();
    const probe = await installCliProbe(f);
    await expect(f.receive({ method: `machine:${RPC_METHODS.CAPABILITIES_DETECT}`, params: probe.request,
      requestId: `capability-${custody}`, callerAuthority: 'present_user',
      ...(custody === 'foreign' ? { machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'neighbor',
        machineId: f.machineId, installationId: f.installation.installationId, role: 'manage' as const,
        encryptionMode: 'plain' as const } } : {}),
    })).resolves.toMatchObject({ errorCode: custody === 'foreign'
      ? 'RPC_FORBIDDEN' : 'filesystem_identity_custody_unavailable' });
    expect(f.runAsUsers).toHaveLength(0);
    expect(await readFile(probe.ownerMarker, 'utf8').catch(() => '')).toBe('');
    expect(await readFile(probe.memberMarker, 'utf8').catch(() => '')).toBe('');
  }, 120_000);

  it('keeps admitted owner and Use requests on the daemon file path when isolation is off', async () => {
    const f = await createInstalledFilesystemMachineFixture({ boundSessionId: 'owner-agent-files', agentIsolation: {
      read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }),
    } });
    const context = await admittedOwnerAgentFileContext(f);
    const path = join(f.directory, 'owner-agent.dat');
    const bytes = Buffer.from([0, 255, 128, 7]);
    await writeFile(path, bytes);
    let nativeSpawns = 0;
    nativeOs.spawn = () => { nativeSpawns++; throw new Error('Disabled isolation cannot launch a native filesystem process'); };
    const before = f.admissionChecks();
    // This is the installed MCP/control-plane delegation route. Its real
    // Session bootstrap remains host-private through the receiving authorizer.
    await expect(f.rpcHandlerManager.invokeLocal(RPC_METHODS.READ_FILE, { path }, {
      signal: context.signal, rpcContext: context, localActionContext: context.localActionContext,
    })).resolves.toMatchObject({ success: true, content: bytes.toString('base64') });
    expect(f.admissionChecks() - before).toBe(1);
    expect(nativeSpawns).toBe(0);
    await expect(f.invoke(RPC_METHODS.READ_FILE, { path }, { actorAccountId: 'member-a', callerAuthority: 'present_user', role: 'use' }))
      .resolves.toMatchObject({ success: true, content: bytes.toString('base64') });
    expect(nativeSpawns).toBe(0);
    expect(await readFile(path)).toEqual(bytes);
  });

  describe.each(['legacy', 'linuxUsersV1'] as const)('admitted owner Agent %s file placement', mode => {
    it.each(['own binary bytes', 'foreign refusal'] as const)('preserves %s without borrowing daemon-private rights', async contract => {
      const f = await fixture({ accountId: 'requester', legacy: mode === 'legacy' });
      const context = await admittedOwnerAgentFileContext(f);
      const before = f.admissionChecks();
      const path = contract === 'own binary bytes' ? join(f.member, 'owned.dat') : join(f.foreign, 'private.dat');
      const result = await f.rpcHandlerManager.invokeLocal(RPC_METHODS.READ_FILE, { path }, {
        signal: context.signal, rpcContext: context, localActionContext: { ...context.localActionContext,
          actionRequestId: `owner-agent-${mode}-${contract}` },
      });
      expect(f.admissionChecks() - before).toBe(1);
      expect(result).toMatchObject(contract === 'own binary bytes' ? { success: true,
        content: Buffer.from([0, 255, 1, 254]).toString('base64') } : { success: false, error: 'constructed native EACCES' });
      assertNativeInvocation(f, mode === 'legacy');
      if (mode === 'legacy') {
        await expect(f.invoke(RPC_METHODS.READ_FILE, { path: join(f.foreign, 'private.dat') }, 'member-a'))
          .resolves.toMatchObject({ errorCode: 'agent_isolation_unavailable' });
        expect(f.runAsUsers).toHaveLength(1);
      }
    }, 120_000);
  });

  it('keeps owner reads useful and sends registered member binary reads through the exact native frame', async () => {
    const f = await fixture();
    await expect(f.invoke(RPC_METHODS.READ_FILE, { path: join(f.member, 'owned.dat') }, 'requester'))
      .resolves.toMatchObject({ success: true, content: Buffer.from([0, 255, 1, 254]).toString('base64') });
    expect(f.frames).toHaveLength(0);
    await expect(f.invoke(RPC_METHODS.READ_FILE, { path: join(f.member, 'owned.dat') }))
      .resolves.toMatchObject({ success: true, content: Buffer.from([0, 255, 1, 254]).toString('base64') });
    assertNativeInvocation(f);
  }, 120_000);

  it('lists member-owned files through the registered native receiver', async () => {
    const f = await fixture();
    await expect(f.invoke(RPC_METHODS.LIST_DIRECTORY, { path: f.member }))
      .resolves.toMatchObject({ success: true,
        entries: expect.arrayContaining([expect.objectContaining({ name: 'owned.dat', type: 'file' })]) });
    assertNativeInvocation(f);
  }, 120_000);

  it('denies foreign private bytes through the registered member native receiver', async () => {
    const f = await fixture();
    await expect(f.invoke(RPC_METHODS.READ_FILE, { path: join(f.foreign, 'private.dat') }))
      .resolves.toMatchObject({ success: false, error: 'constructed native EACCES' });
    assertNativeInvocation(f);
  }, 120_000);

  it('retains one native process across registered encrypted upload phases with one admission per RPC and local copied-ID refusal', async () => {
    const f = await fixture();
    const bytes = Buffer.from([0, 255, 128, 1]);
    const result = await f.invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
      { path: join(f.member, 'uploaded.dat'), sizeBytes: bytes.length, overwrite: false });
    expect(result).toMatchObject({ success: true });
    const opened = z.object({ success: z.literal(true), uploadId: z.string(), recipientPublicKeyBase64: z.string() }).parse(result);
    expect(f.frames).toHaveLength(1);
    const encrypted = createEncryptedTransferChunkEnvelope({ transferId: opened.uploadId, sequence: 0,
      payload: bytes, recipientPublicKeyBase64: opened.recipientPublicKeyBase64 });
    const chunk = { uploadId: opened.uploadId, index: 0, payloadBase64: encrypted.payloadBase64,
      encryptedDataKeyEnvelopeBase64: encrypted.encryptedDataKeyEnvelopeBase64 };
    await expect(f.invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, chunk, 'member-b'))
      .resolves.toMatchObject({ success: false, errorCode: 'FILESYSTEM_TRANSFER_SCOPE_MISMATCH' });
    await expect(f.invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, chunk)).resolves.toMatchObject({ success: true });
    expect(f.frames).toHaveLength(1);
    expect(f.children[0]?.exitCode).toBeNull();
    await expect(f.invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: opened.uploadId })).resolves.toMatchObject({ success: true });
    expect(await readFile(join(f.member, 'uploaded.dat'))).toEqual(bytes);
    expect(f.frames).toHaveLength(1);
    expect(f.children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  }, 120_000);
});
