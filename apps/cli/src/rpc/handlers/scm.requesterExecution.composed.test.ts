import { createProjectSetupTrustClient } from '@/workspaces/projectSetup/projectSetupTrust';
import { ProjectTrustMutationRequestV1Schema, type ProjectTrustContentV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { createStorageCategoryCatalog } from '@/storage/categoryCatalog';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { invokeHostReviewedChildV1, settleActionOutput, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createRpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createHostScmCommandRunner } from '@/scm/runtime';
import { createScmBackendRegistry } from '@/scm/registry';
import { createScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { removeTempDir } from '@/testkit/fs/tempDir';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { configuration } from '@/configuration';
import type { HostAgentIsolationLaunchSnapshot, HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { AGENT_LAUNCH_TERMINAL_READY, AGENT_LAUNCH_TERMINAL_ACCEPTED, readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { runAgentIsolationMemberReadinessBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { runWithHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting/runtime';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { runWorkspaceEffectWorker } from '@/workspaces/activation/workspaceEffectWorker';
import type { ApiMachineClient } from '@/api/apiMachine';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN } from '@happier-dev/protocol/scm/worktrees';
import { REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN } from '@happier-dev/protocol/scm/repositoryProvisioning';
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
import { ExternalActionExecutionAuthorizationV1Schema, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { retainVerifiedExternalActionRequester } from '@/daemon/agentIsolation/verifiedExternalActionRequester';
import { createCliMachineActionTransport } from '@/session/actions/cliActionDeps/machineTransport';
import { createCliSessionActionTransport } from '@/session/transport/cliActionTransport';
import { createSessionBoundScmAction } from '@/scm/actions/sessionBoundAction';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { requesterActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { startGitSmartHttpFixture } from '@/testkit/scm/gitSmartHttpFixture';
import { prepareRequesterNativeOperation } from '@/daemon/agentIsolation/prepareNativeOperation';
import { createActionExecuteFailureError, projectActionFailureForAgentV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createBackgroundServiceProcessFrameDecoder, encodeBackgroundServiceProcessFrame, parseBackgroundServiceProcessMessage } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessProtocol';
import { createBackgroundServiceProcessServiceClient, type BackgroundServiceProcessBridgeValue } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessBridge';
import type { WorkspaceEffectServices } from '@/workspaces/activation/workspaceEffectWorker';

const os = vi.hoisted(() => ({
  identity: undefined as unknown as import('node:async_hooks').AsyncLocalStorage<'member'>,
  repository: '',
  secret: '',
  daemonTouches: [] as string[],
  memberReads: [] as string[],
  direct: [] as Array<{ command: string; uid: number | undefined; member: boolean }>,
  runAs: [] as Array<{ args: readonly string[]; uid?: number }>,
  memberHomes: new Map<string, { path: string; uid: number }>(),
  subprocessWorker: false,
  terminalLaunch: false,
  workerFailure: undefined as Error | undefined,
}));
os.identity = new AsyncLocalStorage<'member'>();

// OS boundaries only: the member's UID (an identity scope standing in for the kernel:
// the member cannot read a daemon-private file) and RunAs. Ingress, requester
// selection, Exec launch, the Workspace effect bridge, SCM and Git stay real.
// One cold-runtime case starts the actual worker subprocess; the remaining
// routing cases use a scoped worker so the filesystem boundary can model denial.
// The suite patches the actual builtin for both source and plugin imports. The
// common Windows asset mock copies the methods before these UID guards are installed.
vi.unmock('node:fs/promises');
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
vi.mock('@happier-dev/cli-common/process', async importOriginal => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...request: Parameters<typeof actual.execFileWithDeadline>) => {
    const nativeHome = os.memberHomes.get(request[1][2]);
    return await runAgentIsolationMemberReadinessBoundary({ request, nativeHome }) ?? actual.execFileWithDeadline(...request);
  } };
});
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
        // The native launch shim installs the selected OS user's HOME after reading the frame.
        const environment = { ...frame.environment, ...(frame.nativeIdentity ? { HOME: frame.nativeIdentity.home } : {}) };
        if (frame.args[0] === 'workspace-effect') {
          const failure = os.workerFailure;
          if (failure) {
            // Substitute the OS child reply, retaining the real private service encoder/decoder.
            const decoder = createBackgroundServiceProcessFrameDecoder();
            let client: ReturnType<typeof createBackgroundServiceProcessServiceClient<Pick<WorkspaceEffectServices, 'fail'>>> | undefined;
            child.stdin.on('data', (chunk: Buffer) => {
              for (const raw of decoder.push(chunk)) {
                const message = parseBackgroundServiceProcessMessage(raw);
                if (message.kind === 'services') client?.receive(message.message);
                else if (message.kind === 'run') {
                  client = createBackgroundServiceProcessServiceClient<Pick<WorkspaceEffectServices, 'fail'>>({
                    description: message.services as BackgroundServiceProcessBridgeValue,
                    send: reply => { child.stdout.write(encodeBackgroundServiceProcessFrame({ kind: 'services', message: reply })); },
                  });
                  void client.services.fail(failure, false).then(() => {
                    child.stdout.write(encodeBackgroundServiceProcessFrame({ kind: 'settled', id: message.id }));
                    finish(0);
                  });
                }
              }
            });
            return;
          }
          if (os.subprocessWorker) {
            const run = actual.spawn(process.execPath, ['--conditions=happier-source', '--import',
              new URL('../../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url).pathname,
              new URL('../../index.ts', import.meta.url).pathname, 'workspace-effect'],
              { cwd: frame.cwd, env: environment });
            child.stdin.pipe(run.stdin); run.stdout.pipe(child.stdout, { end: false }); run.stderr.pipe(child.stderr, { end: false });
            run.on('error', () => finish(1));
            run.on('close', code => finish(code ?? 1));
            return;
          }
          await runAddedHostedSession({ environment, workingDirectory: frame.cwd, end() {} },
            () => runWorkspaceEffectWorker([], { input: child.stdin, output: child.stdout, signal: new AbortController().signal,
              currentDirectory: () => frame.cwd }));
          finish(0); return;
        }
        // Any other framed command (a Git invocation) runs as the member.
        const run = actual.spawn(frame.executable, frame.args, { cwd: frame.cwd, env: environment });
        child.stdin.pipe(run.stdin); run.stdout.pipe(child.stdout, { end: false }); run.stderr.pipe(child.stderr, { end: false });
        run.on('close', code => finish(code ?? 1));
      } catch { finish(1); }
    }));
    return child as unknown as ChildProcess;
  } };
});
afterEach(() => { os.repository = ''; os.secret = ''; os.daemonTouches.length = 0; os.memberReads.length = 0;
  os.direct.length = 0; os.runAs.length = 0; os.memberHomes.clear(); os.terminalLaunch = false; os.subprocessWorker = false;
  os.workerFailure = undefined; vi.restoreAllMocks(); });

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
  /** The member has no member binding on this Machine, so no member child can run their work. */
  memberIdentityUnavailable?: true;
  /** The native member binding store rejects with its existing typed failure. */
  memberReadFailure?: Error;
  /** Home's answer for this person's Machine grant (false: withdrawn). */
  admissionCurrent?: boolean;
  /** The hosting provider plugin is installed, and each person's own connected accounts by Account id. */
  hostingAccounts?: ReadonlyMap<string, NonNullable<ReturnType<typeof createConnectedAccountPurposeBindingOwner>>>;
  resolveProjectRuntime?: NonNullable<Parameters<typeof registerScmHandlers>[2]>['resolveProjectRuntime'] }> = {}) {
  const plugins = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.scm.backend.git', ...(options.hostingAccounts ? ['happier.scm.forge.github'] : [])] } });
  onTestFinished(() => plugins.dispose());
  const directory = await mkdtemp(join(tmpdir(), 'happier-scm-requester-'));
  onTestFinished(() => removeTempDir(directory));
  const ownerRepository = await repository(directory, 'owner-project');
  const memberRoot = join(directory, 'member-folder');
  const memberRepository = await repository(memberRoot, 'member-project');
  // A second Can use member of this Machine, with their own member folder.
  const otherMemberRoot = join(directory, 'other-member-folder');
  const otherMemberRepository = await repository(otherMemberRoot, 'other-project');
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
  const prepareNativeOperation = (async (request: Parameters<ApiMachineClient['prepareNativeOperation']>[0]) => {
    if (options.memberReadFailure) return prepareRequesterNativeOperation(request, {
      machineId, installationId, homeServerIdentityId: home,
      machine: { read: () => daemonIsolation, readMember: async () => { throw options.memberReadFailure; } },
    });
    // Stand-in for the requester material owner (Home's Account store): the requester's OWN accounts, by admitted custody.
    const requesterAccounts = request.requesterAccount ? options.hostingAccounts?.get(request.requesterAccount.accountId) : undefined;
    if (request.requesterIdentity.kind !== 'isolated') throw Object.assign(new Error('not a member'), { code: 'agent_isolation_unavailable' });
    if (options.memberIdentityUnavailable) return { requesterIdentity: request.requesterIdentity, workingDirectory: memberRoot,
      agentIsolation: { requesterIdentity: request.requesterIdentity, read: () => daemonIsolation }, dispose: async () => {} };
    const other = request.requesterIdentity.requester.accountId === 'other-account';
    const workspaceRoot = other ? otherMemberRoot : memberRoot;
    const agentUid = other ? 2402 : 2401;
    const memberIdentity = { ...deriveAgentIsolationMemberIdentity({ ...request.requesterIdentity, homeServerIdentityId: home }),
      workspaceRoot, home: memberHome, agentUid, agentGid: agentUid };
    os.memberHomes.set(memberIdentity.username, { path: memberHome, uid: agentUid });
    const snapshot = { ...daemonIsolation, workspaceRoots: [workspaceRoot], memberIdentity, localTransport: { agentUid, agentGid: agentUid },
      launch: { managedHappierBinaryPath: '/opt/happier/cli/current/happier', runtimeHome: join(memberHome, 'runtime'),
        environment: {}, selectedEnvironmentKeys: [], selectedMaterials: [] } };
    return { requesterIdentity: request.requesterIdentity, memberIdentity, workingDirectory: workspaceRoot,
      ...(requesterAccounts ? { connectedAccounts: requesterAccounts } : {}),
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
  const authorizeRequest = vi.fn((request: Parameters<typeof authorizeMachineRpcRequest>[0]) =>
    authorizeMachineRpcRequest(request, {
      machineId,
      resolveCustodianAccountId: async () => 'owner-account',
      resolveInstallationId: () => installationId,
      readAgentIsolation: () => daemonIsolation,
      resolveHomeServerIdentityId: async () => home,
      // Authentication/currentness are the Home network boundary.
      verifyMachineAdmission: async () => options.admissionCurrent ?? true,
    }));
  const manager = createRpcHandlerManager({
    scopePrefix: machineId, scopeKind: 'machine', localMachineId: machineId,
    encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy', encryptionMode: 'plain',
    authorizeRequest,
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
    nativeOperationRuntime: { prepareNativeOperation, readMemberFolderOwner: async (path: string) => {
      const owner = [[memberRoot, 'member-account'], [otherMemberRoot, 'other-account']]
        .find(([root]) => path === root || path.startsWith(`${root}/`))?.[1];
      return owner ? { kind: 'isolated' as const, separationRequired: true,
        requester: { serverId: home, accountId: owner, machineId, installationId } } : null;
    } },
  });
  const invoke = (method: string, params: unknown, accountId: string, role: 'manage' | 'use', signal?: AbortSignal,
    localActionContext?: RpcHandlerContext['localActionContext'], sessionActionOrigin?: RpcHandlerContext['sessionActionOrigin'],
    callerInputAuthorization?: ExternalActionExecutionAuthorizationV1) =>
    manager.invokeLocal(method, params, { ...(localActionContext ? { localActionContext } : {}), ...(signal ? { signal } : {}), rpcContext: {
      callerAuthority: 'present_user',
      ...(callerInputAuthorization ? { callerInputAuthorization } : {}),
      ...(sessionActionOrigin ? { sessionActionOrigin } : {}),
      verifyMachineAdmissionCurrent: async () => true,
      machineAdmission: { actorAccountId: accountId, custodianAccountId: 'owner-account', machineId, installationId,
        role, encryptionMode: 'plain' },
    } });
  os.repository = memberRepository;
  return { directory, ownerRepository, memberRoot, memberRepository, otherMemberRoot, otherMemberRepository, invoke, manager, plugins,
    authorizeRequest, prepareNativeOperation, home, machineId, installationId };
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
        const priorDaemonTouches = os.daemonTouches.length;
        await operationRuntime.handlers.getV2({ operationId: 'member-removal', refreshSetupReview: true });
        expect(os.daemonTouches.slice(priorDaemonTouches)).toEqual([]);
      }
    } };
}

const gitLaunches = () => os.direct.filter(launch => launch.command.endsWith('git'));
const daemonGit = () => gitLaunches().filter(launch => !launch.member);
const head = (cwd: string) => git(cwd, 'rev-parse', 'HEAD').trim();
const commitFile = async (cwd: string, path: string, content: string, message: string) => {
  await writeFile(join(cwd, path), content);
  git(cwd, 'add', path);
  git(cwd, 'commit', '-q', '-m', message);
};

// Every own-folder local Git family this lane opens to a Can use member, one request each,
// for the refusal cases (another person's repository, another member's folder, a withdrawn grant).
const ownFolderGitRequests = (cwd: string) => [
  [RPC_METHODS.SCM_COMMIT_UNDO_LAST, { cwd, expectedHeadOid: 'a'.repeat(40) }],
  [RPC_METHODS.SCM_COMMIT_BACKOUT, { cwd, commit: 'HEAD' }],
  [RPC_METHODS.SCM_BRANCH_MERGE, { cwd, sourceRef: 'main' }],
  [RPC_METHODS.SCM_BRANCH_REBASE, { cwd, sourceRef: 'main' }],
  [RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE, { cwd, operation: 'merge' }],
  [RPC_METHODS.SCM_BRANCH_OPERATION_SKIP, { cwd, operation: 'rebase' }],
  [RPC_METHODS.SCM_BRANCH_OPERATION_ABORT, { cwd, operation: 'merge' }],
  [RPC_METHODS.SCM_CONFLICT_ACCEPT_SIDE, { cwd, path: 'notes.txt', side: 'ours' }],
  [RPC_METHODS.SCM_CONFLICT_MARK_RESOLVED, { cwd, paths: ['notes.txt'] }],
  [RPC_METHODS.SCM_WORKTREE_PRUNE, { cwd }],
  [RPC_METHODS.SCM_REMOTE_ADD, { cwd, name: 'mine', fetchUrl: 'https://example.invalid/repo.git' }],
  [RPC_METHODS.SCM_REMOTE_SET_URL, { cwd, name: 'origin', fetchUrl: 'https://example.invalid/other.git' }],
  [RPC_METHODS.SCM_REMOTE_REMOVE, { cwd, name: 'origin' }],
  [RPC_METHODS.SCM_REPOSITORY_INIT, { cwd }],
  [RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK, { cwd, confirmed: true, confirmationToken: REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN }],
] as const;

const GITHUB_PLUGIN = 'happier.scm.forge.github';
/** Real purpose-binding owner; only persistence, Account metadata and the credential producer are stand-ins. */
function hostingAccountOwner(accountId: string, token: string, materialized: string[]) {
  const account = { service: { pluginId: GITHUB_PLUGIN, localId: 'github-account' }, accountId };
  let bindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [{
    purpose: { consumer: { pluginId: GITHUB_PLUGIN, localId: 'github' }, purpose: 'authentication' },
    target: { kind: 'account', account } }] };
  return createConnectedAccountPurposeBindingOwner({
    store: { read: async () => bindings, update: async mutate => (bindings = mutate(bindings)), subscribe: () => ({ dispose() {} }) },
    selectTarget: async () => { throw new Error('No Account selection in this flow'); },
    resolveTarget: async () => ({ displayName: accountId, account }),
    assertTargetAccountMaterializable: async () => undefined,
    materializeAccount: async () => { materialized.push(accountId); return { kind: 'httpHeaders', headers: { authorization: `Bearer ${token}` } }; },
    projectTargetAccounts: async () => ({ status: 'complete', accounts: [{ account, displayName: accountId, state: 'connected',
      connectedAccountOrigins: ['https://github.com'], connectedAccountBases: ['https://github.com'] }] }),
  });
}
/** Home's admitted requester custody, reduced to the host-local facet the SCM ingress reads. */
function admittedCustody(f: Readonly<{ home: string; machineId: string; installationId: string }>, accountId: string) {
  const projection = {};
  Object.defineProperty(projection, requesterActionContext, { value: { accountId, savedSecretOperationContext: {} }, enumerable: false });
  // Boundary fixture: the signed Home authorization is not reconstructed here.
  return { binding: { accountId, custodianAccountId: 'owner-account', serverIdentityId: f.home, machineId: f.machineId,
    installationId: f.installationId, requestId: `custody-${accountId}` },
  requesterAccountProjection: projection } as unknown as ExternalActionExecutionAuthorizationV1;
}

// Every network and hosting family a person runs with their own accounts (hostingCredentials), one request each.
const ownFolderCredentialRequests = (folder: string, cwd: string) => [
  [RPC_METHODS.SCM_REMOTE_FETCH, { cwd, remote: 'origin' }],
  [RPC_METHODS.SCM_REMOTE_PULL, { cwd, remote: 'origin' }],
  [RPC_METHODS.SCM_REMOTE_PUSH, { cwd, remote: 'origin', branch: 'main' }],
  [RPC_METHODS.SCM_REMOTE_PUBLISH, { cwd, remote: 'origin', branch: 'main' }],
  [RPC_METHODS.SCM_PULL_REQUEST_LIST, { cwd }],
  [RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE, { cwd, base: 'main', title: 'x' }],
  [RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH, { cwd, providerKind: 'github', owner: 'member', repositoryName: 'project', visibility: 'private' }],
  [RPC_METHODS.SCM_REPOSITORY_CLONE, { provider: { id: 'github:github.com', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com',
    urlSafety: { allowedSchemes: ['https:'] } }, repository: { nameWithOwner: 'member/project', webUrl: 'https://github.com/member/project',
    cloneUrl: 'https://github.com/member/project.git', visibility: 'private', defaultBranch: 'main' },
  destinationParentPath: folder, destinationDirectoryName: 'clone', protocol: 'https', confirmed: true, authorizationToken: 'clone-repository' }],
] as const;

// R126S3 / ISOLATION-REPAIR-1114 / MEMBER-SCM-READ-1114 / SEC-FORKC-1115F on a separate-users Machine.
describe.skipIf(process.platform !== 'linux')('Session-less Project SCM placement', () => {
  it.each(['native', 'child'] as const)('retains a %s refusal through real guest SCM dispatch', async origin => {
    const refusal = createActionExecuteFailureError({ ok: false, errorCode: 'credential_scope_denied', error: 'Refused',
      requestId: 'guest-scm-native-refusal', effectAttempted: false,
      failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: 'machine_manage_required', httpStatus: 403 } });
    const f = await fixture(origin === 'native' ? { memberReadFailure: Object.assign(refusal, { code: 'workspace_effect_outcome_unknown' }) } : {});
    if (origin === 'child') os.workerFailure = new PluginError({ code: refusal.errorCode, message: refusal.error,
      details: { requestId: refusal.requestId! }, effectAttempted: false, failureCause: refusal.failureCause });
    const response = await f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.memberRepository }, 'member-account', 'use');
    expect(response).toMatchObject({ success: false, errorCode: 'BACKEND_UNAVAILABLE', actionErrorCode: refusal.errorCode,
      requestId: refusal.requestId, effectAttempted: false, failureCause: refusal.failureCause });
    const settled = settleActionOutput('scm.status.snapshot', { ok: true, result: response });
    expect(settled.ok).toBe(true);
    if (!settled.ok) throw new Error('Native refusal did not satisfy its declared Action output');
    const failure = readActionFailureEnvelope(settled.result, { treatReturnedErrorEnvelopeAsFailure: true });
    expect(failure).not.toBeNull();
    if (!failure) throw new Error('Native refusal was not readable by the Action presenter');
    expect(projectActionFailureForAgentV1(failure)).toMatchObject({
      requestId: refusal.requestId, effectAttempted: false, failureCause: refusal.failureCause,
    });
    expect(await f.invoke(RPC_METHODS.SCM_WORKSPACE_WATCH, { directory: f.memberRepository }, 'member-account', 'use'))
      .toMatchObject({ status: 'unavailable', reason: { code: refusal.errorCode,
        requestId: refusal.requestId, effectAttempted: false, failureCause: refusal.failureCause } });
    expect(daemonGit()).toEqual([]);
    if (origin === 'native') expect(os.runAs).toEqual([]);
  });

  it('reads member Git status through the real worker process with only its launch environment', async () => {
    const f = await fixture();
    os.subprocessWorker = true;
    const response = await f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.memberRepository }, 'member-account', 'use');
    expect(response, JSON.stringify(response)).toMatchObject({ success: true, snapshot: { repo: { isRepo: true } } });
    expect(os.runAs.map(run => run.args[0])).toEqual(['workspace-effect']);
    expect(daemonGit()).toEqual([]);
  });
  it('observes a Use member’s checkout through requester custody', async () => {
    const f = await fixture();
    const directory = f.memberRepository;
    expect(await f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: directory }, 'member-account', 'use'))
      .toMatchObject({ success: true, snapshot: { repo: { isRepo: true } } });
    const controller = new AbortController();
    const watch = (input: Readonly<{ directory: string; observationOnly?: true; sinceRevision?: number }>) =>
      f.invoke(RPC_METHODS.SCM_WORKSPACE_WATCH, input, 'member-account', 'use', controller.signal);
    const observation = watch({ directory, observationOnly: true });
    try {
      const ready = await watch({ directory });
      expect(ready, JSON.stringify(ready)).toMatchObject({ status: 'ready', revision: expect.any(Number) });
      const changed = watch({ directory, sinceRevision: (ready as { revision: number }).revision });
      await writeFile(join(directory, 'member-change.txt'), 'change from outside Happier');
      expect(await changed).toMatchObject({ status: 'changed' });
      expect(await watch({ directory: f.ownerRepository }))
        .toMatchObject({ status: 'unavailable', reason: { code: 'path_not_allowed' } });
    } finally {
      controller.abort();
      expect(await observation).toMatchObject({ status: 'cancelled' });
    }
    expect(os.runAs.filter(run => run.args[0] === 'workspace-effect')).toHaveLength(3);
    expect(os.daemonTouches).toEqual([]);
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

  it('uses the Machine isolation decision for an owner Session opening a pull request', async () => {
    const origin = { v: 1, caller: { kind: 'session', sessionId: 'build-session', starterDepth: 0, turnDepth: 0 },
      sourceTurnId: 'build-turn', callerPermissionMode: 'default', workspaceWrites: 'allow', requestId: 'approved-pr' } as const;
    const direct = await fixture({ sourceRuntimeIsolation: 'disabled' });
    git(direct.ownerRepository, 'remote', 'add', 'origin', 'https://github.com/example/fixture.git');
    const registry = createScmHostingProviderRegistry({ providers: [] });
    const open = (f: Awaited<ReturnType<typeof fixture>>, accountId: string, role: 'manage' | 'use') =>
      runWithHostingProviderRuntimeServices({ resolveScmHostingProviderRegistry: async () => registry },
        () => f.invoke(RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE, { cwd: f.ownerRepository, base: 'main', title: 'Fixture change' },
          accountId, role, undefined, undefined, origin));

    // The admitted request reaches the real Git backend and resolves the empty forge inventory.
    expect(await open(direct, 'owner-account', 'manage')).toMatchObject({ success: false, errorCode: 'FEATURE_UNSUPPORTED' });
    expect(daemonGit().length).toBeGreaterThan(0);
    // Isolation off: a guest's own source control runs there like their Agent (owner ruling 2026-11-23 ~15:10Z).
    for (const role of ['manage', 'use'] as const) {
      const before = daemonGit().length;
      expect(await open(direct, 'member-account', role)).toMatchObject({ success: false, errorCode: 'FEATURE_UNSUPPORTED' });
      expect(daemonGit().length).toBeGreaterThan(before);
    }
    const separatedGuest = await fixture({ sourceRuntimeIsolation: 'required' });
    expect(await open(separatedGuest, 'member-account', 'use'))
      .toMatchObject({ errorCode: 'machine_manage_required', effectAttempted: false });

    const separated = await fixture({ sourceRuntimeIsolation: 'required' });
    expect(await open(separated, 'owner-account', 'manage'))
      .toMatchObject({ errorCode: 'agent_isolation_unavailable', effectAttempted: false });
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

  it.each(['enabled', 'disabled'] as const)('keeps a reviewed Can use child’s repository reads in its own workspace with isolation %s', async isolation => {
    const f = await fixture({ admissionCurrent: false,
      ...(isolation === 'disabled' ? { sourceRuntimeIsolation: 'disabled', memberIdentityUnavailable: true } : {}) });
    const ownRepository = isolation === 'enabled' ? f.memberRepository : await repository(f.directory, 'guest-project');
    const sharedRepository = await repository(f.directory, 'team-project');
    const target = { kind: 'machine', machineId: f.machineId } as const;
    const accountId = 'member-account';
    const requestId = 'review-start';
    const admitted = ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1,
      token: 'admitted-review-start',
      binding: {
        accountId, custodianAccountId: 'owner-account', admittedMachineRole: 'use',
        authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
        serverIdentityId: f.home, machineId: f.machineId, installationId: f.installationId,
        actionId: 'action.invoke', requestId, requestEnvelopeDigest: 'a'.repeat(43), target,
      },
    });
    // Home is the network boundary. Preserve its admitted root and currentness.
    Object.defineProperty(admitted, 'requesterHttpProjection', {
      value: Object.freeze({
        accountId, serverId: f.home, serverIdentityId: f.home, serverHttpBaseUrl: 'https://home.test',
        accountEncryptionMode: 'plain', isCurrent: async () => true, createRequestHeaders: async () => null,
      }),
    });
    const action = { pluginId: 'happier.triage', localId: 'sessions/start-pull-request-review-v1' };
    const reviewed = await invokeHostReviewedChildV1<{ context: ActionExecutorContext }>({
      parent: { actionId: 'action.invoke', input: { action, input: {} } },
      context: {
        surface: 'plugin', authority: 'present_user', runtimeAccountId: accountId,
        actionRequestId: requestId, externalActionTarget: target,
        externalActionExecutionAuthorization: retainVerifiedExternalActionRequester({ authorization: admitted, isCurrent: async () => true }),
      },
      child: { action, role: 'action_invoke', input: {} },
      admittedReview: { action, role: 'action_invoke', surface: 'plugin' },
      execute: async (_input, context) => ({ context }),
    });
    if (!('context' in reviewed)) throw new Error(`Expected reviewed child: ${JSON.stringify(reviewed)}`);
    const ownSession = 'c111111111111111111111111';
    const foreignSession = 'c222222222222222222222222';
    const sharedSession = 'c333333333333333333333333';
    let sharedAccess: 'edit' | 'view' | 'none' = 'edit';
    const token = 'reviewed-guest-fixture';
    const params = {
      token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain' as const, ctx: null,
      machineActionDirectTargetTransport: { machineId: f.machineId, invoke: f.manager.invokeLocal.bind(f.manager) },
    };
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      const sessionId = path.slice('/v2/sessions/'.length);
      if (path.startsWith('/v2/sessions/') && [ownSession, foreignSession, sharedSession].includes(sessionId)) {
        const own = sessionId === ownSession;
        const shared = sessionId === sharedSession;
        const grant = shared ? sharedAccess : 'view';
        if (grant === 'none') return { status: 404, data: { error: 'Session not found' } };
        return { status: 200, data: { session: createSessionRecordFixture({
          id: sessionId, encryptionMode: 'plain', machineId: f.machineId,
          metadata: JSON.stringify({ path: own ? ownRepository : shared ? sharedRepository : f.ownerRepository }),
          effectiveAccess: {
            v: 1, level: own ? 'owner' : grant,
            sources: own ? [{ kind: 'owner' }] : [{ kind: 'team', teamId: 'review-team', requiredByTeamPolicy: false }],
            capabilities: projectSessionAccessCapabilitiesV1({ owner: own,
              grants: own ? [] : [{ accessLevel: grant, canApprovePermissions: false }] }),
          },
        }) } };
      }
      throw new Error(`Unexpected Home request ${path}`);
    });
    const machine = createCliMachineActionTransport(params);
    const common = {
      callMachineAction: machine.callMachineAction,
      normalizeStringValue: (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null,
      resolveServerRequestHeaders: () => ({ Authorization: `Bearer ${token}` }),
    };
    const session = createCliSessionActionTransport(params, { ...common,
      readCurrentSessionMetadata: async () => null,
      readServerFeaturesSnapshot: async () => undefined,
      resolveCurrentSessionValue: async () => null,
      withProjectHome: run => run(),
    });
    const execute = createSessionBoundScmAction(params, { ...common, ...session,
      isMachineActionServerScopeCurrent: machine.isMachineActionServerScopeCurrent,
      invokeSessionPullRequestBinding: async () => { throw new Error('Unexpected Session binding'); },
    });
    const status = (sessionId: string, cwd?: string) => execute({
      actionId: 'scm.status.snapshot', input: { detail: 'facts', ...(cwd ? { cwd } : {}) },
      context: {
        ...reviewed.context, defaultSessionId: sessionId, externalActionTarget: undefined,
        ...(sessionId === sharedSession ? { expectedSessionAddress: { serverId: f.home, sessionId } } : {}),
      },
      executeCanonicalAction: async () => { throw new Error('Unexpected Action'); },
    });
    const response = await status(ownSession);
    expect(response, JSON.stringify(response)).toMatchObject({ success: true, snapshot: { repo: { isRepo: true } } });
    if (isolation === 'enabled') {
      expect(daemonGit()).toEqual([]);
      expect(os.daemonTouches).toEqual([]);
      expect(os.runAs).toEqual(expect.arrayContaining([expect.objectContaining({ uid: 2401 })]));
    } else {
      expect(daemonGit().length).toBeGreaterThan(0);
      const sharedResponse = await status(sharedSession);
      expect(sharedResponse, JSON.stringify(sharedResponse)).toMatchObject({ success: true, snapshot: { repo: { isRepo: true } } });
    }
    const readCount = gitLaunches().length;
    expect(await status(ownSession, f.ownerRepository)).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    expect(await status(ownSession, f.otherMemberRepository)).toMatchObject({ success: false,
      errorCode: isolation === 'enabled' ? 'INVALID_PATH' : 'BACKEND_UNAVAILABLE' });
    if (isolation === 'enabled') {
      expect(await status(foreignSession)).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    } else {
      expect(await status(sharedSession, f.ownerRepository)).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
      const escapeLink = join(sharedRepository, 'outside');
      await symlink(ownRepository, escapeLink);
      expect(await status(sharedSession, escapeLink)).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
      expect(await status(sharedSession, `${sharedRepository}/../${basename(ownRepository)}`))
        .toMatchObject({ success: false, errorCode: 'INVALID_PATH' });

      sharedAccess = 'view';
      for (const sessionId of [foreignSession, sharedSession]) {
        f.authorizeRequest.mockClear();
        await expect(status(sessionId)).rejects.toMatchObject({
          rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN, effectAttempted: false,
        });
        const admission = f.authorizeRequest.mock.results.at(-1);
        expect(admission?.type).toBe('return');
        await expect(admission?.value).resolves.toMatchObject({
          ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN, admissionPredicate: 'machine_admission',
        });
      }

      sharedAccess = 'none';
      f.authorizeRequest.mockClear();
      expect(await status(sharedSession)).toMatchObject({ ok: false, errorCode: 'session_not_found' });
      expect(f.authorizeRequest).not.toHaveBeenCalled();
    }
    expect(gitLaunches()).toHaveLength(readCount);
    expect([...new Set(os.runAs.map(run => run.uid))]).toEqual(isolation === 'enabled' ? [2401] : []);
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

  it('refuses a FIFO in the member without blocking the daemon', async () => {
    const f = await fixture();
    const state = join(f.memberRepository, '.git', 'rebase-merge');
    await mkdir(state);
    await writeFile(join(state, 'head-name'), 'refs/heads/main\n');
    const fifo = join(state, 'onto_name');
    // A FIFO is an OS object; Node has no creator for it.
    execFileSync('/usr/bin/mkfifo', [fifo]);
    onTestFinished(async () => {
      // Release a regressed blocking reader without waiting for a reader ourselves.
      try {
        const writer = await originalFs.open(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
        await writer.close();
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code !== 'ENXIO' && code !== 'ENOENT') throw error;
      }
    });
    const pending = f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.memberRepository }, 'member-account', 'use');
    await vi.waitFor(() => expect(os.memberReads).toContain(fifo), { timeout: 20_000 });
    const ownerStatus = f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.ownerRepository }, 'manager-account', 'manage');
    await expect(pending).resolves.toMatchObject({ success: false, errorCode: 'COMMAND_FAILED' });
    await expect(ownerStatus).resolves.toMatchObject({ success: true });
    expect(os.daemonTouches).toEqual([]);
  });

  // F-B-MEMBER-SCM-WRITES-1116: Manage is full control (owner ruling 2026-10-31), so the Git panel's
  // writes in a member folder work, run whole in that member's child; daemon Git never runs there.
  it('runs Manage Git writes of a member folder (stage, commit, branch) in that member child, and refuses its push', async () => {
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
    ] as const) {
      const response = await runWithHostingProviderRuntimeServices(services as unknown as Parameters<typeof runWithHostingProviderRuntimeServices>[0],
        () => f.invoke(method, params, 'manager-account', 'manage'));
      expect(response, `${method} ${JSON.stringify(response)}`).toMatchObject({ success: true });
    }
    expect(git(f.memberRepository, 'log', '-1', '--format=%s|%an')).toBe('manage commit|Member test\n');
    // Network work there would authenticate as someone: only the folder's member may (SEC-RU2-1126B N2).
    expect(await f.invoke(RPC_METHODS.SCM_REMOTE_PUSH, { cwd, remote: 'origin', branch: 'feature' }, 'manager-account', 'manage'))
      .toMatchObject({ success: false, actionErrorCode: 'credential_scope_denied' });
    expect(() => execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', 'feature'], { encoding: 'utf8' })).toThrow();
    expect(os.runAs.map(run => [run.args[0], run.uid])).toEqual(Array(3).fill(['workspace-effect', 2401]));
    expect(gitLaunches().length).toBeGreaterThan(0);
    expect(daemonGit()).toEqual([]);
    expect(os.daemonTouches).toEqual([]);
  });

  // Owner ruling 2026-11-23 ~15:10Z: on an isolation-off Machine a Use guest's own source control
  // runs there. Real: ingress, requester selection, SCM and Git. Isolation expected but unavailable keeps the refusal.
  it('commits for a Use guest in their own repository only where the owner turned isolation off', async () => {
    const direct = await fixture({ sourceRuntimeIsolation: 'disabled' });
    const guestRepository = await repository(direct.directory, 'guest-project');
    git(guestRepository, 'config', 'user.name', 'Guest test');
    git(guestRepository, 'config', 'user.email', 'guest@example.invalid');
    await writeFile(join(guestRepository, 'notes.txt'), 'from the guest\n');
    for (const [method, params] of [
      [RPC_METHODS.SCM_CHANGE_INCLUDE, { cwd: guestRepository, paths: ['notes.txt'] }],
      [RPC_METHODS.SCM_COMMIT_CREATE, { cwd: guestRepository, message: 'guest commit' }],
    ] as const) {
      const response = await direct.invoke(method, params, 'member-account', 'use');
      expect(response, `${method} ${JSON.stringify(response)}`).toMatchObject({ success: true });
    }
    expect(git(guestRepository, 'log', '-1', '--format=%s|%an')).toBe('guest commit|Guest test\n');
    // A retained member folder of another person stays that person's: placement lends no access to it.
    const memberHead = git(direct.memberRepository, 'rev-parse', 'HEAD');
    // A staged change, so only the refusal can leave HEAD where it was.
    await writeFile(join(direct.memberRepository, 'member.txt'), 'member work\n');
    git(direct.memberRepository, 'add', 'member.txt');
    expect(await direct.invoke(RPC_METHODS.SCM_COMMIT_CREATE, { cwd: direct.memberRepository, message: 'not mine' },
      'other-account', 'use')).toMatchObject({ success: false });
    expect(git(direct.memberRepository, 'rev-parse', 'HEAD')).toBe(memberHead);
    // Isolation expected but unavailable: the local commit and the push (owner ruling 2026-11-26: a person's own
    // network work) are admitted only into the member child, which cannot start, so both are refused before any Git.
    const unavailable = await fixture({ sourceRuntimeIsolation: 'required' });
    const unavailableRepository = await repository(unavailable.directory, 'guest-project');
    const before = gitLaunches().length;
    const refusedCommit = await unavailable.invoke(RPC_METHODS.SCM_COMMIT_CREATE, { cwd: unavailableRepository, message: 'refused' },
      'member-account', 'use');
    expect(refusedCommit, JSON.stringify(refusedCommit)).toMatchObject({ success: false, errorCode: 'BACKEND_UNAVAILABLE' });
    expect(gitLaunches().length).toBe(before);
    expect(git(unavailableRepository, 'log', '-1', '--format=%s')).toBe('initial\n');
    expect(await unavailable.invoke(RPC_METHODS.SCM_REMOTE_PUSH, { cwd: unavailableRepository, remote: 'origin', branch: 'main' },
      'member-account', 'use')).toMatchObject({ success: false, errorCode: 'BACKEND_UNAVAILABLE' });
    expect(gitLaunches().length).toBe(before);
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

  // SEC-FORKC-1116 N1: hosting work that reads no member folder runs as it does elsewhere. Hosting work on a member's
  // repository authenticates, so for anyone but that member it is refused before any Git (SEC-RU2-1126B N2).
  it('resolves a hosting address for a member Project like any other, and refuses a Manage PR create in a member folder before any Git', async () => {
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
    const created = await f.invoke(RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE, { cwd: f.memberRepository, base: 'main', title: 'x' },
      'manager-account', 'manage');
    expect(created, JSON.stringify(created)).toMatchObject({ success: false, actionErrorCode: 'credential_scope_denied' });
    expect(gitLaunches()).toEqual([]);
    expect(os.runAs).toEqual([]);
  });

  // Owner ruling 2026-11-23 ~15:10Z (option B, "yes i agree"): "On Machines with isolation on, Use works inside
  // isolation." A Can use member's own local repository writes run whole in their member child, as them.
  // Real: ingress admission, requester selection, SCM handlers, Workspace effect bridge and Git; replaced: RunAs (OS boundary).
  it('runs a Can use member’s local repository writes in their own member folder in their member child', async () => {
    const f = await fixture();
    const cwd = f.memberRepository;
    git(cwd, 'config', 'user.name', 'Member test');
    git(cwd, 'config', 'user.email', 'member@example.invalid');
    await writeFile(join(cwd, 'notes.txt'), 'from use\n');
    await writeFile(join(cwd, 'scratch.txt'), 'thrown away\n');
    const writes = [
      [RPC_METHODS.SCM_CHANGE_INCLUDE, { cwd, paths: ['notes.txt', 'scratch.txt'] }],
      [RPC_METHODS.SCM_CHANGE_EXCLUDE, { cwd, paths: ['scratch.txt'] }],
      [RPC_METHODS.SCM_COMMIT_CREATE, { cwd, message: 'use commit' }],
      [RPC_METHODS.SCM_CHANGE_DISCARD, { cwd, entries: [{ path: 'scratch.txt', kind: 'untracked' }] }],
      [RPC_METHODS.SCM_BRANCH_CREATE, { cwd, name: 'feature', checkout: true }],
      [RPC_METHODS.SCM_BRANCH_CHECKOUT, { cwd, name: 'main', strategy: 'bring_changes' }],
    ] as const;
    for (const [method, params] of writes) {
      const response = await f.invoke(method, params, 'member-account', 'use');
      expect(response, `${method} ${JSON.stringify(response)}`).toMatchObject({ success: true });
    }
    await writeFile(join(cwd, 'notes.txt'), 'stashed\n');
    expect(await f.invoke(RPC_METHODS.SCM_STASH_CREATE, { cwd }, 'member-account', 'use')).toMatchObject({ success: true });
    expect(await f.invoke(RPC_METHODS.SCM_STASH_POP, { cwd, stashRef: 'stash@{0}' }, 'member-account', 'use'))
      .toMatchObject({ success: true });
    expect(git(cwd, 'log', '-1', '--format=%s|%an')).toBe('use commit|Member test\n');
    expect(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main\n');
    expect(git(cwd, 'branch', '--list', 'feature')).toContain('feature');
    expect(git(cwd, 'status', '--porcelain')).toBe(' M notes.txt\n');
    expect(os.runAs.map(run => [run.args[0], run.uid])).toEqual(Array(writes.length + 2).fill(['workspace-effect', 2401]));
    expect(gitLaunches().length).toBeGreaterThan(0);
    expect(daemonGit()).toEqual([]);
    expect(os.daemonTouches).toEqual([]);
  });

  it('refuses a Can use member’s local write outside their own member folder', async () => {
    const f = await fixture();
    await writeFile(join(f.ownerRepository, 'owner.txt'), 'owner work\n');
    git(f.ownerRepository, 'add', 'owner.txt');
    const ownerHead = git(f.ownerRepository, 'rev-parse', 'HEAD');
    const link = join(f.memberRoot, 'outside-link');
    await symlink(f.ownerRepository, link);
    for (const cwd of [f.ownerRepository, link, join(f.memberRepository, '..', '..', 'owner-project')]) {
      expect(await f.invoke(RPC_METHODS.SCM_COMMIT_CREATE, { cwd, message: 'not mine' }, 'member-account', 'use'), cwd)
        .toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    }
    // A Project root outside the member folder is refused by the daemon's lexical check before any member child.
    const before = os.runAs.length;
    expect(await f.invoke(RPC_METHODS.SCM_COMMIT_CREATE, { v: 1, kind: 'targeted_action_rpc', input: { message: 'not mine' },
      target: { kind: 'machine', machineId: f.machineId, project: { machineId: f.machineId, directory: f.ownerRepository } } },
    'member-account', 'use')).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    expect(os.runAs.length).toBe(before);
    expect(git(f.ownerRepository, 'rev-parse', 'HEAD')).toBe(ownerHead);
    expect(daemonGit()).toEqual([]);
    expect(os.daemonTouches).toEqual([]);
  });

  it('refuses a Can use member’s local write that has no member child, and one whose grant was withdrawn, before any Git', async () => {
    for (const [options, refusal] of [
      // Admitted, but no member child can run it: refused by the SCM owner, never run by the daemon.
      [{ memberIdentityUnavailable: true }, { success: false, actionErrorCode: 'agent_isolation_unavailable' }],
      // Home no longer admits this person on the Machine.
      [{ admissionCurrent: false }, { errorCode: RPC_ERROR_CODES.FORBIDDEN }],
    ] as const) {
      const f = await fixture(options);
      await writeFile(join(f.memberRepository, 'notes.txt'), 'from use\n');
      git(f.memberRepository, 'add', 'notes.txt');
      expect(await f.invoke(RPC_METHODS.SCM_COMMIT_CREATE, { cwd: f.memberRepository, message: 'refused' }, 'member-account', 'use'),
        JSON.stringify(options)).toMatchObject(refusal);
      expect(git(f.memberRepository, 'log', '-1', '--format=%s')).toBe('initial\n');
      expect(daemonGit()).toEqual([]);
      expect(os.runAs).toEqual([]);
    }
  });

  // Owner ruling 2026-11-26 ("all of the Git options should work" for a guest, with their own identity): the
  // remaining own-folder local Git operations run whole in the Can use member's child, as that member. Real:
  // ingress admission, requester selection, SCM handlers, Workspace effect bridge and Git; replaced: RunAs (OS boundary).
  const expectRanAsMember = (count: number) => {
    expect(os.runAs.map(run => [run.args[0], run.uid])).toEqual(Array(count).fill(['workspace-effect', 2401]));
    expect(gitLaunches().length).toBeGreaterThan(0);
    expect(daemonGit()).toEqual([]);
    expect(os.daemonTouches).toEqual([]);
  };
  const memberRepositoryWithIdentity = async () => {
    const f = await fixture();
    git(f.memberRepository, 'config', 'user.name', 'Member test');
    git(f.memberRepository, 'config', 'user.email', 'member@example.invalid');
    return f;
  };

  it('backs out and undoes a Can use member’s own commit in their member child', async () => {
    const f = await memberRepositoryWithIdentity();
    const cwd = f.memberRepository;
    await commitFile(cwd, 'a.txt', 'one\n', 'first');
    const first = head(cwd);
    expect(await f.invoke(RPC_METHODS.SCM_COMMIT_BACKOUT, { cwd, commit: first }, 'member-account', 'use'))
      .toMatchObject({ success: true });
    expect(existsSync(join(cwd, 'a.txt'))).toBe(false);
    expect(git(cwd, 'log', '-1', '--format=%an')).toBe('Member test\n');
    const undone = await f.invoke(RPC_METHODS.SCM_COMMIT_UNDO_LAST, { cwd, expectedHeadOid: head(cwd) }, 'member-account', 'use');
    expect(undone, JSON.stringify(undone)).toMatchObject({ success: true });
    expect(head(cwd)).toBe(first);
    expectRanAsMember(2);
  });

  // The member's own repository hooks are what a merge or rebase executes; they run under the member's Git.
  it('merges and rebases for a Can use member, running the repository hooks in their member child', async () => {
    const f = await memberRepositoryWithIdentity();
    const cwd = f.memberRepository;
    for (const hook of ['post-merge', 'post-rewrite']) {
      await writeFile(join(cwd, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> .git/hook.log\n`, { mode: 0o755 });
    }
    git(cwd, 'checkout', '-q', '-b', 'topic');
    await commitFile(cwd, 'topic.txt', 'topic\n', 'topic');
    git(cwd, 'checkout', '-q', 'main');
    await commitFile(cwd, 'main.txt', 'main\n', 'main');
    const merged = await f.invoke(RPC_METHODS.SCM_BRANCH_MERGE, { cwd, sourceRef: 'topic' }, 'member-account', 'use');
    expect(merged, JSON.stringify(merged)).toMatchObject({ success: true });
    expect(git(cwd, 'log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2);
    git(cwd, 'checkout', '-q', '-b', 'later');
    await commitFile(cwd, 'later.txt', 'later\n', 'later');
    git(cwd, 'checkout', '-q', 'main');
    await commitFile(cwd, 'main-two.txt', 'main two\n', 'main two');
    git(cwd, 'checkout', '-q', 'later');
    const rebased = await f.invoke(RPC_METHODS.SCM_BRANCH_REBASE, { cwd, sourceRef: 'main' }, 'member-account', 'use');
    expect(rebased, JSON.stringify(rebased)).toMatchObject({ success: true });
    expect(git(cwd, 'rev-parse', 'later~1').trim()).toBe(git(cwd, 'rev-parse', 'main').trim());
    expect(readFileSync(join(cwd, '.git', 'hook.log'), 'utf8')).toBe('post-merge\npost-rewrite\n');
    // Stand-in: the hooks' Git is the member's framed child (RunAs simulated, UID 2401); no daemon Git ran.
    expectRanAsMember(2);
  });

  it('resolves, continues, aborts and skips a Can use member’s conflicted operations in their member child', async () => {
    const f = await memberRepositoryWithIdentity();
    const cwd = f.memberRepository;
    const use = (method: string, params: unknown) => f.invoke(method, params, 'member-account', 'use');
    const commitBoth = async (content: string, message: string) => {
      await writeFile(join(cwd, 'c.txt'), content);
      await writeFile(join(cwd, 'd.txt'), content);
      git(cwd, 'add', 'c.txt', 'd.txt');
      git(cwd, 'commit', '-q', '-m', message);
    };
    git(cwd, 'checkout', '-q', '-b', 'clash');
    await commitBoth('theirs\n', 'clash');
    git(cwd, 'checkout', '-q', 'main');
    await commitBoth('ours\n', 'ours');
    expect(await use(RPC_METHODS.SCM_BRANCH_MERGE, { cwd, sourceRef: 'clash' }))
      .toMatchObject({ success: false, errorCode: 'CONFLICTING_WORKTREE' });
    expect(await use(RPC_METHODS.SCM_CONFLICT_ACCEPT_SIDE, { cwd, path: 'c.txt', side: 'theirs' })).toMatchObject({ success: true });
    await writeFile(join(cwd, 'd.txt'), 'both\n');
    expect(await use(RPC_METHODS.SCM_CONFLICT_MARK_RESOLVED, { cwd, paths: ['d.txt'] })).toMatchObject({ success: true });
    const continued = await use(RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE, { cwd, operation: 'merge' });
    expect(continued, JSON.stringify(continued)).toMatchObject({ success: true });
    expect(readFileSync(join(cwd, 'c.txt'), 'utf8')).toBe('theirs\n');
    expect(git(cwd, 'log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2);
    // Abort: a second conflicting merge is thrown away.
    git(cwd, 'checkout', '-q', '-b', 'clash-two', 'clash');
    await commitFile(cwd, 'e.txt', 'theirs\n', 'clash two');
    git(cwd, 'checkout', '-q', 'main');
    await commitFile(cwd, 'e.txt', 'ours\n', 'ours two');
    const beforeAbort = head(cwd);
    expect(await use(RPC_METHODS.SCM_BRANCH_MERGE, { cwd, sourceRef: 'clash-two' })).toMatchObject({ success: false });
    expect(await use(RPC_METHODS.SCM_BRANCH_OPERATION_ABORT, { cwd, operation: 'merge' })).toMatchObject({ success: true });
    expect(head(cwd)).toBe(beforeAbort);
    expect(git(cwd, 'status', '--porcelain')).toBe('');
    // Skip: a rebase whose only commit conflicts leaves the branch at its new base.
    git(cwd, 'checkout', '-q', '-b', 'stale', 'clash-two');
    git(cwd, 'reset', '-q', '--hard', 'clash-two~1');
    await commitFile(cwd, 'e.txt', 'stale\n', 'stale');
    expect(await use(RPC_METHODS.SCM_BRANCH_REBASE, { cwd, sourceRef: 'main' })).toMatchObject({ success: false });
    const skipped = await use(RPC_METHODS.SCM_BRANCH_OPERATION_SKIP, { cwd, operation: 'rebase' });
    expect(skipped, JSON.stringify(skipped)).toMatchObject({ success: true });
    expect(head(cwd)).toBe(git(cwd, 'rev-parse', 'main').trim());
    expectRanAsMember(8);
  });

  // Review suggestions change files of the member's own checkout only; each file path is confined to it. This
  // receiver places them; Home's route table (no Machine row: custodian only) still decides who reaches it.
  it('applies review suggestions to a Can use member’s own checkout in their member child, and refuses one outside it', async () => {
    const f = await memberRepositoryWithIdentity();
    const cwd = f.memberRepository;
    await commitFile(cwd, 's.txt', 'one\ntwo\n', 'suggested');
    const suggestion = (path: string) => ({ path, commitOid: head(cwd), startLine: 2, endLine: 2, originalLines: ['two'],
      replacement: 'TWO', outdated: false });
    const applied = await f.invoke('scm.suggestion.apply', { sessionId: 'session-1', cwd, suggestions: [suggestion('s.txt')] },
      'member-account', 'use');
    expect(applied, JSON.stringify(applied)).toMatchObject({ success: true });
    expect(readFileSync(join(cwd, 's.txt'), 'utf8')).toBe('one\nTWO\n');
    await writeFile(join(f.ownerRepository, 's.txt'), 'one\ntwo\n');
    for (const [requestCwd, path, accountId] of [
      [cwd, '../../owner-project/s.txt', 'member-account'],
      [f.ownerRepository, 's.txt', 'member-account'],
      [cwd, 's.txt', 'other-account'],
    ] as const) {
      const refused = await f.invoke('scm.suggestion.apply', { sessionId: 'session-1', cwd: requestCwd,
        suggestions: [suggestion(path)] }, accountId, 'use');
      expect(refused, `${requestCwd} ${path} ${accountId} ${JSON.stringify(refused)}`)
        .toMatchObject({ success: false, files: [{ errorCode: 'invalid_path' }] });
    }
    expect(readFileSync(join(f.ownerRepository, 's.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(readFileSync(join(cwd, 's.txt'), 'utf8')).toBe('one\nTWO\n');
    expect(os.runAs.map(run => run.uid)).toEqual([2401, 2401, 2401, 2402]);
    expect(daemonGit()).toEqual([]);
    expect(os.daemonTouches).toEqual([]);
  });

  it('prunes a Can use member’s stale worktree records in their member child', async () => {
    const f = await memberRepositoryWithIdentity();
    const cwd = f.memberRepository;
    const gone = join(f.memberRoot, 'gone-checkout');
    git(cwd, 'worktree', 'add', '-q', '--detach', gone);
    await rm(gone, { recursive: true, force: true });
    expect(git(cwd, 'worktree', 'list', '--porcelain')).toContain(gone);
    const pruned = await f.invoke(RPC_METHODS.SCM_WORKTREE_PRUNE, { cwd }, 'member-account', 'use');
    expect(pruned, JSON.stringify(pruned)).toMatchObject({ success: true });
    expect(git(cwd, 'worktree', 'list', '--porcelain')).not.toContain(gone);
    expectRanAsMember(1);
  });

  it('adds, repoints and removes a Can use member’s remotes as local configuration, in their member child', async () => {
    const f = await memberRepositoryWithIdentity();
    const cwd = f.memberRepository;
    const first = join(f.memberRoot, 'first.git');
    const second = join(f.memberRoot, 'second.git');
    expect(await f.invoke(RPC_METHODS.SCM_REMOTE_ADD, { cwd, name: 'mine', fetchUrl: first }, 'member-account', 'use'))
      .toMatchObject({ success: true });
    expect(await f.invoke(RPC_METHODS.SCM_REMOTE_SET_URL, { cwd, name: 'mine', fetchUrl: second }, 'member-account', 'use'))
      .toMatchObject({ success: true });
    expect(git(cwd, 'config', 'remote.mine.url')).toBe(`${second}\n`);
    expect(await f.invoke(RPC_METHODS.SCM_REMOTE_REMOVE, { cwd, name: 'mine' }, 'member-account', 'use'))
      .toMatchObject({ success: true });
    expect(git(cwd, 'remote')).toBe('');
    expectRanAsMember(3);
  });

  it('initializes a repository and clears a stale index lock in a Can use member’s own folder, in their member child', async () => {
    const f = await memberRepositoryWithIdentity();
    const fresh = join(f.memberRoot, 'fresh');
    await mkdir(fresh);
    const initialized = await f.invoke(RPC_METHODS.SCM_REPOSITORY_INIT, { cwd: fresh }, 'member-account', 'use');
    expect(initialized, JSON.stringify(initialized)).toMatchObject({ success: true });
    expect(existsSync(join(fresh, '.git'))).toBe(true);
    await writeFile(join(f.memberRepository, '.git', 'index.lock'), '');
    const cleared = await f.invoke(RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK, { cwd: f.memberRepository, confirmed: true,
      confirmationToken: REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN }, 'member-account', 'use');
    expect(cleared, JSON.stringify(cleared)).toMatchObject({ success: true });
    expect(existsSync(join(f.memberRepository, '.git', 'index.lock'))).toBe(false);
    expectRanAsMember(2);
  });

  it('refuses every newly opened family on another person’s repository and in another member’s folder, before any Git', async () => {
    const f = await fixture();
    const ownerHead = head(f.ownerRepository);
    const otherHead = head(f.memberRepository);
    for (const [method, params] of ownFolderGitRequests(f.ownerRepository)) {
      const response = await f.invoke(method, params, 'member-account', 'use');
      expect(response, `${method} ${JSON.stringify(response)}`).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    }
    // Another member's folder: their request runs in THEIR child (UID 2402), which cannot reach this folder.
    for (const [method, params] of ownFolderGitRequests(f.memberRepository)) {
      const response = await f.invoke(method, params, 'other-account', 'use');
      expect(response, `${method} ${JSON.stringify(response)}`).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    }
    expect(new Set(os.runAs.map(run => run.uid))).toEqual(new Set([2401, 2402]));
    expect(gitLaunches()).toEqual([]);
    expect(head(f.ownerRepository)).toBe(ownerHead);
    expect(head(f.memberRepository)).toBe(otherHead);
    expect(git(f.ownerRepository, 'remote')).toBe('');
  });

  it('contains paths that leave a Can use member’s folder and refuses an embedded-credential remote URL, before any Git effect', async () => {
    const f = await memberRepositoryWithIdentity();
    const cwd = f.memberRepository;
    const link = join(f.memberRoot, 'outside-link');
    await symlink(f.ownerRepository, link);
    // A symlink out of the folder, and a raw parent path the member child resolves against its folder.
    for (const escape of [link, '../owner-project']) {
      for (const [method, params] of ownFolderGitRequests(escape)) {
        const response = await f.invoke(method, params, 'member-account', 'use');
        expect(response, `${method} ${escape} ${JSON.stringify(response)}`).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
      }
    }
    expect(gitLaunches()).toEqual([]);
    // A remote URL is not a path; one carrying a credential is refused as clone refuses it.
    git(cwd, 'remote', 'add', 'origin', join(f.memberRoot, 'origin.git'));
    expect(await f.invoke(RPC_METHODS.SCM_REMOTE_SET_URL, { cwd, name: 'origin',
      fetchUrl: 'https://person:synthetic-pass@forge.example/team/repo.git' }, 'member-account', 'use'))
      .toMatchObject({ success: false, errorCode: 'INVALID_REQUEST', error: expect.stringContaining('Remove the password') });
    expect(git(cwd, 'config', 'remote.origin.url')).toBe(`${join(f.memberRoot, 'origin.git')}\n`);
    expect(daemonGit()).toEqual([]);
  });

  it('refuses every newly opened family at the next request once the grant is withdrawn, before any member child', async () => {
    const f = await fixture({ admissionCurrent: false });
    for (const [method, params] of [...ownFolderGitRequests(f.memberRepository), ...ownFolderCredentialRequests(f.memberRoot, f.memberRepository),
      ['scm.suggestion.apply', { sessionId: 'session-1', cwd: f.memberRepository, suggestions: [] }] as const]) {
      expect(await f.invoke(method, params, 'member-account', 'use'), method).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    }
    expect(os.runAs).toEqual([]);
    expect(gitLaunches()).toEqual([]);
    // Isolation OFF: the same withdrawn grant refuses suggestion apply and every credential family, before any Git.
    const off = await fixture({ admissionCurrent: false, sourceRuntimeIsolation: 'disabled' });
    for (const [method, params] of [...ownFolderCredentialRequests(off.memberRoot, off.memberRepository),
      ['scm.suggestion.apply', { sessionId: 'session-1', cwd: off.memberRepository, suggestions: [] }] as const]) {
      expect(await off.invoke(method, params, 'member-account', 'use'), `isolation off ${method}`)
        .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    }
    expect(os.runAs).toEqual([]);
    expect(gitLaunches()).toEqual([]);
  });

  // Comparisons run on this Machine's stored Account and model credentials, and worktree create and remove run through
  // the host Project lifecycle on this Machine's Account: each keeps the Manage refusal (one request per family).
  it('keeps Can use comparison and Project worktree families on the Manage refusal, before any Git', async () => {
    const f = await fixture();
    const cwd = f.memberRepository;
    for (const [method, params] of [
      [RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE, { cwd, source: { kind: 'workingTree' } }],
      [RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE, { cwd, source: { kind: 'workingTree' } }],
      [RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ, { cwd, resultId: 'result' }],
      [RPC_METHODS.SCM_WORKTREE_CREATE, { cwd, displayName: 'side' }],
      [RPC_METHODS.SCM_WORKTREE_REMOVE, { cwd, worktreePath: join(cwd, 'side'), confirmed: true,
        authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN }],
    ] as const) {
      expect(await f.invoke(method, params, 'member-account', 'use'), method)
        .toMatchObject({ errorCode: 'machine_manage_required' });
    }
    expect(gitLaunches()).toEqual([]);
    expect(os.runAs).toEqual([]);
  });

  // Parity: where the owner turned isolation off, and for Manage, the same requests keep their outcomes.
  it('keeps the newly opened families’ outcomes for an isolation-off Use guest and for Manage', async () => {
    const direct = await fixture({ sourceRuntimeIsolation: 'disabled' });
    const guestRepository = await repository(direct.directory, 'guest-project');
    git(guestRepository, 'config', 'user.name', 'Guest test');
    git(guestRepository, 'config', 'user.email', 'guest@example.invalid');
    const f = await memberRepositoryWithIdentity();
    for (const [invoke, cwd, accountId, role] of [
      [direct.invoke, guestRepository, 'member-account', 'use'],
      [f.invoke, f.memberRepository, 'manager-account', 'manage'],
      [f.invoke, f.ownerRepository, 'manager-account', 'manage'],
    ] as const) {
      git(cwd, 'config', 'user.name', 'Parity test');
      git(cwd, 'config', 'user.email', 'parity@example.invalid');
      await commitFile(cwd, 'parity.txt', 'parity\n', 'parity');
      for (const [method, params] of [
        [RPC_METHODS.SCM_COMMIT_BACKOUT, { cwd, commit: head(cwd) }],
        [RPC_METHODS.SCM_REMOTE_ADD, { cwd, name: 'parity', fetchUrl: join(direct.directory, 'parity.git') }],
        [RPC_METHODS.SCM_REMOTE_REMOVE, { cwd, name: 'parity' }],
        [RPC_METHODS.SCM_WORKTREE_PRUNE, { cwd }],
        [RPC_METHODS.SCM_BRANCH_MERGE, { cwd, sourceRef: 'main' }],
      ] as const) {
        const response = await invoke(method, params, accountId, role);
        expect(response, `${role} ${cwd} ${method} ${JSON.stringify(response)}`).toMatchObject({ success: true });
      }
    }
    // Isolation off runs on the daemon; Manage in a member folder runs in that member's child.
    expect(os.runAs.map(run => [run.args[0], run.uid])).toEqual(Array(5).fill(['workspace-effect', 2401]));
  });

  it('refuses Can use reads of another folder and forge methods before any daemon Git or state read', async () => {
    const f = await fixture();
    expect(await f.invoke(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: f.ownerRepository }, 'member-account', 'use'))
      .toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    expect(await f.invoke(RPC_METHODS.SCM_PULL_REQUEST_LIST, { cwd: f.ownerRepository }, 'member-account', 'use'))
      .toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    expect(daemonGit()).toEqual([]);
    expect(os.daemonTouches).toEqual([]);
  });

  // GUEST-HOSTING-CREDENTIALS-2 (owner ruling 2026-11-26; SEC-RU2-1126B N2): network and hosting work in a member folder
  // runs only for that folder's member. The Machine's owner and a Manage person are refused before any Git or member
  // child, so neither this Machine's credential nor that member's login can serve their request.
  it('refuses network and hosting work in a member folder for anyone but that member, before any Git or member child', async () => {
    const f = await fixture();
    for (const accountId of ['owner-account', 'manager-account']) {
      for (const [method, params] of ownFolderCredentialRequests(f.memberRoot, f.memberRepository)) {
        const response = await f.invoke(method, params, accountId, 'manage');
        expect(response, `${accountId} ${method} ${JSON.stringify(response)}`)
          .toMatchObject({ success: false, actionErrorCode: 'credential_scope_denied' });
      }
    }
    expect(gitLaunches()).toEqual([]);
    expect(os.runAs).toEqual([]);
  });

  // A Can use member's network and hosting work runs whole in their member child, in their own folder only. With no
  // connected account of their own it settles authentication required: their member login is never consulted either.
  it('runs a Can use member’s network work in their own folder in their member child, with only their own accounts', async () => {
    const f = await memberRepositoryWithIdentity();
    const cwd = f.memberRepository;
    const marker = join(f.directory, 'member-helper-invoked');
    git(cwd, 'remote', 'add', 'origin', 'https://github.com/member/project.git');
    git(cwd, 'config', 'credential.helper', `!f() { echo invoked > '${marker}'; echo username=x; echo password=synthetic-member-login; }; f`);
    for (const [method, params] of [
      [RPC_METHODS.SCM_REMOTE_FETCH, { cwd, remote: 'origin' }],
      [RPC_METHODS.SCM_REMOTE_PULL, { cwd, remote: 'origin' }],
      [RPC_METHODS.SCM_REMOTE_PUSH, { cwd, remote: 'origin', branch: 'main' }],
    ] as const) {
      const response = await f.invoke(method, params, 'member-account', 'use');
      expect(response, `${method} ${JSON.stringify(response)}`).toMatchObject({ success: false, errorCode: 'REMOTE_AUTH_REQUIRED' });
    }
    expect(existsSync(marker)).toBe(false);
    expect(os.runAs.map(run => [run.args[0], run.uid])).toEqual(Array(3).fill(['workspace-effect', 2401]));
    expect(daemonGit()).toEqual([]);
    expect(os.daemonTouches).toEqual([]);
  });

  // Composed negatives for the widened admission: wrong person, wrong folder (owner's repository, another member's
  // folder, a symlink or a parent path out of the folder), no member binding and a withdrawn grant (above), each
  // refused before any Git process.
  it('refuses a Can use member’s network and hosting work outside their own folder and without a member binding, before any Git', async () => {
    const f = await fixture();
    const link = join(f.memberRoot, 'outside-link');
    await symlink(f.ownerRepository, link);
    for (const [accountId, folder, cwd] of [
      ['member-account', f.directory, f.ownerRepository],
      ['member-account', f.otherMemberRoot, f.otherMemberRepository],
      ['member-account', link, link],
      ['member-account', join(f.memberRoot, '..'), '../owner-project'],
      ['other-account', f.memberRoot, f.memberRepository],
    ] as const) {
      for (const [method, params] of ownFolderCredentialRequests(folder, cwd)) {
        const response = await f.invoke(method, params, accountId, 'use');
        expect(response, `${accountId} ${cwd} ${method} ${JSON.stringify(response)}`).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
      }
    }
    expect(gitLaunches()).toEqual([]);
    // A `.git` pointer file in their own folder naming the owner's repository: the request runs only in their member
    // child, as them, so the OS account decides; Git's ownership check (forced here: the harness has one OS user)
    // refuses before any network command, and no daemon Git or credential is involved.
    const pointer = join(f.memberRoot, 'pointer');
    await mkdir(pointer);
    await writeFile(join(pointer, '.git'), `gitdir: ${join(f.ownerRepository, '.git')}\n`);
    vi.stubEnv('GIT_TEST_ASSUME_DIFFERENT_OWNER', '1');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    os.runAs.length = 0;
    for (const [method, params] of ownFolderCredentialRequests(f.memberRoot, pointer).filter(([method]) => method !== RPC_METHODS.SCM_REPOSITORY_CLONE)) {
      const response = await f.invoke(method, params, 'member-account', 'use');
      expect(response, `pointer ${method} ${JSON.stringify(response)}`).toMatchObject({ success: false });
    }
    vi.unstubAllEnvs();
    expect(git(f.ownerRepository, 'remote')).toBe('');
    expect(daemonGit()).toEqual([]);
    expect(new Set(os.runAs.map(run => run.uid))).toEqual(new Set([2401]));
    os.direct.length = 0;
    const unbound = await fixture({ memberIdentityUnavailable: true });
    for (const [method, params] of ownFolderCredentialRequests(unbound.memberRoot, unbound.memberRepository)) {
      const response = await unbound.invoke(method, params, 'member-account', 'use');
      expect(response, `${method} ${JSON.stringify(response)}`).toMatchObject({ success: false });
      expect(JSON.stringify(response)).not.toContain('"success":true');
    }
    expect(gitLaunches()).toEqual([]);
  });

  // The positive: a Can use member's push in their own folder authenticates with their own connected account only.
  // The daemon brokers HTTP authentication into the member child; the token never reaches the daemon's Git, another
  // member's request, the result or the repository configuration.
  it('pushes for a Can use member with their own connected account, brokered into their member child only', async () => {
    const memberToken = 'synthetic-member-hosting-token-1126';
    const otherToken = 'synthetic-other-member-hosting-token-1126';
    const materialized: string[] = [];
    const f = await fixture({ hostingAccounts: new Map([
      ['member-account', hostingAccountOwner('member-account', memberToken, materialized)],
      ['other-account', hostingAccountOwner('other-account', otherToken, materialized)],
    ]) });
    git(f.memberRepository, 'config', 'user.name', 'Member test');
    git(f.memberRepository, 'config', 'user.email', 'member@example.invalid');
    const basic = (token: string) => `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    const forge = await startGitSmartHttpFixture({ authorization: basic(memberToken), branch: 'main' });
    onTestFinished(() => forge.close());
    // The forge fixture serves each authorized request with its own `git http-backend` on this side; nothing else may.
    const forgeSetupGit = daemonGit().length;
    const repositoryUrl = 'https://github.com/member/project.git';
    git(f.memberRepository, 'remote', 'add', 'origin', repositoryUrl);
    // A branch the forge does not have yet (its own `main` has unrelated history).
    git(f.memberRepository, 'checkout', '-q', '-b', 'guest-work');
    const seen: (string | null)[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (resource: string | URL | Request, init?: RequestInit) => {
      const url = String(resource instanceof Request ? resource.url : resource);
      if (!url.startsWith(`${repositoryUrl}/`)) return await realFetch(resource, init);
      seen.push(new Headers(init?.headers).get('authorization'));
      return await realFetch(`${forge.url}/${url.slice(repositoryUrl.length + 1)}`, init);
    });
    onTestFinished(() => { vi.unstubAllGlobals(); });
    const pushed = await f.invoke(RPC_METHODS.SCM_REMOTE_PUSH, { cwd: f.memberRepository, remote: 'origin', branch: 'guest-work' },
      'member-account', 'use', undefined, undefined, undefined, admittedCustody(f, 'member-account'));
    expect(pushed, JSON.stringify(pushed)).toMatchObject({ success: true });
    expect(execFileSync('git', ['--git-dir', forge.bareRepositoryPath, 'rev-parse', 'guest-work'], { encoding: 'utf8' }).trim())
      .toBe(head(f.memberRepository));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(header => header === basic(memberToken))).toBe(true);
    expect(materialized).toEqual(['member-account']);
    // The same push replayed from an Action whose admitted custody travels only in the retained original ingress
    // (SEC-RU2-1127A F1): the member's own account, in their child, again.
    await commitFile(f.memberRepository, 'replayed.txt', 'replayed', 'replayed');
    const replayed = await f.invoke(RPC_METHODS.SCM_REMOTE_PUSH, { cwd: f.memberRepository, remote: 'origin', branch: 'guest-work' },
      'member-account', 'use', undefined, { externalActionExecutionAuthorization: admittedCustody(f, 'member-account') });
    expect(replayed, JSON.stringify(replayed)).toMatchObject({ success: true });
    expect(execFileSync('git', ['--git-dir', forge.bareRepositoryPath, 'rev-parse', 'guest-work'], { encoding: 'utf8' }).trim())
      .toBe(head(f.memberRepository));
    expect(seen.every(header => header === basic(memberToken))).toBe(true);
    expect(materialized).toEqual(['member-account', 'member-account']);
    // The other member's own request into this folder never reaches it, and never uses this member's account.
    expect(await f.invoke(RPC_METHODS.SCM_REMOTE_PUSH, { cwd: f.memberRepository, remote: 'origin', branch: 'guest-work' },
      'other-account', 'use', undefined, undefined, undefined, admittedCustody(f, 'other-account')))
      .toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    expect(materialized).toEqual(['member-account', 'member-account']);
    const captured = [JSON.stringify(pushed), JSON.stringify(replayed), readFileSync(join(f.memberRepository, '.git', 'config'), 'utf8')].join('\n');
    expect(captured.includes(memberToken) || captured.includes(Buffer.from(`x-access-token:${memberToken}`).toString('base64'))).toBe(false);
    expect(new Set(os.runAs.map(run => run.uid))).toEqual(new Set([2401, 2402]));
    expect(daemonGit().length - forgeSetupGit).toBe(forge.requests.filter(request => request.status !== 401).length);
  });
  // SEC-RU2-1127B T1 (reviewer case B5; Coordination 2026-11-26 12:32Z negatives for the suggestion-apply Use row):
  // a symlink escape with isolation on, and another member's folder with isolation off, leave every file unchanged.
  it('refuses scm.suggestion.apply (Use row) through symlink escape with isolation on, and another member’s folder with isolation off', async () => {
    const f = await fixture();
    for (const repo of [f.memberRepository]) { git(repo, 'config', 'user.name', 'Member test'); git(repo, 'config', 'user.email', 'member@example.invalid'); }
    const cwd = f.memberRepository;
    await commitFile(cwd, 's.txt', 'one\ntwo\n', 'suggested');
    await writeFile(join(f.ownerRepository, 's.txt'), 'one\ntwo\n');
    const suggestion = (path: string, oid: string) => ({ path, commitOid: oid, startLine: 2, endLine: 2, originalLines: ['two'],
      replacement: 'TWO', outdated: false });
    await symlink(f.ownerRepository, join(cwd, 'owner-link'));
    for (const [requestCwd, path] of [[cwd, 'owner-link/s.txt'], [join(cwd, 'owner-link'), 's.txt']] as const) {
      const refused = await f.invoke('scm.suggestion.apply', { sessionId: 'session-1', cwd: requestCwd,
        suggestions: [suggestion(path, head(cwd))] }, 'member-account', 'use');
      expect(JSON.stringify(refused)).not.toContain('"success":true');
    }
    expect(readFileSync(join(f.ownerRepository, 's.txt'), 'utf8')).toBe('one\ntwo\n');
    const direct = await fixture({ sourceRuntimeIsolation: 'disabled' });
    git(direct.memberRepository, 'config', 'user.name', 'Member test'); git(direct.memberRepository, 'config', 'user.email', 'member@example.invalid');
    await commitFile(direct.memberRepository, 'm.txt', 'one\ntwo\n', 'member file');
    const refusedOff = await direct.invoke('scm.suggestion.apply', { sessionId: 'session-1', cwd: direct.memberRepository,
      suggestions: [{ ...suggestion('m.txt', head(direct.memberRepository)) }] }, 'other-account', 'use');
    expect(JSON.stringify(refusedOff)).not.toContain('"success":true');
    expect(readFileSync(join(direct.memberRepository, 'm.txt'), 'utf8')).toBe('one\ntwo\n');
  });
});
