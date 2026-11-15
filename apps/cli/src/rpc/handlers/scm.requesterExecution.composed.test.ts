import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createHostScmCommandRunner } from '@/scm/runtime';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { removeTempDir } from '@/testkit/fs/tempDir';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { configuration } from '@/configuration';
import type { HostAgentIsolationLaunchContext, HostAgentIsolationLaunchSnapshot } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { prepareRequesterNativeOperation } from '@/daemon/agentIsolation/prepareNativeOperation';
import { createAgentIsolationMemberPreparationBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { buildAgentIsolationProvisioningSteps, deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { writeAgentIsolationMemberBinding } from '@/daemon/agentIsolation/memberBindings';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { runWithHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting/runtime';

type RunAsFrame = Readonly<{ username: string; agentUid?: number; executable: string; args: string[]; cwd: string }>;
const os = vi.hoisted(() => ({
  member: undefined as undefined | { home: string; root: string; backing: string; uid: number },
  runAs: [] as RunAsFrame[],
  direct: [] as Array<{ command: string; uid: number | undefined }>,
}));

// Only OS boundaries are substituted: run-as (sudo) and the member's private
// directories. Ingress, requester selection, member preparation, the launch
// frame, Exec, the SCM owner and real Git processes stay production code.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  const backing = (path: unknown) => {
    const member = os.member;
    if (!member || typeof path !== 'string') return undefined;
    if (path === member.home || path.startsWith(`${member.home}/`)) return member.backing;
    if (path === member.root || path.startsWith(`${member.root}/`)) return member.backing + path.slice(member.root.length);
    return undefined;
  };
  return { ...actual,
    async lstat(path: Parameters<typeof actual.lstat>[0]) {
      const member = os.member;
      if (member && String(path) === member.home) return Object.assign(await actual.lstat(member.backing),
        { uid: member.uid, gid: member.uid, mode: 0o40700 });
      return actual.lstat(backing(path) ?? path);
    },
    async realpath(path: Parameters<typeof actual.realpath>[0]) {
      const mapped = backing(path);
      if (mapped) { await actual.realpath(mapped); return String(path); }
      return actual.realpath(path);
    },
  };
});
vi.mock('@happier-dev/cli-common/process', async original => {
  const actual = await original<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...args: Parameters<typeof actual.execFileWithDeadline>) => {
    const [command, argv, options] = args;
    if (command !== 'sudo' || argv?.at(-1) !== 'agent-launch' || !options?.inputBytes) return actual.execFileWithDeadline(...args);
    const frame = await readAgentLaunchFrame(Readable.from([options.inputBytes], { objectMode: false }), undefined, true);
    if (!('action' in frame)) throw new Error('Unexpected member payload outside the run-as process boundary');
    return { stdout: '', stderr: '' };
  } };
});
// The run-as child reads the exact production frame, runs its executable in the
// member folder's backing directory and reports Git's paths under the member folder.
const runAsWorker = String.raw`
const { spawn } = require('node:child_process');
const [root, backing] = [process.env.MEMBER_ROOT, process.env.MEMBER_BACKING];
let buffered = Buffer.alloc(0);
function receive(chunk) {
  buffered = Buffer.concat([buffered, chunk]);
  if (buffered.length < 12) return;
  if (buffered.subarray(0, 8).toString() !== 'HAPAGT1\n') process.exit(70);
  const length = buffered.readUInt32BE(8);
  if (buffered.length < 12 + length) return;
  process.stdin.off('data', receive); process.stdin.pause();
  const frame = JSON.parse(buffered.subarray(12, 12 + length).toString('utf8'));
  const rest = buffered.subarray(12 + length);
  process.send({ username: frame.nativeIdentity?.username, agentUid: frame.nativeIdentity?.agentUid,
    executable: frame.executable, args: frame.args, cwd: frame.cwd });
  const cwd = frame.cwd === root || frame.cwd.startsWith(root + '/') ? backing + frame.cwd.slice(root.length) : frame.cwd;
  const child = spawn(frame.executable, frame.args, { cwd, env: { ...frame.environment, PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'inherit'] });
  if (rest.length) child.stdin.write(rest);
  process.stdin.pipe(child.stdin); process.stdin.resume();
  const out = [];
  child.stdout.on('data', c => out.push(c));
  child.on('close', code => {
    process.stdout.write(Buffer.from(Buffer.concat(out).toString('latin1').split(backing).join(root), 'latin1'), () => {
      process.disconnect(); process.exit(code ?? 1);
    });
  });
}
process.stdin.on('data', receive);
`;
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn((command: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcess => {
    const member = os.member;
    if (command !== 'sudo' || !member) {
      os.direct.push({ command, uid: options.uid ?? process.getuid?.() });
      return actual.spawn(command, args, options);
    }
    const child = actual.spawn(process.execPath, ['-e', runAsWorker], { ...options, cwd: tmpdir(),
      env: { PATH: process.env.PATH, MEMBER_ROOT: member.root, MEMBER_BACKING: member.backing },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    child.on('message', message => { os.runAs.push({ ...(message as RunAsFrame), username: `${args[2]}:${(message as RunAsFrame).username}` }); });
    return child;
  }) };
});
afterEach(() => { os.member = undefined; os.runAs.length = 0; os.direct.length = 0; vi.restoreAllMocks(); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Owner test', '-c', 'user.email=owner@example.invalid', ...args],
  { cwd, encoding: 'utf8' });
async function repository(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'commit', '-q', '--allow-empty', '-m', 'initial');
  return path;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'happier-scm-requester-'));
  onTestFinished(() => removeTempDir(directory));
  const ownerRepository = await repository(directory, 'owner-project');
  const machineId = 'separate-users-machine';
  const installationId = 'separate-users-installation';
  const home = configuration.activeServerId;
  const requesterIdentity = { kind: 'isolated' as const, separationRequired: true, homeServerIdentityId: home,
    requester: { serverId: home, accountId: 'member-account', machineId, installationId } };
  const member = deriveAgentIsolationMemberIdentity(requesterIdentity);
  const preparation = createAgentIsolationMemberPreparationBoundary({ activeServerDir: configuration.activeServerDir,
    requesterIdentity, custodianAccountId: 'owner-account', encryptionMode: 'plain', uid: 2401 });
  for (const step of buildAgentIsolationProvisioningSteps({ requesterIdentity, daemonUsername: 'happier',
    daemonPrimaryGroup: 'happier', binaryPath: '/opt/happier/cli/current/happier' })) preparation.installed.add(step.id);
  await writeAgentIsolationMemberBinding(configuration.activeServerDir, { ...member, agentUid: 2401, agentGid: 2401 });
  const memberBacking = join(directory, 'member-folder');
  await repository(memberBacking, 'member-project');
  os.member = { home: member.home, root: member.workspaceRoot, backing: memberBacking, uid: 2401 };
  const daemonIsolation: HostAgentIsolationLaunchSnapshot = {
    enabled: true, memberProvisioning: 'linuxUsersV1',
    status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' },
    workspaceRoots: [ownerRepository],
  };
  // The installed daemon's isolation port, as startDaemon composes it, plus the member binding reader.
  const port: HostAgentIsolationLaunchContext = { read: () => daemonIsolation,
    managedHappierBinaryPath: '/opt/happier/cli/current/happier',
    readMember: input => preparation.members.read(input) };
  const registration = createGitScmBackendRuntimeRegistration();
  const backend = createRegisteredScmBackendAdapter({
    definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
    executableDefinition: registration.runtime!, registration,
    scmCommandRunner: createHostScmCommandRunner({ isCurrent: () => true, agentIsolation: { read: () => daemonIsolation } }),
  });
  const manager = createRpcHandlerManager({
    scopePrefix: machineId, scopeKind: 'machine', localMachineId: machineId,
    encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy', encryptionMode: 'plain',
    authorizeRequest: request => authorizeMachineRpcRequest(request, {
      machineId,
      resolveCustodianAccountId: async () => 'owner-account',
      resolveInstallationId: () => installationId,
      resolveHomeServerIdentityId: async () => home,
      // Authentication/currentness are the Home network boundary.
      verifyMachineAdmission: async () => true,
    }),
  });
  const effectAdmission = createFilesystemEffectAdmission({
    readAgentIsolation: () => daemonIsolation,
    resolveHomeServerIdentityId: async () => home,
    resolveHostIdentity: async () => ({ custodianAccountId: 'owner-account', machineId, installationId }),
  });
  registerScmHandlers(manager, ownerRepository, {
    machineId,
    registry: createScmBackendRegistry([backend]),
    accessPolicy: { kind: 'osUser' },
    resolveRequester: effectAdmission.resolveRpcRequester,
    // apiMachine.prepareNativeOperation, the member execution owner bash and Project Open use.
    nativeOperationRuntime: { prepareNativeOperation: input => prepareRequesterNativeOperation(input, {
      machine: port, homeServerIdentityId: home, machineId, installationId }) },
  });
  const invoke = (method: string, params: unknown, accountId: string, role: 'manage' | 'use') =>
    manager.invokeLocal(method, params, { rpcContext: {
      callerAuthority: 'present_user',
      verifyMachineAdmissionCurrent: async () => true,
      machineAdmission: { actorAccountId: accountId, custodianAccountId: 'owner-account', machineId, installationId,
        role, encryptionMode: 'plain' },
    } });
  return { directory, ownerRepository, memberRepository: `${member.workspaceRoot}/member-project`, member, manager, invoke };
}

const gitLaunches = () => os.direct.filter(launch => launch.command.endsWith('git'));

// R126S3 / ISOLATION-REPAIR-1114 / MEMBER-SCM-READ-1114 on a separate-users Machine.
describe.skipIf(process.platform !== 'linux')('Session-less Project SCM placement', () => {
  it('keeps a closed host call on the daemon isolation port and runs Manage as the daemon user', async () => {
    const f = await fixture();
    // Before any cached snapshot: the daemon's isolation port refusal stays typed.
    expect(await f.manager.invokeLocal(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.ownerRepository }))
      .toMatchObject({ success: false, errorCode: 'BACKEND_UNAVAILABLE', actionErrorCode: expect.any(String) });
    expect(gitLaunches()).toEqual([]);
    const response = await f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.ownerRepository }, 'manager-account', 'manage');
    expect(response, JSON.stringify(response)).toMatchObject({ success: true, snapshot: { repo: { isRepo: true } } });
    // Manage is full control of the Machine (owner ruling 2026-10-31): unisolated, as the daemon user.
    expect(gitLaunches().length).toBeGreaterThan(0);
    expect(gitLaunches().every(launch => launch.uid === process.getuid?.())).toBe(true);
    expect(os.runAs).toEqual([]);
  });

  it('pushes for Manage on an isolated Machine', async () => {
    const f = await fixture();
    const remote = join(f.directory, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(f.ownerRepository, 'remote', 'add', 'origin', remote);
    // The installed plugin runtime supplies hosting services; a local bare remote matches no forge.
    const services = { resolveScmHostingProviderRegistry: async () => ({ detectRemote: () => ({ kind: 'unresolved' }), buildCompareUrl: () => ({ kind: 'unresolved' }) }) };
    const pushed = await runWithHostingProviderRuntimeServices(services as unknown as Parameters<typeof runWithHostingProviderRuntimeServices>[0],
      () => f.invoke(RPC_METHODS.SCM_REMOTE_PUSH, { cwd: f.ownerRepository, remote: 'origin', branch: 'main' }, 'manager-account', 'manage'));
    expect(pushed, JSON.stringify(pushed)).toMatchObject({ success: true });
    expect(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim())
      .toBe(git(f.ownerRepository, 'rev-parse', 'main').trim());
  });

  // SEC-FORKC-1115F F1: the daemon still reads member-controlled .git state files in process, so
  // a Can use member's local read is refused at ingress until the whole read runs as the member.
  it('refuses a Can use local repository read before any Git process or daemon state read', async () => {
    const f = await fixture();
    for (const [method, params] of [
      [RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.memberRepository }],
      [RPC_METHODS.SCM_LOG_LIST, { cwd: f.memberRepository, limit: 5 }],
    ] as const) {
      expect(await f.invoke(method, params, 'member-account', 'use')).toMatchObject({ errorCode: 'machine_manage_required' });
    }
    expect(gitLaunches()).toEqual([]);
    expect(os.runAs).toEqual([]);
  });

  it('refuses Can use reads of another folder, forge methods and captured evidence before any Git process', async () => {
    const f = await fixture();
    expect(await f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.ownerRepository }, 'member-account', 'use'))
      .toMatchObject({ errorCode: 'machine_manage_required' });
    expect(await f.invoke(RPC_METHODS.SCM_PULL_REQUEST_LIST, { cwd: f.memberRepository }, 'member-account', 'use'))
      .toMatchObject({ errorCode: 'machine_manage_required' });
    expect(await f.invoke(RPC_METHODS.SCM_DIFF_FILE, { cwd: f.memberRepository,
      captured: { comparisonId: 'a'.repeat(64), source: { kind: 'workingTree' }, path: 'x' } }, 'member-account', 'use'))
      .toMatchObject({ errorCode: 'machine_manage_required' });
    expect(gitLaunches()).toEqual([]);
    expect(os.runAs.filter(frame => !frame.cwd.startsWith(f.member.workspaceRoot))).toEqual([]);
  });
});
