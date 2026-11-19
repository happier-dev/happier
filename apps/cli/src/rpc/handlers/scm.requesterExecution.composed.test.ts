import { createProjectSetupTrustClient } from '@/workspaces/projectSetup/projectSetupTrust';
import { ProjectTrustMutationRequestV1Schema, type ProjectTrustContentV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { createStorageCategoryCatalog } from '@/storage/categoryCatalog';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
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
import { AGENT_LAUNCH_TERMINAL_READY, AGENT_LAUNCH_TERMINAL_ACCEPTED, readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { runWithHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting/runtime';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { runWorkspaceEffectWorker } from '@/workspaces/activation/workspaceEffectWorker';
import type { ApiMachineClient } from '@/api/apiMachine';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN } from '@happier-dev/protocol/scm/worktrees';
import axios from 'axios';
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, type WorktreeRemovedEventV1 } from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';
import type { RpcHandlerContext } from '@/api/rpc/types';

const os = vi.hoisted(() => ({
  identity: undefined as unknown as import('node:async_hooks').AsyncLocalStorage<'member'>,
  repository: '',
  secret: '',
  daemonTouches: [] as string[],
  memberReads: [] as string[],
  direct: [] as Array<{ command: string; uid: number | undefined; member: boolean }>,
  runAs: [] as Array<{ args: readonly string[]; uid?: number }>,
  subprocessWorker: false,
  terminalLaunch: false,
}));
os.identity = new AsyncLocalStorage<'member'>();

// OS boundaries only: the member's UID (an identity scope standing in for the kernel:
// the member cannot read a daemon-private file) and RunAs. Ingress, requester
// selection, Exec launch, the Workspace effect bridge, SCM and Git stay real.
// One cold-runtime case starts the actual worker subprocess; the remaining
// routing cases use a scoped worker so the filesystem boundary can model denial.
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
    // RunAs identity is simulated; the worker always consumes its frame environment.
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: undefined, exitCode: null as number | null, signalCode: null, killed: false });
    const finish = (code: number) => { child.exitCode = code; child.stdout.end(); child.stderr.end();
      child.emit('exit', code, null); child.emit('close', code, null); };
    const terminal = os.terminalLaunch;
    queueMicrotask(() => void os.identity.run('member', async () => {
      try {
        if (terminal) child.stdout.write(AGENT_LAUNCH_TERMINAL_READY);
        const frame = await readAgentLaunchFrame(child.stdin as Readable, terminal ? 'terminal' : undefined);
        if (terminal) child.stdout.write(AGENT_LAUNCH_TERMINAL_ACCEPTED);
        os.runAs.push({ args: frame.args, uid: frame.nativeIdentity?.agentUid });
        if (frame.args[0] === 'workspace-effect') {
          if (os.subprocessWorker) {
            const run = actual.spawn(process.execPath, ['--conditions=happier-source', '--import',
              new URL('../../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url).pathname,
              new URL('../../index.ts', import.meta.url).pathname, 'workspace-effect'],
              { cwd: frame.cwd, env: frame.environment });
            child.stdin.pipe(run.stdin); run.stdout.pipe(child.stdout, { end: false }); run.stderr.pipe(child.stderr, { end: false });
            run.on('error', () => finish(1));
            run.on('close', code => finish(code ?? 1));
            return;
          }
          await runAddedHostedSession({ environment: { ...frame.environment }, workingDirectory: frame.cwd, end() {} },
            () => runWorkspaceEffectWorker([], { input: child.stdin, output: child.stdout, signal: new AbortController().signal,
              currentDirectory: () => frame.cwd }));
          finish(0); return;
        }
        // Any other framed command (a Git invocation) runs as the member.
        const run = actual.spawn(frame.executable, frame.args, { cwd: frame.cwd, env: frame.environment });
        child.stdin.pipe(run.stdin); run.stdout.pipe(child.stdout, { end: false }); run.stderr.pipe(child.stderr, { end: false });
        run.on('close', code => finish(code ?? 1));
      } catch { finish(1); }
    }));
    return child as unknown as ChildProcess;
  } };
});
afterEach(() => { os.repository = ''; os.secret = ''; os.daemonTouches.length = 0; os.memberReads.length = 0;
  os.direct.length = 0; os.runAs.length = 0; os.terminalLaunch = false; os.subprocessWorker = false; vi.restoreAllMocks(); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Owner test', '-c', 'user.email=owner@example.invalid', ...args],
  { cwd, encoding: 'utf8' });
async function repository(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'commit', '-q', '--allow-empty', '-m', 'initial');
  return path;
}

async function fixture(options: Readonly<{ projectCleanupUnavailable?: boolean;
  sourceRuntimeIsolation?: 'disabled' | 'required';
  resolveProjectRuntime?: NonNullable<Parameters<typeof registerScmHandlers>[2]>['resolveProjectRuntime'] }> = {}) {
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
  const daemonIsolation: HostAgentIsolationLaunchSnapshot = options.sourceRuntimeIsolation ? {
    enabled: options.sourceRuntimeIsolation === 'required',
    status: options.sourceRuntimeIsolation === 'required' ? { kind: 'unavailable', code: 'provisioning_unavailable' }
      : { kind: 'disabled' },
    workspaceRoots: [ownerRepository],
  } : {
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
    scmCommandRunner: createHostScmCommandRunner({ isCurrent: () => true, agentIsolation: { read: () => daemonIsolation,
      // A generic runtime fallback has no custody for this particular Session.
      ...(options.sourceRuntimeIsolation ? { resolveRequesterIdentity: async () =>
        ({ kind: 'unknown' as const, reason: 'requester_authority_unavailable' as const }) } : {}),
    } }),
  });
  const manager = createRpcHandlerManager({
    scopePrefix: machineId, scopeKind: 'machine', localMachineId: machineId,
    encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy', encryptionMode: 'plain',
    authorizeRequest: request => authorizeMachineRpcRequest(request, {
      machineId,
      resolveCustodianAccountId: async () => 'owner-account',
      resolveInstallationId: () => installationId,
      readAgentIsolation: () => daemonIsolation,
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
    ...(options.projectCleanupUnavailable ? { resolveProjectRuntime: async () => null } : {}),
    ...(options.resolveProjectRuntime ? { resolveProjectRuntime: options.resolveProjectRuntime } : {}),
    // The member binding store (native OS state) names the member who owns a member folder.
    nativeOperationRuntime: { prepareNativeOperation, readMemberFolderOwner: async (path: string) =>
      path === memberRoot || path.startsWith(`${memberRoot}/`) ? { kind: 'isolated' as const, separationRequired: true,
        requester: { serverId: home, accountId: 'member-account', machineId, installationId } } : null },
  });
  const invoke = (method: string, params: unknown, accountId: string, role: 'manage' | 'use', signal?: AbortSignal,
    localActionContext?: RpcHandlerContext['localActionContext'], sessionActionOrigin?: RpcHandlerContext['sessionActionOrigin']) =>
    manager.invokeLocal(method, params, { ...(localActionContext ? { localActionContext } : {}), rpcContext: {
      callerAuthority: 'present_user',
      ...(sessionActionOrigin ? { sessionActionOrigin } : {}),
      verifyMachineAdmissionCurrent: async () => true,
      ...(signal ? { signal } : {}),
      machineAdmission: { actorAccountId: accountId, custodianAccountId: 'owner-account', machineId, installationId,
        role, encryptionMode: 'plain' },
    } });
  os.repository = memberRepository;
  return { directory, ownerRepository, memberRoot, memberRepository, invoke, manager, plugins,
    prepareNativeOperation, home, machineId, installationId };
}

async function memberProjectRuntime(f: Awaited<ReturnType<typeof fixture>>, workspace: import('@happier-dev/protocol').WorkspaceRefV1) {
    // Account HTTP is the boundary; accepted association, definition, consent,
    // native preparation, member bridge, SCM and host event owner stay real.
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    let trust: ProjectTrustContentV1 | null = null;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/project-trust/read')) return { status: 200,
        data: trust ? { status: 'present', revision: 1, content: trust } : { status: 'absent' } };
      if (String(url).endsWith('/project-trust/mutate')) {
        trust = ProjectTrustMutationRequestV1Schema.parse(body).content;
        return { status: 200, data: { status: 'updated', revision: 1, cursor: 1 } };
      }
      return projectAccountRowsReadHttpResponse([createPlainProjectAccountRefRow(workspace)], String(url), body);
    });
    const operationRuntime = createHostActionOperationRuntime({ machineId: f.machineId,
      custodyBinding: { serverId: f.home, installationId: f.installationId },
      resolveAccountId: async () => 'owner-account', generateOperationId: () => 'member-removal' });
    const terminalSessions = createTerminalPtySessionManager({ config: readDaemonTerminalPtyConfig({}).sessionManager,
      platform: 'linux', env: {}, stopProcessTree: async () => {}, probeProcessGroup: () => 'absent',
      ptyProvider: { spawn(params) {
        // Adapt the PTY OS boundary to the fixture's real framed RunAs child.
        // The child executes the actual accepted shell command as the member scope.
        os.terminalLaunch = true;
        let child: ChildProcess;
        try {
          child = spawn(params.file, typeof params.args === 'string' ? [params.args] : params.args,
            { cwd: params.options.cwd, env: params.options.env, stdio: 'pipe' });
        } finally { os.terminalLaunch = false; }
        return { pid: child.pid ?? 3456, ownedProcessGroupId: child.pid ?? 3456,
          write: value => { child.stdin?.write(value); }, resize() {},
          kill() { child.stdin?.destroy(); },
          onData(listener) { child.stdout?.on('data', listener); return { dispose() { child.stdout?.off('data', listener); } }; },
          onExit(listener) {
            const exit = (exitCode: number | null) => listener({ exitCode });
            child.once('close', exit); return { dispose() { child.off('close', exit); } };
          } };
      } } });
    onTestFinished(() => terminalSessions.dispose());
    const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: 'owner-account' })).toString('base64url')}.signature`;
    const runtime: ProjectFiniteActionRuntime = { serverId: f.home, machineId: f.machineId, accountId: 'owner-account',
      credentials: { token, encryption: null }, serverHttpBaseUrl: 'https://home.example',
      resolveHostHomeServerIdentityId: async () => f.home, isCurrent: async () => true,
      operationRuntime, terminalSessions, nativeOperationRuntime: { prepareNativeOperation: f.prepareNativeOperation,
        prepareConnectedAccountProcessEnvironment: async () => ({
          produce: async environment => ({ environment, secretValues: [] }), dispose: async () => {},
        }) },
      workerAdmission: createProjectWorkerAdmission({ machineId: f.machineId, admissionDrain: createDaemonAdmissionDrain(),
        readMemory: () => null,
        readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'stored', metadataVersion: 1 }) }),
      resolveWorkspaceExecutionConfig: async () => null, nativeIo: { resolveTool: async () => null },
      environmentIo: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }),
      platform: 'linux', arch: 'x64', hostEnvironment: {}, successHomeDir: join(f.directory, 'setup-success'),
    };

    return { runtime, operationRuntime, async resumeCleanupReview() {
      const scope = { accountId: 'owner-account', machineId: f.machineId };
      await expect.poll(() => operationRuntime.store.get(scope, 'member-removal') !== null).toBe(true);
      const current = await operationRuntime.runner.waitForTerminal(scope, 'member-removal', undefined, { includeSetupReview: true });
      if (current?.setupReview) {
        await createProjectSetupTrustClient({ credentials: runtime.credentials, serverHttpBaseUrl: runtime.serverHttpBaseUrl })
          .approveReviewedEffect({ project: { serverId: f.home, projectId: workspace.projectKey! },
            reviewedEffectDigest: current.setupReview.reviewedEffectDigest, currentEffectDigest: current.setupReview.reviewedEffectDigest,
            approvedAtMs: 1, expectedRevision: 'absent', authority: 'present_user' });
        await operationRuntime.handlers.getV2({ operationId: 'member-removal' });
      }
    } };
}

const gitLaunches = () => os.direct.filter(launch => launch.command.endsWith('git'));
const daemonGit = () => gitLaunches().filter(launch => !launch.member);

// R126S3 / ISOLATION-REPAIR-1114 / MEMBER-SCM-READ-1114 / SEC-FORKC-1115F on a separate-users Machine.
describe.skipIf(process.platform !== 'linux')('Session-less Project SCM placement', () => {
  it('reads member Git status through the real worker process with only its launch environment', async () => {
    const f = await fixture();
    os.subprocessWorker = true;
    const response = await f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.memberRepository }, 'member-account', 'use');
    expect(response, JSON.stringify(response)).toMatchObject({ success: true, snapshot: { repo: { isRepo: true } } });
    expect(os.runAs.map(run => run.args[0])).toEqual(['workspace-effect']);
    expect(daemonGit()).toEqual([]);
  });
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

  it.each(['disabled', 'required'] as const)('uses the owner Session placement for Push commits without a managed CLI (%s)', async policy => {
    const f = await fixture({ sourceRuntimeIsolation: policy });
    const remote = join(f.directory, 'owner-remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(f.ownerRepository, 'remote', 'add', 'origin', remote);
    const services = { resolveScmHostingProviderRegistry: async () => ({
      detectRemote: () => ({ kind: 'unresolved' }), buildCompareUrl: () => ({ kind: 'unresolved' }) }) };
    const pushed = await runWithHostingProviderRuntimeServices(services as unknown as Parameters<typeof runWithHostingProviderRuntimeServices>[0],
      () => f.invoke(RPC_METHODS.SCM_REMOTE_PUSH, { cwd: f.ownerRepository, remote: 'origin', branch: 'main' }, 'owner-account', 'manage',
        undefined, undefined, { v: 1, caller: { kind: 'session', sessionId: 'build-session', starterDepth: 0, turnDepth: 0 },
          sourceTurnId: 'build-turn', callerPermissionMode: 'default', workspaceWrites: 'allow', requestId: 'approved-push' }));
    if (policy === 'required') {
      expect(pushed).toMatchObject({ errorCode: 'agent_isolation_unavailable', effectAttempted: false });
      expect(gitLaunches()).toEqual([]);
      return;
    }
    expect(pushed, JSON.stringify(pushed)).toMatchObject({ success: true });
    expect(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim())
      .toBe(git(f.ownerRepository, 'rev-parse', 'main').trim());
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

  // SCM-MEMBER-LIVE-1115: the Action surface sends the Project as a targeted machine target.
  it('reads a member repository selected as the targeted Project, as an Action does', async () => {
    const f = await fixture();
    for (const [method, input] of [
      [RPC_METHODS.SCM_STATUS_SNAPSHOT, {}],
      [RPC_METHODS.SCM_LOG_LIST, { limit: 5 }],
    ] as const) {
      const response = await f.invoke(method, { v: 1, kind: 'targeted_action_rpc', input,
        target: { kind: 'machine', machineId: 'separate-users-machine',
          project: { machineId: 'separate-users-machine', directory: f.memberRepository } } }, 'member-account', 'use');
      expect(response, JSON.stringify(response)).toMatchObject({ success: true });
      if (method === RPC_METHODS.SCM_LOG_LIST) expect(JSON.stringify(response)).toContain('initial');
    }
  });

  // MEMBER-CHILD-READS-1115 (F-A ruling): Manage keeps full access, but daemon Git never runs
  // in a member repository (its config and hooks); the read runs in that member's child.
  it('runs a Manage local repository read of a member folder in that member child, never daemon Git', async () => {
    const f = await fixture();
    for (const [method, params] of [
      [RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.memberRepository }],
      [RPC_METHODS.SCM_LOG_LIST, { cwd: f.memberRepository, limit: 5 }],
    ] as const) {
      const response = await f.invoke(method, params, 'manager-account', 'manage');
      expect(response, JSON.stringify(response)).toMatchObject({ success: true });
    }
    expect(os.runAs.map(run => [run.args[0], run.uid])).toEqual([['workspace-effect', 2401], ['workspace-effect', 2401]]);
    expect(gitLaunches().length).toBeGreaterThan(0);
    expect(daemonGit()).toEqual([]);
    expect(os.daemonTouches).toEqual([]);
  });

  it('preserves a member checkout when the original requester Project cleanup runtime is unavailable', async () => {
    const f = await fixture({ projectCleanupUnavailable: true });
    const worktree = join(f.memberRoot, 'linked-checkout');
    git(f.memberRepository, 'worktree', 'add', '--detach', worktree);
    const marker = join(worktree, 'person-work.txt');
    await writeFile(marker, 'preserve this checkout\n');
    git(worktree, 'add', 'person-work.txt');
    git(worktree, 'commit', '-q', '-m', 'checkout content');
    os.repository = f.memberRoot;
    const response = await f.invoke(RPC_METHODS.SCM_WORKTREE_REMOVE, {
      cwd: f.memberRepository, worktreePath: worktree, confirmed: true,
      authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN,
    }, 'manager-account', 'manage');
    expect(response).toMatchObject({ success: false, actionErrorCode: 'project_setup_operation_unavailable' });
    expect(await originalFs.readFile(marker, 'utf8')).toBe('preserve this checkout\n');
    expect(os.daemonTouches).toEqual([]);
    expect(daemonGit()).toEqual([]);
  });

  it('runs accepted cleanup in the member worker and publishes one removal from the original Manage operation', async () => {
    let runtime: ProjectFiniteActionRuntime | null = null;
    const f = await fixture({ resolveProjectRuntime: async () => runtime });
    const worktree = join(f.memberRoot, 'cleanup-checkout');
    const marker = join(f.memberRoot, 'cleanup-effects');
    git(f.memberRepository, 'worktree', 'add', '--detach', worktree);
    await mkdir(join(worktree, '.happier'));
    const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
    await writeFile(join(worktree, '.happier/project.json'), JSON.stringify({ version: 1, workspace: {
      teardown: [{ kind: 'command', command: `printf cleanup >> ${quote(marker)}` }],
    } }));
    git(worktree, 'add', '.happier/project.json');
    git(worktree, 'commit', '-q', '-m', 'accepted cleanup');
    const workspace = { id: 'member-checkout', serverId: f.home, machineId: f.machineId,
      rootPath: worktree, projectKey: 'accepted-project', createdAtMs: 1 };
    const prepared = await memberProjectRuntime(f, workspace);
    runtime = prepared.runtime;
    const operationRuntime = prepared.operationRuntime;
    const broker = f.plugins.registry.stableEventsBroker;
    if (!broker) throw new Error('Installed host event broker unavailable');
    const removals: WorktreeRemovedEventV1[] = [];
    const subscription = broker.subscribeHost({
      target: { eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' } },
      privileged: true, isCurrent: () => true,
      listener(event) {
        if (event.eventId === MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1 && event.payload.kind === 'worktreeRemoved')
          removals.push(event.payload.removal);
      },
    });
    onTestFinished(() => subscription.dispose());
    os.repository = f.memberRoot; os.subprocessWorker = true;
    const input = { cwd: f.memberRepository, worktreePath: worktree, confirmed: true,
      authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN };
    const pending = operationRuntime.observeExecution({ actionId: 'scm.worktree.remove', input,
      actionRequestId: 'member-removal-request', execute: async operation => ({ ok: true,
        result: await f.invoke(RPC_METHODS.SCM_WORKTREE_REMOVE, input, 'owner-account', 'manage', operation.signal,
          { ...operation, surface: 'rpc', authority: 'present_user', actionsSettings: normalizeActionsSettingsV1({
            v: 1, actions: {}, approvalWaivedSurfaces: { 'projects.prepare': ['rpc'] } }) }) }) });
    void pending.catch(() => undefined);
    await prepared.resumeCleanupReview();
    expect(await pending).toMatchObject({ ok: true, result: { success: true } });
    expect(await originalFs.readFile(marker, 'utf8')).toBe('cleanup');
    await expect(originalFs.access(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect.poll(() => removals.length).toBe(1);
    expect(removals).toEqual([{ workspace: { serverId: f.home, machineId: f.machineId,
      workspaceId: workspace.id, rootPath: worktree }, project: { serverId: f.home, projectId: 'accepted-project' },
      machineId: f.machineId, operationId: 'member-removal', worktreePath: worktree,
      outcome: 'removed', removalKind: 'deleted' }]);
    expect(operationRuntime.store.list({ accountId: 'owner-account', machineId: f.machineId }).items)
      .toMatchObject([{ operationId: 'member-removal', state: 'succeeded' }]);
    expect(os.runAs.some(run => run.args[0] === 'workspace-effect')).toBe(true);
    expect(os.daemonTouches).toEqual([]);
    expect(daemonGit()).toEqual([]);
  });

  it.each(['remove', 'retire'] as const)('keeps private managed allocation cleanup in the member OS scope for Storage %s', async removalKind => {
    const f = await fixture();
    const activeServerDir = join(f.directory, 'private-records');
    let runtime: ProjectFiniteActionRuntime | null = null;
    const owner = createManagedSessionDirectories({ activeServerDir,
      payloadPlacement: { root: f.memberRoot, agentUid: process.getuid!() },
      resolveProjectRuntime: async () => runtime,
      nativeOperationRuntime: { prepareNativeOperation: f.prepareNativeOperation,
        readMemberFolderOwner: async () => ({ kind: 'isolated', separationRequired: true,
          requester: { serverId: f.home, accountId: 'member-account', machineId: f.machineId, installationId: f.installationId } }) },
    });
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: `storage-${removalKind}` });
    await owner.bind({ allocationId: allocation.allocationId, sessionId: 'storage-session' });
    await mkdir(join(allocation.directory, '.happier'));
    await writeFile(join(allocation.directory, '.happier/project.json'), JSON.stringify({ version: 1,
      workspace: { teardown: [{ kind: 'command', command: 'true' }] } }));
    await writeFile(join(allocation.directory, 'kept'), 'private-storage-bytes');
    const workspace = { id: 'managed-storage', serverId: f.home, machineId: f.machineId,
      rootPath: allocation.directory, projectKey: 'accepted-project', createdAtMs: 1 };
    const prepared = await memberProjectRuntime(f, workspace); runtime = prepared.runtime;
    const removals: WorktreeRemovedEventV1[] = [];
    const subscription = f.plugins.registry.stableEventsBroker!.subscribeHost({
      target: { eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' } },
      privileged: true, isCurrent: () => true, listener: event => {
        if (event.eventId === MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1 && event.payload.kind === 'worktreeRemoved')
          removals.push(event.payload.removal);
      },
    });
    onTestFinished(() => subscription.dispose());
    const catalog = createStorageCategoryCatalog({ happyHomeDir: f.directory, activeServerDir,
      tempRoot: join(f.directory, 'absent-tmp'), managedSessionDirectories: owner,
      readTrackedSessions: () => [{ sessionId: 'storage-session', cwd: allocation.directory, running: false, stoppedAt: 1 }] });
    const item = (await catalog.discover()).find(item => item.path === allocation.directory);
    expect(item).toMatchObject({ categoryId: 'sessionFolders', sessionId: 'storage-session' });
    if (!item) throw new Error('Managed allocation missing from real Storage catalog');
    const adapter = await catalog.resolveAdapter(item);
    expect(await originalFs.readFile(join(allocation.directory, 'kept'), 'utf8')).toBe('private-storage-bytes');
    os.repository = f.memberRoot; os.subprocessWorker = true; os.daemonTouches = []; os.memberReads = [];
    const pending = prepared.operationRuntime.observeExecution({
      actionId: removalKind === 'remove' ? 'machines.storage.deleteNow' : 'machines.storage.trash.move',
      input: { machineId: f.machineId, items: [] }, actionRequestId: 'storage-member-removal',
      execute: async operation => {
        const context = { ...operation, authority: 'present_user' as const, surface: 'rpc' as const,
          actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: { 'projects.prepare': ['rpc'] } }) };
        const ingress: RpcHandlerContext = { signal: operation.signal, callerAuthority: 'present_user',
          machineAdmission: { actorAccountId: 'owner-account', custodianAccountId: 'owner-account', machineId: f.machineId,
            installationId: f.installationId, role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
        const removalContext = { ingress, context, operation };
        if (removalKind === 'remove') await adapter.discard({ removalContext });
        else await adapter.retire({ payloadPath: join(f.directory, 'retired-payload'), removalContext });
        return { ok: true, result: {} };
      } });
    void pending.catch(() => undefined);
    await prepared.resumeCleanupReview();
    expect(await pending).toMatchObject({ ok: true });
    await expect(originalFs.access(allocation.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    if (removalKind === 'retire') expect(await originalFs.readFile(join(f.directory, 'retired-payload', 'kept'), 'utf8')).toBe('private-storage-bytes');
    expect(os.runAs.some(run => run.args[0] === 'workspace-effect')).toBe(true);
    expect(os.daemonTouches).not.toContain(join(allocation.directory, '.happier/project.json'));
    await expect.poll(() => removals.length).toBe(1);
    expect(removals[0]).toMatchObject({ operationId: 'member-removal', workspace: {
      workspaceId: workspace.id, rootPath: allocation.directory }, project: { serverId: f.home, projectId: 'accepted-project' },
      outcome: 'removed', removalKind: removalKind === 'remove' ? 'deleted' : 'retired' });
    if (removalKind === 'retire') {
      await adapter.discard({ payloadPath: join(f.directory, 'retired-payload') });
      await expect(originalFs.access(join(f.directory, 'retired-payload'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(removals).toHaveLength(1);
    }
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

  // F-B-MEMBER-SCM-WRITES-1116: Manage is full control (owner ruling 2026-10-31), so the Git panel's
  // writes in a member folder work, run whole in that member's child; daemon Git never runs there.
  it('runs Manage Git writes of a member folder (stage, commit, branch, push) in that member child', async () => {
    const f = await fixture();
    const remote = join(f.directory, 'member-remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(f.memberRepository, 'remote', 'add', 'origin', remote);
    // The member's own repository identity (their Git config), which their commits carry.
    git(f.memberRepository, 'config', 'user.name', 'Member test');
    git(f.memberRepository, 'config', 'user.email', 'member@example.invalid');
    await writeFile(join(f.memberRepository, 'notes.txt'), 'from manage\n');
    const cwd = f.memberRepository;
    // As in the owner push case: a local bare remote matches no forge.
    const services = { resolveScmHostingProviderRegistry: async () => ({
      detectRemote: () => ({ kind: 'unresolved' }), buildCompareUrl: () => ({ kind: 'unresolved' }) }) };
    for (const [method, params] of [
      [RPC_METHODS.SCM_CHANGE_INCLUDE, { cwd, paths: ['notes.txt'] }],
      [RPC_METHODS.SCM_COMMIT_CREATE, { cwd, message: 'manage commit' }],
      [RPC_METHODS.SCM_BRANCH_CREATE, { cwd, name: 'feature', checkout: true }],
      [RPC_METHODS.SCM_REMOTE_PUSH, { cwd, remote: 'origin', branch: 'feature' }],
    ] as const) {
      const response = await runWithHostingProviderRuntimeServices(services as unknown as Parameters<typeof runWithHostingProviderRuntimeServices>[0],
        () => f.invoke(method, params, 'manager-account', 'manage'));
      expect(response, `${method} ${JSON.stringify(response)}`).toMatchObject({ success: true });
    }
    expect(git(f.memberRepository, 'log', '-1', '--format=%s|%an')).toBe('manage commit|Member test\n');
    expect(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature'], { encoding: 'utf8' }).trim())
      .toBe(git(f.memberRepository, 'rev-parse', 'HEAD').trim());
    expect(os.runAs.map(run => [run.args[0], run.uid])).toEqual(Array(4).fill(['workspace-effect', 2401]));
    expect(gitLaunches().length).toBeGreaterThan(0);
    expect(daemonGit()).toEqual([]);
    expect(os.daemonTouches).toEqual([]);
  });

  // F-B follow-up: blame is a local repository read (an Action-spec RPC); in the member child it runs
  // without the daemon's Account credentials, for Manage and for the folder's own Can use member.
  it('runs blame of a member repository in that member child for Manage and Can use', async () => {
    const f = await fixture();
    await writeFile(join(f.memberRepository, 'notes.txt'), 'line one\n');
    git(f.memberRepository, 'add', 'notes.txt');
    git(f.memberRepository, 'commit', '-q', '-m', 'notes');
    for (const [accountId, role] of [['manager-account', 'manage'], ['member-account', 'use']] as const) {
      const response = await f.invoke(RPC_METHODS.SCM_BLAME_FILE, { cwd: f.memberRepository, path: 'notes.txt' }, accountId, role);
      expect(response, JSON.stringify(response)).toMatchObject({ success: true, ranges: [expect.anything()] });
    }
    expect(os.runAs.map(run => [run.args[0], run.uid])).toEqual([['workspace-effect', 2401], ['workspace-effect', 2401]]);
    expect(daemonGit()).toEqual([]);
    expect(os.daemonTouches).toEqual([]);
  });

  // A clone would write into another person's folder with this Machine's hosting credentials; Git has no
  // ownership check for a new directory, so the SCM owner refuses it.
  it('refuses a Manage clone into a member folder with a typed credential refusal, before any Git', async () => {
    const f = await fixture();
    expect(await f.invoke(RPC_METHODS.SCM_REPOSITORY_CLONE, { destinationParentPath: f.memberRoot, destinationDirectoryName: 'clone' },
      'manager-account', 'manage'))
      .toMatchObject({ success: false, errorCode: 'BACKEND_UNAVAILABLE', actionErrorCode: 'credential_scope_denied' });
    expect(gitLaunches()).toEqual([]);
    expect(os.runAs).toEqual([]);
  });

  it('refuses a Manage clone into a member folder under a broad Project root', async () => {
    const f = await fixture();
    const targeted = (input: unknown) => ({ v: 1, kind: 'targeted_action_rpc', input,
      target: { kind: 'machine', machineId: 'separate-users-machine',
        project: { machineId: 'separate-users-machine', directory: '/' } } });
    expect(await f.invoke(RPC_METHODS.SCM_REPOSITORY_CLONE,
      targeted({ destinationParentPath: f.memberRoot, destinationDirectoryName: 'clone' }), 'manager-account', 'manage'))
      .toMatchObject({ success: false, actionErrorCode: 'credential_scope_denied' });
    expect(gitLaunches()).toEqual([]);
  });

  it('routes Manage local operations by their effective directory under a broad Project root', async () => {
    const f = await fixture();
    const targeted = (input: unknown) => ({ v: 1, kind: 'targeted_action_rpc', input,
      target: { kind: 'machine', machineId: 'separate-users-machine',
        project: { machineId: 'separate-users-machine', directory: '/' } } });
    for (const cwd of [f.memberRepository, f.memberRepository.slice(1)]) {
      const response = await f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, targeted({ cwd }), 'manager-account', 'manage');
      expect(response, JSON.stringify(response)).toMatchObject({ success: true, snapshot: { repo: { isRepo: true } } });
    }
    expect(os.runAs.map(run => [run.args[0], run.uid])).toEqual([['workspace-effect', 2401], ['workspace-effect', 2401]]);
    // Selecting a narrower Project still cannot reach a sibling in the member folder.
    const outsideProject = await f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT,
      { ...targeted({ cwd: f.memberRoot }), target: { kind: 'machine', machineId: 'separate-users-machine',
        project: { machineId: 'separate-users-machine', directory: f.memberRepository } } }, 'manager-account', 'manage');
    expect(outsideProject).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    // A broad Project does not grant Can use access outside that person's member folder.
    expect(await f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, targeted({}), 'member-account', 'use'))
      .toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    expect(await f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, targeted({ cwd: f.ownerRepository }), 'member-account', 'use'))
      .toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    const link = join(f.memberRoot, 'outside-link');
    await symlink(f.ownerRepository, link);
    expect(await f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT,
      { ...targeted({ cwd: link }), target: { kind: 'machine', machineId: 'separate-users-machine',
        project: { machineId: 'separate-users-machine', directory: link } } }, 'member-account', 'use'))
      .toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    expect(daemonGit()).toEqual([]);
    expect(os.daemonTouches).toEqual([]);
  });

  // SEC-FORKC-1116 N1: hosting work that reads no member folder runs as it does elsewhere, and repository
  // hosting work there is refused by Git's own ownership check (no second refusal).
  it('resolves a hosting address for a member Project like any other, and Git refuses a member-folder PR create', async () => {
    const f = await fixture();
    const services = { resolveScmHostingProviderRegistry: async () => ({ providers: [], getProvider: () => undefined,
      detectRemote: () => ({ kind: 'unresolved' }), buildCompareUrl: () => ({ kind: 'unresolved' }) }) };
    const resolve = (directory: string) => runWithHostingProviderRuntimeServices(
      services as unknown as Parameters<typeof runWithHostingProviderRuntimeServices>[0],
      () => f.invoke(RPC_METHODS.SCM_HOSTING_REPOSITORY_RESOLVE_ADDRESS, { v: 1, kind: 'targeted_action_rpc',
        input: { address: 'https://example.invalid/owner/repo' },
        target: { kind: 'machine', machineId: 'separate-users-machine', project: { machineId: 'separate-users-machine', directory } } },
      'manager-account', 'manage'));
    const outside = await resolve(f.ownerRepository);
    const member = await resolve(f.memberRepository);
    expect(member, JSON.stringify(member)).toEqual(outside);
    expect(JSON.stringify(member)).not.toContain('credential_scope_denied');
    // Git's different-owner hook stands in for the member owning the repository on a real host.
    vi.stubEnv('GIT_TEST_ASSUME_DIFFERENT_OWNER', '1');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const created = await f.invoke(RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE, { cwd: f.memberRepository, base: 'main', title: 'x' },
      'manager-account', 'manage');
    expect(created, JSON.stringify(created)).toMatchObject({ success: false, errorCode: 'BACKEND_UNAVAILABLE',
      error: expect.stringContaining('git_dubious_ownership') });
    expect(os.runAs).toEqual([]);
  });

  it('refuses a Git write in a member folder for a Team member without Manage, before any Git', async () => {
    const f = await fixture();
    await writeFile(join(f.memberRepository, 'notes.txt'), 'from use\n');
    for (const accountId of ['member-account', 'team-member-account']) {
      expect(await f.invoke(RPC_METHODS.SCM_COMMIT_CREATE, { cwd: f.memberRepository, message: 'refused' }, accountId, 'use'))
        .toMatchObject({ errorCode: 'machine_manage_required' });
    }
    expect(git(f.memberRepository, 'log', '-1', '--format=%s')).toBe('initial\n');
    expect(gitLaunches()).toEqual([]);
    expect(os.runAs).toEqual([]);
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
