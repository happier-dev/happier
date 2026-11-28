import axios from 'axios';
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { TerminalStreamReadResponseSchema, decodeTerminalStreamBytesFrame, type TerminalStreamBytesFrame } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { WorkflowAcceptedAuthorizationV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1, PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ACTION_OPERATION_RPC_METHODS_V1, ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { AccountSettingsSchema } from '@happier-dev/protocol/account/settings/accountSettings';
import { AgentStartSessionCallerV1Schema } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { WorkspaceExecutionConfigReadResponseV1Schema, WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { ProjectManifestV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { RpcLocalActionContext } from '@/api/rpc/types';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createAgentIsolationMemberPreparationBoundary, runAgentIsolationMemberReadinessBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { buildAgentIsolationProvisioningSteps, deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { readAgentIsolationMemberBindingForAccount, writeAgentIsolationMemberBinding } from '@/daemon/agentIsolation/memberBindings';
import { readAgentIsolationSnapshot } from '@/daemon/agentIsolation/agentIsolationPolicy';
import { AGENT_LAUNCH_TERMINAL_ACCEPTED, AGENT_LAUNCH_TERMINAL_READY, readAgentLaunchFrame, type AgentLaunchPayload } from '@/daemon/agentIsolation/agentLaunchFrame';
import { createInstalledProjectFiniteRuntime } from '@/daemon/startup/createInstalledProjectFiniteRuntime';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { materializeWorkspaceRefForMachineRoot } from '@/workspaces/workspaceRefsV1';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { writeStoredCredentialsForServerId } from '@/persistence';
import * as ptyBoundary from '@/terminal/pty/provider';
import * as processBoundary from '@happier-dev/cli-common/process';
import * as terminationBoundary from '@/processes/terminate/terminateProcessTree';
import type { PtyProcess, PtySpawnParams } from '@/terminal/pty/provider';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { authorizeResolvedProjectExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { executeProjectFiniteProcess } from '@/workspaces/projectSetup/projectSetupExecution';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import * as scmProcess from '@/scm/runtime';

function closedFailureReason(value: unknown, field: string) {
  const candidate: unknown = value && typeof value === 'object' ? Reflect.get(value, field) : undefined;
  return typeof candidate === 'string' && /^[a-z][a-z0-9_]*$/u.test(candidate) ? candidate : undefined;
}

type NativeHome = { path: string; workspaceRoot: string; backing: string; workspaceBacking: string; uid: number };
const nativeOs: { home: NativeHome | undefined; sharedHome: string | undefined; memberEffectErrors: string[];
  /** Another person's checkout: every in-process (daemon-user) filesystem call under it is recorded. */
  ownerRoots: string[]; ownerDaemonReads: string[] } = vi.hoisted(() => ({ home: undefined, sharedHome: undefined, memberEffectErrors: [],
  ownerRoots: [], ownerDaemonReads: [] }));
// Native ownership and path mapping are OS boundaries. No requester selector,
// Account runtime, native preparation, finalizer, PTY manager or RPC is mocked.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  const pathFor = (path: Parameters<typeof actual.readFile>[0]) => {
    if (typeof path === 'string' && nativeOs.ownerRoots.some(root => path === root || path.startsWith(`${root}/`))) nativeOs.ownerDaemonReads.push(path);
    const home = nativeOs.home;
    if (typeof path !== 'string' || !home) return path;
    if (path === home.path || path.startsWith(`${home.path}/`)) return home.backing + path.slice(home.path.length);
    if (path === home.workspaceRoot || path.startsWith(`${home.workspaceRoot}/`)) return home.workspaceBacking + path.slice(home.workspaceRoot.length);
    return path;
  };
  return { ...actual,
    async lstat(path: Parameters<typeof actual.lstat>[0]) {
      const home = nativeOs.home;
      if (String(path) === home?.path) return Object.assign(await actual.lstat(home.backing), { uid: home.uid, gid: home.uid, mode: 0o40700 });
      return actual.lstat(pathFor(path));
    },
    async realpath(path: Parameters<typeof actual.realpath>[0]) {
      const home = nativeOs.home;
      const resolved = await actual.realpath(pathFor(path));
      if (home) for (const [logical, backing] of [[home.path, home.backing], [home.workspaceRoot, home.workspaceBacking]]) {
        if (resolved === backing || resolved.startsWith(`${backing}/`)) return logical + resolved.slice(backing.length);
      }
      return resolved;
    },
    stat: ((...args: Parameters<typeof actual.stat>) => Reflect.apply(actual.stat, actual,
      [pathFor(args[0]), ...args.slice(1)])) as typeof actual.stat,
    readdir: ((...args: Parameters<typeof actual.readdir>) => Reflect.apply(actual.readdir, actual,
      [pathFor(args[0]), ...args.slice(1)])) as typeof actual.readdir,
    open: ((...args: Parameters<typeof actual.open>) => Reflect.apply(actual.open, actual,
      [pathFor(args[0]), ...args.slice(1)])) as typeof actual.open,
    // Preserve Node's overloaded encoding contract at this genuine fs boundary.
    readFile: ((...args: Parameters<typeof actual.readFile>) => Reflect.apply(actual.readFile, actual,
      [pathFor(args[0]), ...args.slice(1)])) as typeof actual.readFile,
  };
});
vi.mock('@happier-dev/cli-common/process', async original => {
  const actual = await original<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...args: Parameters<typeof actual.execFileWithDeadline>) => {
    if (args[0] === 'getent' && JSON.stringify(args[1]) === JSON.stringify(['--service=files', 'passwd', 'happier-agent'])
      && nativeOs.sharedHome) return Promise.resolve({ stdout: `happier-agent:x:2402:2402::${nativeOs.sharedHome}:/usr/sbin/nologin\n`, stderr: '' });
    const readiness = await runAgentIsolationMemberReadinessBoundary({ request: args, nativeHome: nativeOs.home });
    if (readiness) return readiness;
    return actual.execFileWithDeadline(...args);
  } };
});
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const memberEffect = await import('@/daemon/agentIsolation/memberEffectWorker.testkit');
  return { ...actual, spawn: ((...args: Parameters<typeof actual.spawn>) => {
    const options = args[2];
    const cwd = options?.cwd;
    const home = nativeOs.home;
    // A native member effect runs the real member entrypoint against the member home backing.
    if (home && memberEffect.isMemberAgentLaunchSpawn(args[0], args[1])) {
      const child = memberEffect.spawnMemberEffectWorker({ actualSpawn: actual.spawn, options, backing: home.backing,
        workspace: { root: home.workspaceRoot, backing: home.workspaceBacking } });
      child.stderr?.on('data', chunk => nativeOs.memberEffectErrors.push(String(chunk)));
      return child;
    }
    // The member filesystem already uses this real temporary backing. Translate
    // the same OS cwd boundary for real Git children; SCM/plugin logic stays real.
    const mapped = home && typeof cwd === 'string' && (cwd === home.workspaceRoot || cwd.startsWith(`${home.workspaceRoot}/`))
      ? home.workspaceBacking + cwd.slice(home.workspaceRoot.length) : cwd;
    return actual.spawn(args[0], args[1], options ? { ...options, cwd: mapped } : options);
  }) as typeof actual.spawn };
});
afterEach(() => { nativeOs.home = undefined; nativeOs.sharedHome = undefined; nativeOs.memberEffectErrors = [];
  nativeOs.ownerRoots = []; nativeOs.ownerDaemonReads = []; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

class NativePty implements PtyProcess {
  readonly data = new Set<(data: Buffer | string) => void>();
  readonly exits = new Set<(event: { exitCode: number }) => void>();
  readonly writes: string[] = [];
  readonly frames: AgentLaunchPayload[] = [];
  readonly dimensions: Array<{ cols: number; rows: number }> = [];
  exited = false;
  private child?: ChildProcess;
  private resolveSettled!: () => void;
  private readonly settled = new Promise<void>(resolve => { this.resolveSettled = resolve; });
  framePending: boolean;
  constructor(readonly pid: number, readonly params: PtySpawnParams) { this.framePending = params.file === 'sudo'; }
  get ownedProcessGroupId() { return this.pid; }
  write(data: string) {
    if (this.framePending) {
      this.framePending = false;
      void readAgentLaunchFrame(Readable.from([Buffer.from(data)], { objectMode: false }), 'terminal').then(frame => {
        this.frames.push(frame); this.emit(AGENT_LAUNCH_TERMINAL_ACCEPTED);
        if (this.params.finiteProcess) this.execute(frame.executable, frame.args, frame.cwd, frame.environment);
      }).catch(() => { this.finish(1); });
      return;
    }
    this.writes.push(data);
    this.emit(`ran:${data.trim()}\r\n`);
  }
  resize(cols: number, rows: number) { this.dimensions.push({ cols, rows }); }
  kill() { this.exit(); }
  onData(listener: (data: string) => void) {
    const bytes = (data: Buffer | string) => listener(String(data)); this.data.add(bytes);
    return { dispose: () => { this.data.delete(bytes); } };
  }
  onDataBytes(listener: (data: Buffer | string) => void) { this.data.add(listener); return { dispose: () => { this.data.delete(listener); } }; }
  onExit(listener: (event: { exitCode: number }) => void) { this.exits.add(listener); return { dispose: () => { this.exits.delete(listener); } }; }
  emit(data: string) { for (const listener of this.data) listener(Buffer.from(data)); }
  execute(command: string, args: readonly string[], cwd: string | undefined, env: Readonly<Record<string, string | undefined>> | undefined) {
    // This is the substituted forkpty/RunAs boundary, not another native owner:
    // execute exactly the decoded payload against the mapped fixture filesystem.
    const home = nativeOs.home;
    const actualCwd = home && cwd && (cwd === home.workspaceRoot || cwd.startsWith(`${home.workspaceRoot}/`))
      ? home.workspaceBacking + cwd.slice(home.workspaceRoot.length) : cwd;
    const child = spawn(command, [...args], { cwd: actualCwd, env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout?.on('data', bytes => { for (const listener of this.data) listener(bytes); });
    child.stderr?.on('data', bytes => { for (const listener of this.data) listener(bytes); });
    child.once('error', () => { this.finish(1); });
    child.once('close', code => { this.finish(code ?? 1); });
  }
  private finish(exitCode: number) {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exits) listener({ exitCode });
    this.resolveSettled();
  }
  exit() { if (this.child && !this.exited) this.child.kill('SIGTERM'); else this.finish(0); }
  waitForSettlement() { return this.settled; }
}

async function fixture(options: Readonly<{ cold?: true; finite?: true; setup?: true; nativePackageScript?: true; requesterAsk?: true; ownerAgent?: true; accountId?: 'member-a' | 'requester'; isolationEnabled?: boolean; legacy?: true; acceptedWorkspace?: false; policyUnread?: true }> = {}) {
  const accountId = options.accountId ?? 'member-a';
  const isolationEnabled = options.isolationEnabled ?? true;
  const actionId = options.finite ? 'projects.script.run' : 'machines.terminal.open';
  const accountSettings = options.finite ? AccountSettingsSchema.parse({ actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {},
    approvalWaivedSurfaces: { 'projects.script.run': ['ui', 'api', 'rpc', 'agent'],
      ...(options.setup ? { 'projects.prepare': ['ui', 'api', 'rpc', 'agent'] } : {}) } }) }) : undefined;
  const requesterSettings = options.requesterAsk ? AccountSettingsSchema.parse({ actionsSettingsV1: normalizeActionsSettingsV1({
    v: 1, actions: { 'projects.script.run': { approvalRequiredSurfaces: ['api'] } },
  }) }) : accountSettings;
  const processes: NativePty[] = [];
  vi.spyOn(ptyBoundary, 'createNodePtyProvider').mockReturnValue({ spawn(params) {
    const pty = new NativePty(51001 + processes.length, params); processes.push(pty);
    if (params.file === 'sudo') queueMicrotask(() => pty.emit(AGENT_LAUNCH_TERMINAL_READY));
    else if (params.finiteProcess) queueMicrotask(() => pty.execute(params.file,
      typeof params.args === 'string' ? [params.args] : params.args, params.options.cwd, params.options.env));
    return pty;
  } });
  const probeOsProcessGroup = processBoundary.probeProcessGroupLiveness;
  // Only the fake PTY groups are simulated; a real member effect child keeps its OS liveness.
  vi.spyOn(processBoundary, 'probeProcessGroupLiveness').mockImplementation((...args) => {
    const pty = processes.find(candidate => candidate.pid === args[0]);
    return pty ? pty.exited ? 'absent' : 'alive' : probeOsProcessGroup(...args);
  });
  const terminateOsProcessTree = terminationBoundary.terminateProcessTree;
  vi.spyOn(terminationBoundary, 'terminateProcessTree').mockImplementation(async (...args) => {
    const pty = processes.find(candidate => candidate.pid === args[0].pid);
    if (!pty) return await terminateOsProcessTree(...args);
    pty.exit();
  });
  let preparation: ReturnType<typeof createAgentIsolationMemberPreparationBoundary> | undefined;
  let finite: ReturnType<typeof createInstalledProjectFiniteRuntime> | undefined;
  // Machine registration not settled yet: the daemon's real snapshot producer reads no Machine content.
  const unread = options.policyUnread ? readAgentIsolationSnapshot({ metadata: { status: 'locked' }, daemonState: null,
    runtimeId: undefined, platform: 'linux' }) : undefined;
  const agentIsolation = { managedHappierBinaryPath: '/opt/happier/cli/current/happier',
    read: () => unread ? { ...unread, workspaceRoots: nativeOs.home ? [nativeOs.home.workspaceRoot] : [] } : ({ enabled: isolationEnabled, ...(options.legacy ? {} : { memberProvisioning: 'linuxUsersV1' as const }),
      status: isolationEnabled && !options.ownerAgent ? { kind: 'effective' as const, platform: 'linux' as const, agentUser: 'happier-agent' as const }
        : { kind: 'disabled' as const }, workspaceRoots: [...(nativeOs.home ? [nativeOs.home.workspaceRoot] : []),
          ...(nativeOs.sharedHome ? [nativeOs.sharedHome] : [])] }),
    readMember: async (input: Parameters<NonNullable<import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext['readMember']>>[0]) => {
      if (!preparation) throw new Error('Member preparation fixture not ready');
      return preparation.members.read(input);
    },
    prepareMember: async (input: Parameters<NonNullable<import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext['prepareMember']>>[0]) => {
      if (!preparation) throw new Error('Member preparation fixture not ready');
      const ready = await preparation.members.prepare(input);
      if (ready.kind !== 'ready') throw new Error('Reviewed member native preparation refused');
      return ready;
    } };
  const f = await createInstalledFilesystemMachineFixture({ agentIsolation, ...(accountSettings ? { accountSettings } : {}),
    ...(accountId === 'requester' ? { boundSessionId: 'owner-agent' } : {}),
    createProjectFiniteRuntime: (...args) => { if (!finite) throw new Error('Installed finite producer not ready'); return finite(...args); } });
  await seedTestServerProfile({ id: f.serverId, homeId: f.homeServerIdentityId, serverUrl: f.serverHttpBaseUrl });
  await writeStoredCredentialsForServerId(f.serverId, f.bootstrap.credentials);
  if (accountSettings) {
    const previous = getActiveAccountSettingsSnapshot();
    onTestFinished(() => { if (previous) setActiveAccountSettingsSnapshot(previous); else resetActiveAccountSettingsSnapshotForTests(); });
    await bootstrapAccountSettingsContext({ credentials: f.bootstrap.credentials, mode: 'blocking', refresh: 'force', publication: 'active',
      caller: 'installed_finite_fixture' });
  }
  const selected = { kind: 'isolated' as const, separationRequired: accountId !== 'requester', homeServerIdentityId: f.homeServerIdentityId,
    requester: { serverId: f.homeServerIdentityId, accountId, machineId: f.machineId, installationId: f.installation.installationId } };
  const member = deriveAgentIsolationMemberIdentity(selected);
  preparation = createAgentIsolationMemberPreparationBoundary({ activeServerDir: configuration.activeServerDir,
    requesterIdentity: selected, custodianAccountId: 'requester', encryptionMode: 'plain', uid: 2401 });
  if (!options.ownerAgent && !options.cold) for (const step of buildAgentIsolationProvisioningSteps({ requesterIdentity: selected, daemonUsername: 'happier', daemonPrimaryGroup: 'happier',
    binaryPath: agentIsolation.managedHappierBinaryPath })) preparation.installed.add(step.id);
  const backing = join(f.directory, 'native-home'), workspaceBacking = join(f.directory, 'native-workspace');
  await mkdir(backing); await mkdir(workspaceBacking);
  const sharedHome = join(f.directory, 'shared-agent');
  await mkdir(sharedHome);
  nativeOs.sharedHome = sharedHome;
  if (options.finite) {
    await mkdir(join(workspaceBacking, '.happier'));
    const manifest = ProjectManifestV1Schema.parse({ version: 1,
      ...(options.setup ? { workspace: { setup: [{ kind: 'command', command: "printf 'setup-effect' > setup-result.txt" }] } } : {}),
      scripts: { finite: {
      execution: 'primary', source: { kind: 'command', command: "printf 'finite-output\\n'; printf 'useful-member-edit' > finite-result.txt" },
    } } });
    await writeFile(join(workspaceBacking, '.happier/project.json'), JSON.stringify(manifest));
    if (options.nativePackageScript) {
      await writeFile(join(workspaceBacking, 'package.json'), JSON.stringify({ name: 'native-member',
        packageManager: 'yarn@1.22.22', scripts: { dev: "printf 'finite-output\\n'; printf 'useful-member-edit' > finite-result.txt" } }));
      // Installed third-party package tooling is an OS boundary. Supply real
      // metadata/entrypoint as projectNativeSystemIo's installed-tool tests do;
      // the actual resolver, script selection and native launch stay intact.
      const bin = join(f.directory, 'native-bin'), tool = join(f.directory, 'installed-yarn');
      await mkdir(bin); await mkdir(join(tool, 'bin'), { recursive: true });
      const entrypoint = join(tool, 'bin/yarn.cjs');
      await writeFile(join(tool, 'package.json'), JSON.stringify({ name: 'yarn', version: '1.22.22', bin: { yarn: 'bin/yarn.cjs' } }));
      await writeFile(entrypoint, `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== 'run') process.exit(2);
const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts[args[1]];
if (typeof script !== 'string') process.exit(3);
const child = spawn('/bin/sh', ['-c', script], { stdio: 'inherit', env: process.env });
child.on('error', () => { process.exitCode = 4; });
child.on('close', code => { process.exitCode = code ?? 1; });
`, { mode: 0o755 });
      await symlink(entrypoint, join(bin, 'yarn'));
      vi.stubEnv('PATH', [bin, process.env.PATH ?? ''].join(delimiter));
      vi.stubEnv('HAPPIER_JS_RUNTIME_PATH', process.execPath);
    }
  }
  nativeOs.home = { path: member.home, workspaceRoot: member.workspaceRoot, backing, workspaceBacking, uid: 2401 };
  if (!options.ownerAgent && !options.cold) await writeAgentIsolationMemberBinding(configuration.activeServerDir, { ...member, agentUid: 2401, agentGid: 2401 });
  // Open's canonical Account acceptance assigns the Project anchor; an
  // unenriched legacy Workspace row does not model a newly opened Project.
  const accepted = materializeWorkspaceRefForMachineRoot([], { serverId: f.homeServerIdentityId,
    machineId: f.machineId, rootPath: member.workspaceRoot, nowMs: 1, createId: () => 'accepted-member-checkout' });
  const workspace = { serverId: accepted.workspaceRef.serverId, workspaceId: accepted.workspaceRef.id,
    machineId: accepted.workspaceRef.machineId, rootPath: accepted.workspaceRef.rootPath };
  const rows = options.acceptedWorkspace === false ? [] : [createPlainProjectAccountRefRow(accepted.workspaceRef)];
  const finiteInput = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse({ workspace,
    selection: options.nativePackageScript ? { kind: 'native', source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'dev' } }
      : { kind: 'named', name: 'finite' } });
  const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'installed-member-terminal',
    target: { kind: 'machine', machineId: f.machineId }, input: finiteInput });
  const originalGet = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    if (accountSettings && String(url).endsWith('/v2/account/settings')) {
      const settings = options?.headers?.Authorization === `Bearer ${f.bootstrap.credentials.token}` ? accountSettings : requesterSettings;
      return { status: 200, data: { content: { t: 'plain', v: settings }, version: 0 } };
    }
    if (String(url).endsWith('/v1/account/profile')) {
      const authorization = options?.headers?.Authorization;
      return { status: 200, data: { id: typeof authorization === 'string' ? readAccountIdFromToken(authorization.slice(7)) : 'requester' } };
    }
    return originalGet(url, options);
  });
  const originalPost = vi.mocked(axios.post).getMockImplementation()!;
  vi.mocked(axios.post).mockImplementation(async (url, body, options) => {
    if (String(url).endsWith('/admission/verify')) return originalPost(url, body, options);
    if (String(url).endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: f.isHomeCurrent() } };
    const path = new URL(String(url)).pathname;
    // Account topology spends the admitted requester's bearer read port, not
    // the execution root. Effect routes below still require the signed root.
    if (path === '/v1/account/project-rows/read' || path === '/v1/account/project-rows/list') {
      expect(options?.headers?.Authorization).toBe(`Bearer ${account.credentials.token}`);
      return projectAccountRowsReadHttpResponse(rows, String(url), body);
    }
    const token = options?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER];
    const signature = options?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
    if (token !== 'member-terminal-root' || typeof signature !== 'string'
      || options?.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER] !== actionId
      || !verifyExternalActionMachineRequestV1({ publicKey: f.installation.publicKey, signature,
        authorizationToken: token, effectActionId: actionId,
        target: { kind: 'machine', machineId: f.machineId }, installationId: f.installation.installationId,
        requestId: 'installed-member-terminal', method: 'POST', path: new URL(String(url)).pathname, body }))
      throw new Error('Requester row read must use admitted signed HTTP');
    if (String(url).endsWith('/project-trust/read')) return { status: 200, data: { status: 'absent' } };
    if (String(url).endsWith(`${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`)) return { status: 200,
      data: WorkspaceExecutionConfigReadResponseV1Schema.parse({ status: 'absent' }) };
    return projectAccountRowsReadHttpResponse(rows, String(url), body);
  });
  finite = createInstalledProjectFiniteRuntime({ api: { getMachine: async () => { throw new Error('No worker placement expected'); } },
    credentials: f.bootstrap.credentials, externalActionAccountId: 'requester', finiteServerId: f.serverId,
    finiteServerHttpBaseUrl: f.serverHttpBaseUrl, registeredMachineId: f.machineId,
    admission: createProjectWorkerAdmission({ machineId: f.machineId, admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'stored', metadataVersion: 1 }) }),
    nativeIo: createProjectNativeIo({ agentIsolation }), agentIsolation, successHomeDir: f.directory,
    isCurrent: async () => f.isHomeCurrent(), prepareBetween: async () => { throw new Error('No Workspace Sync expected'); },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: f.homeServerIdentityId, machineId: f.machineId }) });
  const ownerAgentOrigin = options.ownerAgent ? { v: 1 as const,
    caller: AgentStartSessionCallerV1Schema.parse({ kind: 'session', sessionId: f.bootstrap.getBoundSessionId(), starterDepth: 0, turnDepth: 0 }),
    sourceTurnId: 'approved-terminal-turn', callerPermissionMode: null, requestId: 'installed-member-terminal' } : undefined;
  const wire = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'member-terminal-root', binding: {
    accountId, custodianAccountId: 'requester', serverIdentityId: f.homeServerIdentityId, machineId: f.machineId,
    installationId: f.installation.installationId, actionId, accountEncryptionMode: 'plain',
    authentication: { kind: 'account', tokenEpoch: 0 }, requestId: 'installed-member-terminal',
    requestEnvelopeDigest: options.finite ? computeExternalActionRequestEnvelopeDigestV1(envelope) : 'a'.repeat(43),
    target: { kind: 'machine', machineId: f.machineId },
    ...(ownerAgentOrigin ? { sessionActionOrigin: ownerAgentOrigin,
      sessionActionSource: { machineId: f.machineId, installationId: f.installation.installationId } } : {}) } });
  const account = await admitRequesterAccountActionContext({ authorization: wire,
    // A present person's ordinary Account click retains its invocation through
    // the same requester projection the installed receiving Action consumes.
    invocation: ownerAgentOrigin
      ? { surface: 'agent', authority: 'account_automation', caller: ownerAgentOrigin.caller }
      : { surface: 'ui', authority: 'present_user', caller: { kind: 'host' } },
    credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null },
    serverId: f.serverId, serverIdentityId: f.homeServerIdentityId, serverHttpBaseUrl: f.serverHttpBaseUrl, isCurrent: async () => f.isHomeCurrent() });
  if (!account) throw new Error('Genuine requester Account admission failed');
  onTestFinished(async () => {
    for (const pty of processes) pty.exit();
    await Promise.all(processes.map(pty => pty.waitForSettlement()));
    await account.dispose();
  });
  const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: account.authorization,
    serverId: f.serverId, serverIdentityId: f.homeServerIdentityId, serverHttpBaseUrl: f.serverHttpBaseUrl,
    target: wire.binding.target, installationId: f.installation.installationId, privateKey: f.installation.privateKey,
    isCurrent: async () => f.isHomeCurrent() });
  if (!authorization) throw new Error('Genuine signed requester projection failed');
  const invoke = (method: string, input: unknown, requesterAccountId: string = accountId, agent = false,
    localActionContext?: RpcLocalActionContext, role: 'manage' | 'use' = accountId === 'requester' ? 'manage' : 'use') => f.rpcHandlerManager.invokeLocal(method, input, {
    ...(localActionContext ? { localActionContext } : {}),
    rpcContext: { callerAuthority: agent ? 'account_automation' : 'present_user',
      ...(requesterAccountId === accountId ? { callerInputAuthorization: authorization } : {}),
      machineAdmission: { actorAccountId: requesterAccountId, custodianAccountId: 'requester', machineId: f.machineId,
        installationId: f.installation.installationId, role, encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => f.isHomeCurrent() } });
  const invokeInstalledTerminal = (method: string, input: unknown, actorAccountId = accountId,
    role: 'manage' | 'use' = accountId === 'requester' ? 'manage' : 'use') => f.invoke(method, input,
    { actorAccountId, role });
  let localAgent: RpcLocalActionContext | undefined;
  if (accountId === 'requester') {
    expect(f.bootstrap.getBoundSessionId()).toBe('owner-agent');
    localAgent = { actionCaller: AgentStartSessionCallerV1Schema.parse({ kind: 'session',
      sessionId: f.bootstrap.getBoundSessionId(), starterDepth: 0, turnDepth: 0 }) };
  }
  const invokeFinite = (requesterAccountId: string = accountId, role: 'manage' | 'use' = accountId === 'requester' ? 'manage' : 'use') => f.rpcHandlerManager.invokeLocal(PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.script.run'], finiteInput,
    { ...(localAgent ? { localActionContext: localAgent } : {}), rpcContext: { callerAuthority: 'present_user',
      callerInputAuthorization: authorization, originalActionEnvelope: envelope,
      ...(localAgent ? { requesterSessionBootstrap: f.bootstrap } : {}),
      machineAdmission: { actorAccountId: requesterAccountId, custodianAccountId: 'requester', machineId: f.machineId,
        installationId: f.installation.installationId, role, encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => f.isHomeCurrent() } });
  const operation = async (operationId: string) => ActionOperationGetV1ResponseSchema.parse(await invoke(ACTION_OPERATION_RPC_METHODS_V1.get,
    { operationId, waitForTerminal: true }));
  const invokeOwnerAgentTerminal = (method: string, input: unknown, actorAccountId: string = accountId) => f.rpcHandlerManager.invokeLocal(method, input,
    { localActionContext: localAgent, rpcContext: { callerAuthority: 'account_automation',
      ...(ownerAgentOrigin ? { sessionActionOrigin: ownerAgentOrigin } : {}),
      callerInputAuthorization: authorization, requesterSessionBootstrap: f.bootstrap,
      machineAdmission: { actorAccountId, custodianAccountId: 'requester', machineId: f.machineId,
        installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => f.isHomeCurrent() } });
  return { ...f, member, workspace, workspaceBacking, sharedHome, accountId, account, finiteInput, rows,
    invokeTerminal: invoke, invokeInstalledTerminal, invokeOwnerAgentTerminal, invokeFinite, operation, processes, preparation };
}

describe.skipIf(process.platform !== 'linux')('installed host-composed member terminal native identity', () => {
  it.each([RPC_METHODS.DAEMON_TERMINAL_ENSURE, RPC_METHODS.DAEMON_TERMINAL_RESTART])('launches the custodian person native CLI login under linuxUsersV1 through %s', async method => {
    const plugins = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.scm.forge.github'] } });
    onTestFinished(() => plugins.dispose());
    const f = await fixture({ accountId: 'requester', acceptedWorkspace: false });
    const opened = await f.invokeInstalledTerminal(method, { terminalKey: 'custodian-provider-login:gh',
      launch: { kind: 'agent_login', agentId: 'happier.scm.forge.github/gh' } });
    expect(opened).toMatchObject({ ok: true, terminalId: expect.any(String) });
    expect(f.processes).toHaveLength(1);
    expect(f.processes[0]?.params.file).toMatch(/(?:^|[/\\])gh(?:\.exe)?$/u);
    expect(f.processes[0]?.params.args).toEqual(['auth', 'login', '--git-protocol', 'https', '--web']);
    expect(f.processes[0]?.frames).toEqual([]);
  });

  it.each([RPC_METHODS.DAEMON_TERMINAL_ENSURE, RPC_METHODS.DAEMON_TERMINAL_RESTART])('refuses a guest terminal through %s while the isolation policy is unread, as Session launch does, and starts nothing', async method => {
    const plugins = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.scm.forge.github'] } });
    onTestFinished(() => plugins.dispose());
    const guest = await fixture({ policyUnread: true, acceptedWorkspace: false });
    const login = { terminalKey: 'provider-login:gh', launch: { kind: 'agent_login', agentId: 'happier.scm.forge.github/gh', launchId: 'device_code' } };
    for (const input of [login, { terminalKey: 'machine-shell' }]) {
      const refused = await guest.invokeInstalledTerminal(method, input);
      // Session launch's refusal for an unread policy: retryable "still starting", never "Manage required".
      expect(refused).toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
      expect(JSON.stringify(refused)).toContain('metadata_unavailable');
    }
    expect(guest.processes).toEqual([]);
  });

  it('opens the owner terminal while the isolation policy is unread', async () => {
    const plugins = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.scm.forge.github'] } });
    onTestFinished(() => plugins.dispose());
    const owner = await fixture({ accountId: 'requester', policyUnread: true, acceptedWorkspace: false });
    expect(await owner.invokeInstalledTerminal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'custodian-provider-login:gh',
      launch: { kind: 'agent_login', agentId: 'happier.scm.forge.github/gh' } })).toMatchObject({ ok: true, terminalId: expect.any(String) });
    expect(owner.processes).toHaveLength(1);
    expect(owner.processes[0]?.frames).toEqual([]);
  });

  it('opens member Agent CLI sign-in with the CLI installed in the member home, not the daemon environment', async () => {
    const plugins = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.opencode'] } });
    onTestFinished(() => plugins.dispose());
    const f = await fixture({ acceptedWorkspace: false });
    // The member-scoped install left OpenCode only in the member's own home.
    const memberBin = join(f.directory, 'native-home', '.opencode', 'bin');
    await mkdir(memberBin, { recursive: true });
    await writeFile(join(memberBin, 'opencode'), '#!/usr/bin/env bash\necho 2.3.0\n', { mode: 0o755 });
    const opened = await f.invokeInstalledTerminal(RPC_METHODS.DAEMON_TERMINAL_ENSURE,
      { terminalKey: 'agent-login:opencode', launch: { kind: 'agent_login', agentId: 'opencode' } });
    expect(opened, JSON.stringify({ opened, memberEffectErrors: nativeOs.memberEffectErrors,
      ptys: f.processes.map(pty => ({ file: pty.params.file, frames: pty.frames.map(frame => frame.executable) })) }))
      .toMatchObject({ ok: true, terminalId: expect.any(String) });
    expect(f.processes[0]?.frames[0]).toMatchObject({ executable: join(memberBin, 'opencode'),
      args: ['auth', 'login'], cwd: f.member.workspaceRoot });
  });

  it.each([['member', 'terminal'], ['member', 'finite'], ['owner', 'terminal']] as const)('prepares admitted %s %s without awaiting display-only status', async (actor, kind) => {
    // Activate daemon-owned SCM before the fixture persists its separate
    // requester Account bearer; plugin startup does not own that credential.
    const plugins = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
    onTestFinished(() => plugins.dispose());
    const f = await fixture({ ...(kind === 'finite' ? { finite: true, setup: true } : {}),
      ...(actor === 'owner' ? { accountId: 'requester' } : {}) });
    const git = promisify(execFile);
    const marker = join(f.directory, 'fsmonitor-executed');
    const hook = join(f.directory, 'fsmonitor-hook');
    await git('git', ['init', '-b', 'main'], { cwd: f.workspaceBacking });
    await git('git', ['-c', 'user.name=Provenance test', '-c', 'user.email=provenance@example.invalid',
      'commit', '--allow-empty', '-m', 'initial'], { cwd: f.workspaceBacking });
    await writeFile(hook, `#!/bin/sh\nprintf 'executed\\n' >> ${JSON.stringify(marker)}\nprintf 'token\\0'\n`, { mode: 0o700 });
    await git('git', ['config', 'core.fsmonitor', hook], { cwd: f.workspaceBacking });
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'safe.directory');
    vi.stubEnv('GIT_CONFIG_VALUE_0', f.workspaceBacking);
    await git('git', ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], { cwd: f.workspaceBacking });
    expect(await readFile(marker, 'utf8')).toContain('executed');
    await rm(marker);
    const commands = vi.spyOn(scmProcess, 'runScmCommand');
    if (kind === 'finite') {
      const accepted = ProjectCommandActionOutputV1Schema.parse(await f.invokeFinite(f.accountId, 'use'));
      expect(await f.operation(accepted.operation.operationId)).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
      expect(await readFile(join(f.workspaceBacking, 'setup-result.txt'), 'utf8')).toBe('setup-effect');
      expect(await readFile(join(f.workspaceBacking, 'finite-result.txt'), 'utf8')).toBe('useful-member-edit');
    } else {
      expect(await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'provenance', workspace: f.workspace },
        f.accountId, false, undefined, actor === 'member' ? 'use' : 'manage'))
        .toMatchObject({ ok: true, terminalId: expect.any(String) });
    }
    if (actor === 'owner') {
      expect(commands.mock.calls.filter(([request]) => request.args.includes('status'))).toHaveLength(0);
    }
    else await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs an admitted Use member package script through its own Account and native Project owner', async () => {
    const f = await fixture({ finite: true, nativePackageScript: true });
    const opened = await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'member-package-script',
      cwd: f.member.workspaceRoot, launch: { kind: 'package_script', runTargetId: 'native-member:dev' } });
    const failure = { errorCode: closedFailureReason(opened, 'errorCode'), error: closedFailureReason(opened, 'error') };
    expect(opened, JSON.stringify(failure)).toMatchObject({ ok: true, terminalId: expect.any(String) });
    expect(f.processes).toHaveLength(1);
    expect(f.processes[0]!.params.args).toEqual(['-n', '-u', f.member.username, '--', '/opt/happier/cli/current/happier', 'agent-launch']);
    await f.processes[0]!.waitForSettlement();
    expect(await readFile(join(f.workspaceBacking, 'finite-result.txt'), 'utf8')).toBe('useful-member-edit');
    expect(f.processes[0]!.frames[0]!.nativeIdentity).toMatchObject({ username: f.member.username, home: f.member.home });
    // The finite operation retires its native lease after the PTY settles; observe it settle before teardown.
    const scope = { accountId: f.accountId, machineId: f.machineId };
    const operations: Pick<HostActionOperationRuntime, 'store'> = Reflect.get(f.machine, 'actionOperationRuntime');
    const scripts = operations.store.list(scope).items.filter(item => item.actionId === 'projects.script.run');
    expect(scripts).toHaveLength(1);
    await f.machine.waitForActionOperationCompletion(scope, scripts[0]!.operationId);
    expect(operations.store.get(scope, scripts[0]!.operationId)).toMatchObject({ state: 'succeeded' });
  });

  it.each(['ensure', 'restart', 'package_script'] as const)('refuses a guest Project terminal %s on another person\'s checkout named by its own WorkspaceRef', async kind => {
    const f = await fixture({ finite: true, nativePackageScript: true });
    // The guest's own Account row names the owner's checkout on the owner's Machine.
    const ownerRoot = join(f.directory, 'owner-checkout');
    await mkdir(join(ownerRoot, '.happier'), { recursive: true });
    await writeFile(join(ownerRoot, '.happier/project.json'), JSON.stringify({ version: 1,
      environmentVariables: [{ name: 'OWNER_PRIVATE', kind: 'config', required: true }] }));
    await writeFile(join(ownerRoot, 'package.json'), JSON.stringify({ name: 'owner-private', scripts: { dev: 'echo owner-private' } }));
    const ref = { id: 'guest-names-owner', serverId: f.workspace.serverId, machineId: f.machineId, rootPath: ownerRoot,
      createdAtMs: 1, projectKey: 'owner-project' };
    f.rows.push(createPlainProjectAccountRefRow(ref));
    nativeOs.ownerRoots = [ownerRoot];
    const workspace = { serverId: ref.serverId, workspaceId: ref.id, machineId: ref.machineId, rootPath: ownerRoot };
    const result = kind === 'package_script'
      ? await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'owner-script', cwd: ownerRoot,
        launch: { kind: 'package_script', runTargetId: 'owner-private:dev' } })
      : await f.invokeTerminal(kind === 'ensure' ? RPC_METHODS.DAEMON_TERMINAL_ENSURE : RPC_METHODS.DAEMON_TERMINAL_RESTART,
        { terminalKey: 'owner-shell', workspace });
    expect(result).toMatchObject({ ok: false, error: 'project_workspace_unavailable' });
    expect(JSON.stringify(result)).not.toContain('owner-private');
    expect(nativeOs.ownerDaemonReads).toEqual([]);
    expect(f.processes).toEqual([]);
  });

  it('refuses a package script before any checkout read when the requester identity is unknown, as Ensure does', async () => {
    const f = await fixture({ finite: true, nativePackageScript: true });
    // No held Home: the requester identity owner cannot place this caller.
    f.setHeldHome(null);
    nativeOs.ownerRoots = [f.member.workspaceRoot];
    const result = await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'unknown-script', cwd: f.workspace.rootPath,
      launch: { kind: 'package_script', runTargetId: 'native-member:dev' } });
    expect(result).toMatchObject({ ok: false, error: 'agent_isolation_unavailable' });
    expect(nativeOs.ownerDaemonReads).toEqual([]);
    expect(f.processes).toEqual([]);
  });

  it('requires the requester Ask for a member script even when the host Account waives approval', async () => {
    const f = await fixture({ finite: true, requesterAsk: true });
    expect(getActiveAccountSettingsSnapshot()?.settings.actionsSettingsV1.approvalWaivedSurfaces?.['projects.script.run']).toContain('api');
    expect(f.account.savedSecretOperationContext.readSnapshot()?.settings.actionsSettingsV1.actions['projects.script.run']?.approvalRequiredSurfaces).toContain('api');
    await expect(f.invokeFinite()).resolves.toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
    expect(f.processes).toEqual([]);
    await expect(access(join(f.workspaceBacking, 'finite-result.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([RPC_METHODS.DAEMON_TERMINAL_ENSURE, RPC_METHODS.DAEMON_TERMINAL_RESTART])('prepares a cold member only at deliberate Shell admission through %s', async method => {
    const f = await fixture({ cold: true, acceptedWorkspace: false });
    const listed = await f.invokeInstalledTerminal(RPC_METHODS.DAEMON_TERMINAL_LIST, { machineShell: true });
    expect(listed).toMatchObject({ ok: true, machineShell: { ok: true, cwd: f.member.workspaceRoot, preparation: 'member_not_prepared' } });
    expect(await readAgentIsolationMemberBindingForAccount({ activeServerDir: configuration.activeServerDir,
      homeServerIdentityId: f.member.homeServerIdentityId, ...f.member.requester }, f.accountId)).toBeNull();
    const opened = await f.invokeInstalledTerminal(method, { terminalKey: 'cold-machine-shell' });
    expect(opened).toMatchObject({ ok: true, terminalId: expect.any(String) });
    expect(await readAgentIsolationMemberBindingForAccount({ activeServerDir: configuration.activeServerDir,
      homeServerIdentityId: f.member.homeServerIdentityId, ...f.member.requester }, f.accountId)).toMatchObject({ uid: 2401 });
    expect(f.processes[0]?.frames[0]?.cwd).toBe(f.member.workspaceRoot);
    expect(await f.invokeInstalledTerminal(RPC_METHODS.DAEMON_TERMINAL_LIST, { machineShell: true })).toMatchObject({ ok: true, machineShell: { ok: true, cwd: f.member.workspaceRoot } });
  });

  it.each((['corrupt', 'foreign'] as const).flatMap(kind => (['use', 'manage'] as const).map(role => [kind, role] as const)))(
    'refuses a %s member binding through Shell availability and Open for a %s grantee', async (kind, role) => {
    const f = await fixture();
    const path = join(configuration.activeServerDir, 'agent-isolation', 'members', `${f.member.digest}.json`);
    const binding = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, kind === 'corrupt' ? '{' : JSON.stringify({ ...binding, accountId: 'foreign-account' }));
    expect(await f.invokeInstalledTerminal(RPC_METHODS.DAEMON_TERMINAL_LIST, { machineShell: true }, f.accountId, role))
      .toMatchObject({ ok: true, machineShell: { ok: false } });
    expect(await f.invokeInstalledTerminal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'invalid-binding' }, f.accountId, role))
      .toMatchObject({ ok: false });
    expect(f.processes).toEqual([]);
  });

  it('requires Manage for a Machine shell when Can use has no isolated member placement', async () => {
    const f = await fixture({ isolationEnabled: false });
    await expect(f.invokeInstalledTerminal(RPC_METHODS.DAEMON_TERMINAL_LIST, { machineShell: true }))
      .resolves.toMatchObject({ ok: true, machineShell: { ok: false, errorCode: 'machine_manage_required' } });
    for (const method of [RPC_METHODS.DAEMON_TERMINAL_ENSURE, RPC_METHODS.DAEMON_TERMINAL_RESTART]) {
      await expect(f.invokeInstalledTerminal(method, { terminalKey: 'use-without-member-shell' }))
        .resolves.toMatchObject({ ok: false, errorCode: 'machine_manage_required' });
    }
    expect(f.processes).toEqual([]);
  });

  it.each([false, true])('offers a requester-rooted Machine shell and admits isolated Use without exposing another Account terminal (Agent=%s)', async agent => {
    const f = await fixture();
    const invokeOwn = (method: string, input: unknown) => agent
      ? f.invokeTerminal(method, input, f.accountId, true, undefined, 'use')
      : f.invokeInstalledTerminal(method, input);
    const available = await invokeOwn(RPC_METHODS.DAEMON_TERMINAL_LIST, { machineShell: true });
    expect(available).toMatchObject({ ok: true, machineShell: { ok: true, cwd: f.member.workspaceRoot } });
    const shell = await invokeOwn(RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'use-machine-shell' });
    expect(shell).toMatchObject({ ok: true, terminalId: expect.any(String) });
    if (!shell || typeof shell !== 'object' || !('terminalId' in shell) || typeof shell.terminalId !== 'string')
      throw new Error('Requester Machine shell refused');
    expect(f.processes[0]!.frames[0]!.cwd).toBe(f.member.workspaceRoot);
    expect(await invokeOwn(RPC_METHODS.DAEMON_TERMINAL_INPUT, { terminalId: shell.terminalId, data: 'own-shell\n' }))
      .toMatchObject({ ok: true });
    expect(await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_INPUT, { terminalId: shell.terminalId, data: 'foreign\n' }, 'member-b'))
      .toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
    for (const cwd of [f.directory, '/var/lib/happier/members/another-account']) {
      expect(await invokeOwn(RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'foreign-root', cwd }))
        .toMatchObject({ ok: false, errorCode: 'terminal_cwd_denied' });
    }
    const opened = await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_ENSURE,
      { terminalKey: 'use-project-shell', workspace: f.workspace }, 'member-a', agent, undefined, 'use');
    expect(opened).toMatchObject({ ok: true, terminalId: expect.any(String) });
    if (!opened || typeof opened !== 'object' || !('terminalId' in opened) || typeof opened.terminalId !== 'string')
      throw new Error('Admitted Use Project terminal refused');
    expect(f.processes[1]!.params.args).toEqual(['-n', '-u', f.member.username, '--', '/opt/happier/cli/current/happier', 'agent-launch']);
    expect(f.processes[1]!.frames[0]!.cwd).toBe(f.member.workspaceRoot);
    expect(await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_INPUT, { terminalId: opened.terminalId, data: 'use-project\n' },
      'member-a', agent, undefined, 'use')).toMatchObject({ ok: true });
    expect(f.processes[1]!.writes).toEqual(['use-project\n']);
  });

  // Owner ruling 2026-11-27: on a Machine that places Agents as separate member
  // users, a Manage grantee's own terminal runs as their member user. The
  // custodian and an isolation-off Machine keep the daemon user.
  it.each([RPC_METHODS.DAEMON_TERMINAL_ENSURE, RPC_METHODS.DAEMON_TERMINAL_RESTART].flatMap(method => ([
    { name: 'Manage grantee, isolation on', accountId: 'member-a', isolationEnabled: true, member: true },
    { name: 'Manage grantee, isolation off', accountId: 'member-a', isolationEnabled: false, member: false },
    { name: 'Machine owner, isolation on', accountId: 'requester', isolationEnabled: true, member: false },
  ] as const).map(c => ({ ...c, method }))))('places an admitted Manage machine shell without an accepted Project: $name through $method', async c => {
    const method = c.method;
    const f = await fixture({ accountId: c.accountId, isolationEnabled: c.isolationEnabled, acceptedWorkspace: false });
    const input = { terminalKey: 'manage-machine-shell' };
    const daemonHome = homedir();
    const cwd = c.member ? f.member.workspaceRoot : daemonHome;
    expect(await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_LIST, { machineShell: true }, f.accountId, false, undefined, 'manage'))
      .toMatchObject({ ok: true, machineShell: { ok: true, cwd } });
    const projectReads = () => vi.mocked(axios.post).mock.calls.filter(([url]) =>
      /\/project-rows\/(?:list|read)$/u.test(new URL(String(url)).pathname)).length;
    const beforeProjectReads = projectReads();
    const opened = await f.invokeTerminal(method, input, f.accountId, false, undefined, 'manage');
    const refusal = { errorCode: closedFailureReason(opened, 'errorCode'), code: closedFailureReason(opened, 'code'),
      error: closedFailureReason(opened, 'error'), processes: f.processes.length };
    expect(opened, JSON.stringify(refusal)).toMatchObject({ ok: true, reused: false, terminalId: expect.any(String) });
    if (!opened || typeof opened !== 'object' || !('terminalId' in opened) || typeof opened.terminalId !== 'string') {
      throw new Error('Admitted Manage machine shell refused');
    }
    const terminalId = opened.terminalId;
    const manager = f.machine.getFiniteTerminalSessions();
    expect(manager?.getCustody(terminalId)).toMatchObject({ kind: 'machine', requesterAccountId: f.accountId,
      machineId: f.machineId, installationId: f.installation.installationId, rootPath: cwd });
    const native = f.processes.find(pty => pty.params.file === 'sudo');
    if (c.member) {
      expect(manager?.getNativeExecutionIdentity?.(terminalId)).toMatchObject({ digest: f.member.digest, agentUid: 2401 });
      expect(native?.params.args).toEqual(['-n', '-u', f.member.username, '--', '/opt/happier/cli/current/happier', 'agent-launch']);
      expect(native?.frames[0]?.nativeIdentity).toEqual({ username: f.member.username, agentUid: 2401, agentGid: 2401, home: f.member.home });
      expect(native?.frames[0]?.cwd).toBe(f.member.workspaceRoot);
    } else {
      expect(manager?.getNativeExecutionIdentity?.(terminalId)).toBeNull();
      expect(native).toBeUndefined();
      expect(f.processes[0]?.params.options.cwd).toBe(daemonHome);
      expect(f.preparation.launches).toEqual([]);
    }
    await expect(f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_INPUT, { terminalId, data: 'manage-machine-work\n' }, f.accountId, false, undefined, 'manage'))
      .resolves.toMatchObject({ ok: true });
    const output = TerminalStreamReadResponseSchema.parse(await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
      { terminalId, byteOffset: 0 }, f.accountId, false, undefined, 'manage'));
    if (!output.ok) throw new Error('Manage machine shell output refused');
    expect(Buffer.concat(output.frames.filter((frame): frame is TerminalStreamBytesFrame => frame.t === 'bytes')
      .map(frame => Buffer.from(decodeTerminalStreamBytesFrame(frame)))).toString()).toContain('ran:manage-machine-work');
    expect(projectReads()).toBe(beforeProjectReads);
    const other = c.accountId === 'requester' ? 'member-a' : 'member-b';
    expect(await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_INPUT, { terminalId, data: 'foreign\n' }, other, false, undefined, 'manage'))
      .toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
  });

  it('refuses a Manage grantee terminal while the isolation policy is unread and starts nothing', async () => {
    const f = await fixture({ policyUnread: true, acceptedWorkspace: false });
    const refused = await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'manage-unread' },
      f.accountId, false, undefined, 'manage');
    expect(refused).toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
    expect(f.processes).toEqual([]);
  });

  it.each(['off', 'legacy', 'linuxUsersV1'] as const)('opens the approved signed owner-Agent terminal and retains control with %s placement', async mode => {
    const f = await fixture({ ownerAgent: true, accountId: 'requester', isolationEnabled: mode !== 'off', ...(mode === 'legacy' ? { legacy: true } : {}) });
    const cwd = f.directory;
    expect(await f.invokeOwnerAgentTerminal(RPC_METHODS.DAEMON_TERMINAL_ENSURE,
      { terminalKey: 'mismatched-original-requester', cwd }, 'member-b'))
      .not.toMatchObject({ ok: true });
    expect(f.processes).toEqual([]);
    // Approval retains Agent authority. This owner's terminal needs no
    // separation from another person, including with unprepared isolation.
    for (const method of [RPC_METHODS.DAEMON_TERMINAL_ENSURE, RPC_METHODS.DAEMON_TERMINAL_RESTART]) {
      const opened = await f.invokeOwnerAgentTerminal(method, { terminalKey: `owner-agent-${mode}`, cwd });
      expect(opened).toMatchObject({ ok: true, terminalId: expect.any(String) });
      if (!opened || typeof opened !== 'object' || !('terminalId' in opened) || typeof opened.terminalId !== 'string')
        throw new Error('Approved owner-Agent terminal did not open');
      expect(await f.invokeOwnerAgentTerminal(RPC_METHODS.DAEMON_TERMINAL_INPUT,
        { terminalId: opened.terminalId, data: 'owner-agent-work\n' })).toMatchObject({ ok: true });
      const output = TerminalStreamReadResponseSchema.parse(await f.invokeOwnerAgentTerminal(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
        { terminalId: opened.terminalId, byteOffset: 0 }));
      if (!output.ok) throw new Error('Owner-Agent terminal output refused');
      expect(Buffer.concat(output.frames.filter((frame): frame is TerminalStreamBytesFrame => frame.t === 'bytes')
        .map(frame => Buffer.from(decodeTerminalStreamBytesFrame(frame)))).toString()).toContain('ran:owner-agent-work');
      expect(await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_INPUT,
        { terminalId: opened.terminalId, data: 'foreign-work\n' }, 'member-b')).not.toMatchObject({ ok: true });
    }
    if (mode === 'linuxUsersV1') {
      const project = await f.invokeOwnerAgentTerminal(RPC_METHODS.DAEMON_TERMINAL_ENSURE,
        { terminalKey: 'owner-agent-project', workspace: f.workspace });
      expect(project).toMatchObject({ ok: true, terminalId: expect.any(String) });
      if (!project || typeof project !== 'object' || !('terminalId' in project) || typeof project.terminalId !== 'string')
        throw new Error('Approved owner-Agent Project terminal did not open');
      expect(await f.invokeOwnerAgentTerminal(RPC_METHODS.DAEMON_TERMINAL_INPUT,
        { terminalId: project.terminalId, data: 'owner-project-work\n' })).toMatchObject({ ok: true });
    }
    expect(f.processes).toHaveLength(mode === 'linuxUsersV1' ? 3 : 2);
    for (const process of f.processes) {
      expect(process.params.file).not.toBe('sudo');
      expect(process.frames).toEqual([]);
    }
    expect(f.preparation.launches).toEqual([]);
    expect(f.preparation.permissionQueries).toEqual([]);
  });

  it.each([
    { accountId: 'member-a' as const, isolationEnabled: true, label: 'mandatory member' },
    { accountId: 'requester' as const, isolationEnabled: true, label: 'explicit Linux template owner-Agent' },
    { accountId: 'requester' as const, isolationEnabled: false, label: 'owner-Agent policy off' },
  ])('runs useful registered finite Project work for $label and retains bytes after physical exit', async ({ accountId, isolationEnabled }) => {
    const f = await fixture({ finite: true, accountId, isolationEnabled });
    const raw = await f.invokeFinite();
    const failure = JSON.stringify({ errorCode: closedFailureReason(raw, 'errorCode'), error: closedFailureReason(raw, 'error'),
      processes: f.processes.length, elevatedLaunches: f.preparation.launches.length, permissionQueries: f.preparation.permissionQueries.length });
    expect(raw, failure).toMatchObject({ operation: { operationId: expect.any(String) } });
    const result = ProjectCommandActionOutputV1Schema.parse(raw);
    const settled = await f.operation(result.operation.operationId);
    expect(settled).toMatchObject({ kind: 'found', operation: { state: 'succeeded', actionId: 'projects.script.run' } });
    expect(await readFile(join(f.workspaceBacking, 'finite-result.txt'), 'utf8')).toBe('useful-member-edit');
    expect(f.processes).toHaveLength(1);
    const pty = f.processes[0]!;
    expect(pty.exited).toBe(true);
    if (isolationEnabled) {
      expect(pty.frames).toHaveLength(1);
      expect(pty.params.args).toEqual(['-n', '-u', f.member.username, '--', '/opt/happier/cli/current/happier', 'agent-launch']);
      expect(pty.params.options.cwd).toBe(process.cwd());
      expect(pty.frames[0]!.nativeIdentity).toEqual({ username: f.member.username, agentUid: 2401, agentGid: 2401, home: f.member.home });
      expect(pty.frames[0]!.cwd).toBe(f.member.workspaceRoot);
      expect(pty.frames[0]!.selectedMaterials).toEqual([]);
      expect(f.preparation.launches).toEqual([]);
      expect(f.preparation.permissionQueries).toEqual([]);
    } else {
      expect(pty.params.file).not.toBe('sudo');
      expect(pty.frames).toEqual([]);
      expect(f.preparation.launches).toEqual([]);
      expect(f.preparation.permissionQueries).toEqual([]);
    }
    const manager = f.machine.getFiniteTerminalSessions();
    const terminal = manager?.list().find(row => row.ended);
    if (!manager || !terminal) throw new Error('Finite PTY physical exit was not retained');
    expect(terminal.cwd).toBe(f.member.workspaceRoot);
    const output = TerminalStreamReadResponseSchema.parse(manager.readByteStream({ terminalId: terminal.terminalId, byteOffset: 0 }));
    if (!output.ok) throw new Error('Finite PTY retained bytes unavailable');
    expect(Buffer.concat(output.frames.filter((frame): frame is TerminalStreamBytesFrame => frame.t === 'bytes')
      .map(frame => Buffer.from(decodeTerminalStreamBytesFrame(frame)))).toString()).toContain('finite-output');
    if (isolationEnabled) expect(manager.getNativeExecutionIdentity?.(terminal.terminalId)).toMatchObject({ digest: f.member.digest, agentUid: 2401 });
  });

  it('refuses foreign requester custody before producing a finite Project native frame', async () => {
    const f = await fixture({ finite: true });
    const refused = await f.invokeFinite('member-b');
    const errorCode = refused && typeof refused === 'object' && 'errorCode' in refused ? refused.errorCode : undefined;
    expect(refused).not.toMatchObject({ ok: true });
    expect([RPC_ERROR_CODES.FORBIDDEN, 'project_finite_execution_unavailable', 'project_requester_credentials_unavailable',
      'project_requester_authorization_unavailable']).toContain(errorCode);
    expect(f.processes).toEqual([]);
    expect(f.preparation.launches).toEqual([]);
    await expect(readFile(join(f.workspaceBacking, 'finite-result.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('preserves the finalized native frame without per-operation readiness probes (unobserved RunAs drift: %s)', async brokenRule => {
    const f = await fixture({ finite: true });
    if (brokenRule) f.preparation.drifted.add('agent-runas');
    const signal = new AbortController().signal;
    const ingress = { signal, callerAuthority: 'present_user' as const,
      machineAdmission: { actorAccountId: f.accountId, custodianAccountId: 'requester', machineId: f.machineId,
        installationId: f.installation.installationId, role: 'use' as const, encryptionMode: 'plain' as const },
      verifyMachineAdmissionCurrent: async () => f.isHomeCurrent() };
    const requesterIdentity = selectHostRequesterExecutionIdentity({ rpcContext: ingress, hostHomeServerIdentityId: f.homeServerIdentityId });
    const manager = f.machine.getFiniteTerminalSessions();
    if (!manager) throw new Error('Installed finite PTY owner unavailable');
    let observedOperationId: string | undefined;
    const observation = f.machine.observeActionExecution({ actionId: 'projects.script.run', onOperation: snapshot => { observedOperationId = snapshot.operationId; },
      input: f.finiteInput, rpcContext: ingress, execute: async operation => {
        const operationId = operation.operationAcceptance?.operationId ?? operation.actionRequestId;
        if (!operationId) throw new Error('Original finite operation identity unavailable');
        const material = Object.freeze({ materializationKey: operationId, environment: Object.freeze({}), selectedMaterials: Object.freeze([]) });
        let live = true;
        const prepared = await f.machine.prepareNativeOperation({ requesterIdentity, requesterAccount: f.account, ingress,
          signal: operation.signal, readMaterial: () => live ? material : undefined,
        });
        let launch: Awaited<ReturnType<typeof authorizeResolvedProjectExecLaunchForHost>> | undefined;
        try {
          launch = await authorizeResolvedProjectExecLaunchForHost({ launch: { command: '/bin/sh',
            args: ['-c', "printf 'finite-frame-output\\n'; printf 'frame-effect' > finite-frame-result.txt"], cwd: f.member.workspaceRoot, env: {} },
            agentIsolation: prepared.agentIsolation, requesterIdentity, signal: operation.signal,
            assertCurrent: () => operation.signal.throwIfAborted() });
          const input = { workspace: { ...f.workspace, id: f.workspace.workspaceId, projectKey: 'project', createdAtMs: 1 },
            purpose: 'script' as const, requesterAccountId: f.accountId, operation, terminalSessions: manager, launch,
            nativeExecutionIdentity: prepared.memberIdentity, terminalCustody: { serverId: f.serverId,
              requesterAccountId: f.accountId, machineId: f.machineId, installationId: f.installation.installationId,
              workspaceRefId: f.workspace.workspaceId, projectKey: 'project', rootPath: f.member.workspaceRoot } };
          return (await executeProjectFiniteProcess(input)).result;
        } finally { live = false; try { await launch?.release(); } finally { await prepared.dispose(); } }
      } });
    // This can fail before waiting for exit: erasing the fixed frame leaves
    // agent-launch waiting, never an interpreted terminal payload or effect.
    await expect.poll(() => f.processes[0]?.frames.length ?? 0).toBe(1);
    expect(f.processes[0]!.params.options.cwd).toBe(process.cwd());
    expect(f.processes[0]!.frames[0]!.cwd).toBe(f.member.workspaceRoot);
    const observed = await observation;
    expect(observed).toMatchObject({ ok: true });
    if (!observedOperationId) throw new Error('Original finite operation was not retained');
    expect(await f.operation(observedOperationId)).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
    expect(await readFile(join(f.workspaceBacking, 'finite-frame-result.txt'), 'utf8')).toBe('frame-effect');
    expect(f.preparation.permissionQueries).toEqual([]);
    expect(f.preparation.launches).toHaveLength(0);
    expect(f.preparation.mutations).toEqual([]);
    const terminal = manager.list().find(row => row.ended);
    if (!terminal) throw new Error('Physical finite exit missing');
    expect(terminal.cwd).toBe(f.member.workspaceRoot);
    expect(manager.getNativeExecutionIdentity?.(terminal.terminalId)).toMatchObject({ digest: f.member.digest, agentUid: 2401 });
  });

  it('admits member Agent Workflow and automation shells through their own prepared native identity', async () => {
    const f = await fixture();
    await expect(f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_LIST, { workspace: f.workspace }))
      .resolves.toMatchObject({ ok: true, terminals: [] });
    const caller = { kind: 'session' as const, sessionId: 'member-agent', starterDepth: 0, turnDepth: 0 };
    const sources: ReadonlyArray<Readonly<{ name: string; agent: boolean; localActionContext?: RpcLocalActionContext }>> = [
      { name: 'automation', agent: true },
      { name: 'session-agent', agent: false, localActionContext: { actionCaller: caller } },
      { name: 'workflow', agent: false, localActionContext: { actionCaller: { kind: 'workflowRun', runId: 'member-workflow',
        authorization: WorkflowAcceptedAuthorizationV1Schema.parse({ admittedPermissionCeiling: 'default',
          principal: { kind: 'session', sessionId: caller.sessionId } }) } } },
    ];
    // Same admitted Account, accepted Workspace and installed native port as
    // the person-positive flow; only the canonical caller provenance changes.
    for (const source of sources) {
      for (const method of [RPC_METHODS.DAEMON_TERMINAL_ENSURE, RPC_METHODS.DAEMON_TERMINAL_RESTART]) {
        const result = await f.invokeTerminal(method, { terminalKey: `fresh-${source.name}-${method}`, workspace: f.workspace },
          'member-a', source.agent, source.localActionContext);
        expect(result, `${source.name}:${method}`).toMatchObject({ ok: true, terminalId: expect.any(String) });
      }
    }
    expect(f.processes).toHaveLength(sources.length * 2);
    for (const process of f.processes) {
      expect(process.params.file).toBe('sudo');
      expect(process.frames).toHaveLength(1);
      expect(process.frames[0]).toMatchObject({ cwd: f.member.workspaceRoot,
        nativeIdentity: { username: f.member.username, agentUid: 2401, agentGid: 2401, home: f.member.home } });
    }
    expect(f.preparation.launches).toEqual([]);
    expect(f.preparation.mutations).toEqual([]);
  // Six Project shells each read the checkout through a real member reader process at this OS boundary.
  }, 120_000);

  it('retains accepted member native custody for person and Agent controls while refusing foreign and legacy PTYs', async () => {
    const f = await fixture();
    // This deliberately bare network control has no admitted Account carrier.
    // Public member Actions supply sealed requester custody before this owner.
    expect(await f.invoke(RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'bare', workspace: f.workspace },
      { actorAccountId: 'member-a' })).toMatchObject({ errorCode: expect.any(String) });
    await expect(f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_LIST, { workspace: f.workspace }))
      .resolves.toMatchObject({ ok: true, terminals: [] });
    const opened = await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'member', workspace: f.workspace });
    // Failure-only assertion context: closed reason tokens and phase counts,
    // never the raw response, authority carrier, material or private paths.
    const details: unknown = opened && typeof opened === 'object' ? Reflect.get(opened, 'details') : undefined;
    const failure = JSON.stringify({ errorCode: closedFailureReason(opened, 'errorCode'), code: closedFailureReason(opened, 'code'),
      error: closedFailureReason(opened, 'error'), detailCode: closedFailureReason(details, 'code'),
      processes: f.processes.length, memberPreparationLaunches: f.preparation.launches.length,
      mutations: f.preparation.mutations.length, nativeIdentityObservations: f.preparation.userObservations() });
    expect(opened, failure).toMatchObject({ ok: true, reused: false, terminalId: expect.any(String) });
    if (!opened || typeof opened !== 'object' || !('terminalId' in opened) || typeof opened.terminalId !== 'string') throw new Error('Installed member ensure refused');
    // Shell admission reviews the environment without running setup or its
    // qualification probes; the native launch below still proves member placement.
    const preparationLaunchCount = f.preparation.launches.length;
    expect(preparationLaunchCount).toBe(0);
    const permissionQueryCount = f.preparation.permissionQueries.length;
    expect(f.preparation.permissionQueries).toEqual([]);
    const terminalId = opened.terminalId;
    await expect(f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_INPUT, { terminalId, data: 'useful-member\n' })).resolves.toMatchObject({ ok: true });
    const output = TerminalStreamReadResponseSchema.parse(await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
      { terminalId, byteOffset: 0 }));
    if (!output.ok) throw new Error('Own native terminal output refused');
    expect(Buffer.concat(output.frames.filter((frame): frame is TerminalStreamBytesFrame => frame.t === 'bytes')
      .map(frame => Buffer.from(decodeTerminalStreamBytesFrame(frame)))).toString()).toContain('ran:useful-member');
    const native = f.processes.find(pty => pty.params.file === 'sudo');
    expect(native?.params.args).toEqual(['-n', '-u', f.member.username, '--', '/opt/happier/cli/current/happier', 'agent-launch']);
    expect(native?.params.options.cwd).toBe(process.cwd());
    expect(native?.frames).toHaveLength(1);
    const frame = native!.frames[0]!;
    expect(frame.nativeIdentity).toEqual({ username: f.member.username, agentUid: 2401, agentGid: 2401, home: f.member.home });
    expect(frame.cwd).toBe(f.member.workspaceRoot);
    expect(frame.runtimeHome.startsWith(`${f.member.home}/runtime/operations/`)).toBe(true);
    expect(frame.selectedMaterials).toEqual([]);
    expect(JSON.stringify(frame)).not.toContain('neighbor-private');
    expect(frame.environment).not.toHaveProperty('HAPPIER_DAEMON_TOKEN');
    const manager = f.machine.getFiniteTerminalSessions();
    if (!manager) throw new Error('Installed terminal inventory missing');
    expect(manager.list().find(row => row.terminalId === terminalId)?.cwd).toBe(f.member.workspaceRoot);
    const shared = await manager.ensure({ terminalKey: 'legacy', cwd: f.member.workspaceRoot,
      custody: { kind: 'machine', serverId: f.serverId, requesterAccountId: 'member-a', machineId: f.machineId,
        installationId: f.installation.installationId, rootPath: f.member.workspaceRoot } });
    if (!shared.ok) throw new Error('Legacy negative fixture failed');
    for (const [id, accountId, agent] of [[terminalId, 'member-b', false], [shared.terminalId, 'member-a', false]] as const)
      expect(await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_INPUT, { terminalId: id, data: 'foreign\n' }, accountId, agent)).not.toMatchObject({ ok: true });
    expect(await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_INPUT,
      { terminalId, data: 'useful-agent\n' }, 'member-a', true)).toMatchObject({ ok: true });
    expect(native!.writes).toEqual(['useful-member\n', 'useful-agent\n']);
    const owner = await f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'owner', cwd: f.directory }, 'requester', false, undefined, 'manage');
    expect(owner).toMatchObject({ ok: true });
    await expect(f.invokeTerminal(RPC_METHODS.DAEMON_TERMINAL_CLOSE, { terminalId })).resolves.toMatchObject({ ok: true });
    expect(native!.exited).toBe(true);
    expect(f.preparation.launches).toHaveLength(preparationLaunchCount);
    expect(f.preparation.permissionQueries).toHaveLength(permissionQueryCount);
    expect(f.preparation.mutations).toEqual([]);
  });
});
