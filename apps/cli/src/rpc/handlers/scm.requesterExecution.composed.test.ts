import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { execFileSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createRequire, syncBuiltinESMExports } from 'node:module';
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
import type { HostAgentIsolationLaunchSnapshot, HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { runWithHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting/runtime';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { runWorkspaceEffectWorker } from '@/workspaces/activation/workspaceEffectWorker';
import type { ApiMachineClient } from '@/api/apiMachine';

const os = vi.hoisted(() => ({
  identity: undefined as unknown as import('node:async_hooks').AsyncLocalStorage<'member'>,
  repository: '',
  secret: '',
  daemonTouches: [] as string[],
  memberReads: [] as string[],
  direct: [] as Array<{ command: string; uid: number | undefined; member: boolean }>,
  runAs: [] as Array<{ args: readonly string[]; uid?: number }>,
}));
os.identity = new AsyncLocalStorage<'member'>();

// OS boundaries only: the member's UID (an identity scope standing in for the kernel:
// the member cannot read a daemon-private file) and RunAs. Ingress, requester
// selection, Exec launch, the Workspace effect bridge and child, SCM and real Git stay real.
// The builtin is patched in place (not module-mocked) so plugin-loaded backends see it too.
const fsPromises = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
const originalFs = { ...fsPromises };
beforeAll(() => {
  const guard = async (path: unknown) => {
    const name = typeof path === 'string' ? path : path instanceof URL ? path.pathname : '';
    if (!os.repository || !(name === os.repository || name.startsWith(`${os.repository}/`))) return;
    if (os.identity.getStore() !== 'member') { os.daemonTouches.push(name); return; }
    os.memberReads.push(name);
    if (os.secret && await originalFs.realpath(name).catch(() => null) === os.secret)
      throw Object.assign(new Error('Member cannot read a daemon-private file'), { code: 'EACCES' });
  };
  for (const name of ['readFile', 'stat', 'lstat', 'open', 'readdir', 'access'] as const) {
    const original = originalFs[name] as (...args: unknown[]) => Promise<unknown>;
    Object.assign(fsPromises, { [name]: async (...args: unknown[]) => { await guard(args[0]); return original(...args); } });
  }
  syncBuiltinESMExports();
});
afterAll(() => { Object.assign(fsPromises, originalFs); syncBuiltinESMExports(); });
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: (command: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcess => {
    if (command !== 'sudo') {
      os.direct.push({ command, uid: options.uid ?? process.getuid?.(), member: os.identity.getStore() === 'member' });
      return actual.spawn(command, args, options);
    }
    // RunAs: the framed payload runs as the member (in-process, under the member identity scope).
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: undefined, exitCode: null as number | null, signalCode: null, killed: false });
    const finish = (code: number) => { child.exitCode = code; child.stdout.end(); child.stderr.end();
      child.emit('exit', code, null); child.emit('close', code, null); };
    queueMicrotask(() => void os.identity.run('member', async () => {
      try {
        const frame = await readAgentLaunchFrame(child.stdin as Readable);
        os.runAs.push({ args: frame.args, uid: frame.nativeIdentity?.agentUid });
        if (frame.args[0] === 'workspace-effect') {
          await runWorkspaceEffectWorker([], { input: child.stdin, output: child.stdout, signal: new AbortController().signal,
            currentDirectory: () => frame.cwd });
          finish(0); return;
        }
        // Any other framed command (a Git invocation) runs as the member.
        const run = actual.spawn(frame.executable, frame.args, { cwd: frame.cwd, env: { ...frame.environment, PATH: process.env.PATH } });
        child.stdin.pipe(run.stdin); run.stdout.pipe(child.stdout, { end: false }); run.stderr.pipe(child.stderr, { end: false });
        run.on('close', code => finish(code ?? 1));
      } catch { finish(1); }
    }));
    return child as unknown as ChildProcess;
  } };
});
afterEach(() => { os.repository = ''; os.secret = ''; os.daemonTouches.length = 0; os.memberReads.length = 0;
  os.direct.length = 0; os.runAs.length = 0; vi.restoreAllMocks(); });

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
  const plugins = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
  onTestFinished(() => plugins.dispose());
  const directory = await mkdtemp(join(tmpdir(), 'happier-scm-requester-'));
  onTestFinished(() => removeTempDir(directory));
  const ownerRepository = await repository(directory, 'owner-project');
  const memberRoot = join(directory, 'member-folder');
  const memberRepository = await repository(memberRoot, 'member-project');
  const memberHome = join(directory, 'member-home');
  const machineId = 'separate-users-machine';
  const installationId = 'separate-users-installation';
  const home = configuration.activeServerId;
  const daemonIsolation: HostAgentIsolationLaunchSnapshot = {
    enabled: true, memberProvisioning: 'linuxUsersV1',
    status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' },
    workspaceRoots: [ownerRepository],
  };
  // The member binding is native OS state: its folder is a real directory of this fixture.
  const prepareNativeOperation = (async (request: Readonly<{ requesterIdentity: HostRequesterExecutionIdentity }>) => {
    if (request.requesterIdentity.kind !== 'isolated') throw Object.assign(new Error('not a member'), { code: 'agent_isolation_unavailable' });
    const memberIdentity = { ...deriveAgentIsolationMemberIdentity({ ...request.requesterIdentity, homeServerIdentityId: home }),
      workspaceRoot: memberRoot, home: memberHome, agentUid: 2401, agentGid: 2401 };
    const snapshot = { ...daemonIsolation, workspaceRoots: [memberRoot], memberIdentity, localTransport: { agentUid: 2401, agentGid: 2401 },
      launch: { managedHappierBinaryPath: '/opt/happier/cli/current/happier', runtimeHome: join(memberHome, 'runtime'),
        environment: {}, selectedEnvironmentKeys: [], selectedMaterials: [] } };
    return { requesterIdentity: request.requesterIdentity, memberIdentity, workingDirectory: memberRoot,
      agentIsolation: { requesterIdentity: request.requesterIdentity, read: () => snapshot },
      materialTarget: { runtimeHome: snapshot.launch.runtimeHome, memberIdentity }, dispose: async () => {} };
  }) as unknown as ApiMachineClient['prepareNativeOperation'];
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
    nativeOperationRuntime: { prepareNativeOperation },
  });
  const invoke = (method: string, params: unknown, accountId: string, role: 'manage' | 'use', signal?: AbortSignal) =>
    manager.invokeLocal(method, params, { rpcContext: {
      callerAuthority: 'present_user',
      verifyMachineAdmissionCurrent: async () => true,
      ...(signal ? { signal } : {}),
      machineAdmission: { actorAccountId: accountId, custodianAccountId: 'owner-account', machineId, installationId,
        role, encryptionMode: 'plain' },
    } });
  os.repository = memberRepository;
  return { directory, ownerRepository, memberRoot, memberRepository, invoke, manager };
}

const gitLaunches = () => os.direct.filter(launch => launch.command.endsWith('git'));
const daemonGit = () => gitLaunches().filter(launch => !launch.member);

// R126S3 / ISOLATION-REPAIR-1114 / MEMBER-SCM-READ-1114 / SEC-FORKC-1115F on a separate-users Machine.
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
    expect(gitLaunches().every(launch => launch.uid === process.getuid?.() && !launch.member)).toBe(true);
    expect(os.runAs).toEqual([]);
  });

  it('pushes for Manage on an isolated Machine', async () => {
    const f = await fixture();
    const remote = join(f.directory, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(f.ownerRepository, 'remote', 'add', 'origin', remote);
    // The installed plugin runtime supplies hosting services; a local bare remote matches no forge.
    const services = { resolveScmHostingProviderRegistry: async () => ({
      detectRemote: () => ({ kind: 'unresolved' }), buildCompareUrl: () => ({ kind: 'unresolved' }) }) };
    const pushed = await runWithHostingProviderRuntimeServices(services as unknown as Parameters<typeof runWithHostingProviderRuntimeServices>[0],
      () => f.invoke(RPC_METHODS.SCM_REMOTE_PUSH, { cwd: f.ownerRepository, remote: 'origin', branch: 'main' }, 'manager-account', 'manage'));
    expect(pushed, JSON.stringify(pushed)).toMatchObject({ success: true });
    expect(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim())
      .toBe(git(f.ownerRepository, 'rev-parse', 'main').trim());
  });

  it('runs a Can use local repository read whole in the member child, inside the member folder', async () => {
    const f = await fixture();
    for (const [method, params] of [
      [RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.memberRepository }],
      [RPC_METHODS.SCM_LOG_LIST, { cwd: f.memberRepository, limit: 5 }],
    ] as const) {
      const response = await f.invoke(method, params, 'member-account', 'use');
      expect(response, JSON.stringify(response)).toMatchObject({ success: true });
    }
    expect(os.runAs.map(run => [run.args[0], run.uid])).toEqual([['workspace-effect', 2401], ['workspace-effect', 2401]]);
    expect(gitLaunches().length).toBeGreaterThan(0);
    expect(daemonGit()).toEqual([]);
    expect(os.daemonTouches).toEqual([]);
  });

  // SEC-FORKC-1115F F1: a member-planted Git state file must never be opened by the daemon.
  it('never discloses a symlinked Git state file target and never opens it in the daemon', async () => {
    const f = await fixture();
    os.secret = join(f.directory, 'daemon-credentials');
    await writeFile(os.secret, 'OWNER-SECRET-TOKEN-abc123', { mode: 0o600 });
    const state = join(f.memberRepository, '.git', 'rebase-merge');
    await mkdir(state);
    await writeFile(join(state, 'head-name'), 'refs/heads/main\n');
    await writeFile(join(state, 'onto'), `${git(f.memberRepository, 'rev-parse', 'HEAD').trim()}\n`);
    await symlink(os.secret, join(state, 'onto_name'));
    const response = await f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.memberRepository }, 'member-account', 'use');
    expect(JSON.stringify(response)).not.toContain('OWNER-SECRET-TOKEN');
    expect(os.memberReads).toContain(join(state, 'onto_name'));
    expect(os.daemonTouches).toEqual([]);
    expect(daemonGit()).toEqual([]);
  });

  it('leaves a FIFO Git state file to the member process only', async () => {
    const f = await fixture();
    const state = join(f.memberRepository, '.git', 'rebase-merge');
    await mkdir(state);
    await writeFile(join(state, 'head-name'), 'refs/heads/main\n');
    const fifo = join(state, 'onto_name');
    // A FIFO is an OS object; Node has no creator for it.
    execFileSync('/usr/bin/mkfifo', [fifo]);
    const pending = f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.memberRepository }, 'member-account', 'use');
    try {
      await vi.waitFor(() => expect(os.memberReads).toContain(fifo), { timeout: 20_000 });
      // The daemon keeps serving while the member's own read waits on its FIFO.
      expect(await f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.ownerRepository }, 'manager-account', 'manage'))
        .toMatchObject({ success: true });
      expect(os.daemonTouches).toEqual([]);
    } finally {
      // Release the member's blocked read (a writer closing the FIFO ends it).
      const writer = await originalFs.open(fifo, 'w'); await writer.close();
      await pending;
    }
    expect(os.daemonTouches).toEqual([]);
  });

  it('refuses Can use reads of another folder and forge methods before any daemon Git or state read', async () => {
    const f = await fixture();
    expect(await f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.ownerRepository }, 'member-account', 'use'))
      .toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    expect(await f.invoke(RPC_METHODS.SCM_PULL_REQUEST_LIST, { cwd: f.memberRepository }, 'member-account', 'use'))
      .toMatchObject({ errorCode: 'machine_manage_required' });
    expect(daemonGit()).toEqual([]);
    expect(os.daemonTouches).toEqual([]);
  });
});
