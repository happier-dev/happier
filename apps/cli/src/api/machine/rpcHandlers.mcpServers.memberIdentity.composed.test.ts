import axios from 'axios';
import { mkdir } from 'node:fs/promises';
import type { ChildProcess, ExecFileOptions, SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogV1Schema, McpServerCatalogRowMutationV1Schema,
  McpServerCatalogRowMutationResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { DaemonMcpServersTestResponseSchema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { buildAgentIsolationProvisioningSteps, deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { createAgentIsolationMemberPreparationBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { writeAgentIsolationMemberBinding } from '@/daemon/agentIsolation/memberBindings';
import { configuration } from '@/configuration';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { resolveCliTsxTsconfigPath, resolveTsxImportHookPath } from '@/utils/spawnHappyCLI';
import { projectPath } from '@/projectPath';
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';
import type { RpcHandlerContext } from '@/api/rpc/types';
import '@/api/api';

const os = vi.hoisted(() => ({
  home: undefined as undefined | { path: string; workspaceRoot: string; directory: string; username: string; uid: number },
  spawn: undefined as undefined | ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess | undefined),
  execFile: undefined as undefined | ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess | undefined),
}));

// Genuine native observation and filesystem boundaries. Selector, binding,
// materializer, admission, finite operation, supervisor and MCP transport stay real.
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
    async apply() { throw new Error('MCP Test cannot provision native state'); },
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

// OS virtual-mount substitute: only explicit frame-selected file paths exist.
// Their JSON and the environment pointers are never scanned or rewritten. The
// canonical launcher reads the exact selected bytes and spawns the actual child.
// This is source-boundary proof, not cross-UID/native-shim publication proof.
const nativeWorker = String.raw`
const fs = require('node:fs/promises');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { join } = require('node:path');
let buffered = Buffer.alloc(0);
async function receive(chunk) {
  buffered = Buffer.concat([buffered, chunk]);
  if (buffered.length < 12) return;
  if (buffered.subarray(0, 8).toString() !== 'HAPAGT1\n') throw new Error('frame_invalid');
  const length = buffered.readUInt32BE(8);
  if (buffered.length < 12 + length) return;
  process.stdin.pause(); process.stdin.off('data', receiveChunk);
  const payload = JSON.parse(buffered.subarray(12, 12 + length).toString('utf8'));
  const exactLauncherInvocation = payload.executable === process.env.MCP_TEST_EXPECTED_EXECUTABLE
    && JSON.stringify(payload.args) === process.env.MCP_TEST_EXPECTED_ARGS;
  const files = new Map(payload.selectedMaterials.map(file => [join(payload.runtimeHome, file.relativePath), Buffer.from(file.contentBase64, 'base64')]));
  const read = fs.readFile;
  fs.readFile = async (path, options) => {
    const bytes = files.get(String(path));
    if (!bytes) return read(path, options);
    return options === 'utf8' || options?.encoding === 'utf8' ? bytes.toString('utf8') : Buffer.from(bytes);
  };
  // This fixture's native home is virtual. Preserve the frame and launcher
  // configuration; map only the OS child-spawn cwd to its real backing home.
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => spawn(command, args,
    options?.cwd === payload.nativeIdentity?.home
      ? { ...options, cwd: process.env.MCP_TEST_MEMBER_BACKING_HOME } : options);
  syncBuiltinESMExports();
  process.send({ kind: 'frame', uid: payload.nativeIdentity?.agentUid, username: payload.nativeIdentity?.username,
    exactLauncherInvocation,
    exactLauncherPointer: files.has(payload.environment.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE),
    materialCount: files.size, runtimeHome: payload.runtimeHome });
  if (!exactLauncherInvocation) process.exit(2);
  Object.assign(process.env, payload.environment);
  const remainder = buffered.subarray(12 + length); buffered = Buffer.alloc(0);
  if (remainder.length) process.stdin.unshift(remainder);
  await import(process.env.MCP_TEST_CANONICAL_LAUNCHER);
  setImmediate(() => process.stdin.resume());
}
function receiveChunk(chunk) { void receive(chunk).catch(error => {
  const code = ['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_REQUIRE_ESM', 'ENOENT', 'EACCES']
    .includes(error?.code) ? error.code : error?.name === 'SyntaxError' ? 'SyntaxError' : 'fixture_native_worker_failed';
  const missingExport = String(error?.message ?? '').match(/does not provide an export named '([A-Za-z_$][A-Za-z0-9_$]*)'/)?.[1];
  process.stderr.write(JSON.stringify({ phase: 'fixture_native_frame', code, missingExport }) + '\n');
  process.exit(1);
}); }
process.stdin.on('data', receiveChunk);
`;

const serverProgram = String.raw`
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\n'); if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    const result = request.method === 'initialize' ? { protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'selected-member', version: '1' } }
      : request.method === 'tools/list' ? { tools: [{ name: process.env.MEMBER_TOKEN === 'fixture-member-selected' ? 'member_ready'
        : process.env.MEMBER_TOKEN === 'fixture-owner-selected' ? 'owner_ready' : 'wrong_material', inputSchema: { type: 'object' } }] } : undefined;
    if (request.id !== undefined && result) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  }
});
`;

async function fixture(options: Readonly<{ ownerAgentOff?: boolean; policySnapshotMissing?: true }> = {}) {
  let memberPreparation: ReturnType<typeof createAgentIsolationMemberPreparationBoundary> | undefined;
  const f = await createInstalledFilesystemMachineFixture({
    ...(options.ownerAgentOff ? { boundSessionId: 'owner-agent-mcp' } : {}), agentIsolation: {
    managedHappierBinaryPath: '/opt/happier/cli/current/happier',
    read: () => options.policySnapshotMissing ? undefined : options.ownerAgentOff
      ? { enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }
      : { enabled: true, memberProvisioning: 'linuxUsersV1',
        status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [] },
    readMember: async input => {
      if (!memberPreparation) throw new Error('Native member fixture is not ready');
      return memberPreparation.members.read(input);
    },
    prepareMember: async input => {
      if (!memberPreparation) throw new Error('Native member fixture is not ready');
      const prepared = await memberPreparation.members.prepare(input);
      if (prepared.kind !== 'ready') throw new Error('Native member fixture refused preparation');
      return prepared;
    },
  } });
  const memberToken = `e30.${Buffer.from(JSON.stringify({ sub: 'member-a' })).toString('base64url')}.signature`;
  const secretRef = 'happier:shared-secret:v1:member-selected';
  const catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'member', name: 'member_server', transport: 'stdio',
    stdio: { command: process.execPath, args: ['-e', serverProgram] }, env: { MEMBER_TOKEN: { t: 'savedSecret', secretId: secretRef } },
    createdAt: 1, updatedAt: 1 }], bindings: [] });
  let memberCatalog = catalog;
  let memberCatalogRevision = 3;
  let memberCatalogCommits = 0;
  let ownerCatalog = McpServerCatalogV1Schema.parse(catalog);
  let ownerCatalogRevision = 3;
  let ownerCatalogCommits = 0;
  const homeGet = vi.mocked(axios.get).getMockImplementation();
  const homePost = vi.mocked(axios.post).getMockImplementation();
  if (!homeGet || !homePost) throw new Error('Missing authenticated Home fixture');
  const reads: Array<{ member: boolean; owner: boolean; path: string }> = [];
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    const member = options?.headers?.Authorization === `Bearer ${memberToken}`;
    const owner = options?.headers?.Authorization === `Bearer ${f.bootstrap.credentials.token}`;
    reads.push({ member, owner, path });
    if ((member || owner) && path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) return { status: 200, data: {
      status: 'present', revision: member ? memberCatalogRevision : ownerCatalogRevision, content: { t: 'plain', v: member ? memberCatalog : ownerCatalog },
    } };
    if ((member || owner) && path === '/v1/account/saved-secrets/resources/materials') {
      return { status: 200, data: SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
      resourceId: 'member-selected', encryptionMode: 'plain', recipientEnvelope: null,
      entry: { ref: secretRef, source: 'shared_resource', relationship: 'owner', name: member ? 'Member' : 'Owner', kind: 'token',
        ownerAccountId: member ? 'member-a' : 'requester', revision: 1, materialStatus: 'ready',
        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'member-selected', mode: 'plain',
        content: { v: 1, name: member ? 'Member' : 'Owner', kind: 'token', value: member ? 'fixture-member-selected' : 'fixture-owner-selected' } }),
      }] }) };
    }
    if ((member || owner) && path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    if (!member) return homeGet(url, options);
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'member-a' } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
    return homeGet(url, options);
  });
  vi.mocked(axios.post).mockImplementation(async (url, body, options) => {
    if (new URL(String(url)).pathname !== MCP_SERVER_CATALOG_ROWS_ROUTE_V1) return homePost(url, body, options);
    const member = options?.headers?.Authorization === `Bearer ${memberToken}`;
    const owner = options?.headers?.Authorization === `Bearer ${f.bootstrap.credentials.token}`;
    if (!member && !owner) return { status: 403, data: { error: 'access_denied' } };
    const parsed = McpServerCatalogRowMutationV1Schema.safeParse(body);
    if (!parsed.success) throw new Error('Invalid owner catalog mutation shape');
    const mutation = parsed.data;
    const currentRevision = member ? memberCatalogRevision : ownerCatalogRevision;
    if (mutation.expectedRevision !== currentRevision) return { status: 409,
      data: McpServerCatalogRowMutationResponseV1Schema.parse({ status: 'conflict', revision: currentRevision }) };
    if (mutation.content?.t !== 'plain' || !mutation.referencedSavedSecretIds.includes(secretRef)
      || !mutation.savedSecretRevisions.some(row => row.resourceId === 'member-selected' && row.expectedRevision === 1)) return { status: 400,
      data: McpServerCatalogRowMutationResponseV1Schema.parse({ status: 'invalid-reference' }) };
    if (member) { memberCatalog = mutation.content.v; memberCatalogRevision++; memberCatalogCommits++; }
    else { ownerCatalog = mutation.content.v; ownerCatalogRevision++; ownerCatalogCommits++; }
    const revision = member ? memberCatalogRevision : ownerCatalogRevision;
    return { status: 200, data: McpServerCatalogRowMutationResponseV1Schema.parse({ status: 'updated', revision, cursor: revision }) };
  });
  const features = FeaturesResponseSchema.parse({ features: {}, capabilities: {
    serverIdentity: { serverIdentityId: f.homeServerIdentityId }, connectedServices: { qualifiedAccounts: { protocolVersion: 4 } },
  } });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(features)));
  const account = await admitRequesterAccountActionContext({ credentials: options.ownerAgentOff
    ? f.bootstrap.credentials : { token: memberToken, encryption: null },
    authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-home-mcp-test', binding: {
      accountId: options.ownerAgentOff ? 'requester' : 'member-a', custodianAccountId: 'requester', serverIdentityId: f.homeServerIdentityId,
      machineId: 'machine', installationId: f.installation.installationId, authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', actionId: 'mcp.servers.test', requestId: 'installed-mcp-test', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' },
    } }), serverId: f.serverId, serverIdentityId: f.homeServerIdentityId, serverHttpBaseUrl: f.serverHttpBaseUrl,
    isCurrent: async () => f.isHomeCurrent(),
  });
  if (!account) throw new Error('Real member Account admission failed');
  onTestFinished(() => account.dispose());
  // The admitted owner Account lease must survive a later ambient Account
  // change. Falling back to stored credentials would select member material.
  if (options.ownerAgentOff) await writeStoredCredentialsForServerId(f.serverId, { token: memberToken, encryption: null });
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
  const children: ChildProcess[] = [];
  const frames: Array<{ uid?: number; username?: string; exactLauncherInvocation: boolean;
    exactLauncherPointer: boolean; materialCount: number; runtimeHome: string }> = [];
  const launcherInvocation = await resolveNodeBackedMcpServerCommand({
    distEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.mjs'],
    sourceEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.ts'],
  });
  const actualProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const launcherSource = join(projectPath(), 'src/mcp/launchers/stdioMcpServerLauncher.ts');
  os.spawn = (command, args, options) => {
    if (command !== 'sudo') return undefined;
    expect(args).toEqual(['-n', '-u', identity.username, '--', '/opt/happier/cli/current/happier', 'agent-launch']);
    const hook = resolveTsxImportHookPath();
    if (!hook) throw new Error('Missing source loader');
    const child = actualProcess.spawn(process.execPath, ['--conditions=happier-source', '--import', hook, '-e', nativeWorker],
      { ...options, cwd: projectPath(), env: { ...process.env, TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
        MCP_TEST_CANONICAL_LAUNCHER: launcherSource,
        MCP_TEST_MEMBER_BACKING_HOME: memberDirectory,
        MCP_TEST_EXPECTED_EXECUTABLE: launcherInvocation.command, MCP_TEST_EXPECTED_ARGS: JSON.stringify(launcherInvocation.args),
      }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    children.push(child);
    child.on('message', message => {
      if (message && typeof message === 'object' && 'kind' in message && message.kind === 'frame') {
        // Native bytes never enter a failure renderer: retain only named facts.
        const uid: unknown = Reflect.get(message, 'uid');
        const username: unknown = Reflect.get(message, 'username');
        const materialCount: unknown = Reflect.get(message, 'materialCount');
        const runtimeHome: unknown = Reflect.get(message, 'runtimeHome');
        if (typeof uid !== 'number' || typeof username !== 'string'
          || typeof materialCount !== 'number' || typeof runtimeHome !== 'string') return;
        frames.push({ uid, username,
          exactLauncherInvocation: Reflect.get(message, 'exactLauncherInvocation') === true,
          exactLauncherPointer: Reflect.get(message, 'exactLauncherPointer') === true,
          materialCount, runtimeHome });
      }
    });
    return child;
  };
  onTestFinished(async () => { for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill('SIGKILL'); await closed;
    }
  } });
  const invoke = (options: Readonly<{ actor?: string; signal?: AbortSignal; noAuth?: boolean; ownerById?: boolean; memberById?: boolean; rawMember?: boolean }> = {}) => {
    const signal = options.signal ?? new AbortController().signal;
    const ingress: RpcHandlerContext = { signal, callerAuthority: 'present_user',
      ...(options.noAuth || options.ownerById || options.rawMember ? {} : { callerInputAuthorization: account.authorization }),
      machineAdmission: { actorAccountId: options.actor ?? (options.ownerById ? 'requester' : 'member-a'), custodianAccountId: 'requester', machineId: 'machine',
        installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => f.isHomeCurrent(),
    };
    return f.rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_MCP_SERVERS_TEST,
      options.ownerById || options.memberById ? { t: 'byId', serverId: 'member', machineId: 'machine', directory: f.directory }
        : { t: 'draft', server: options.noAuth ? { ...catalog.servers[0]!, env: {} } : catalog.servers[0]!, binding: null,
          machineId: 'machine', directory: options.noAuth ? f.directory : identity.home }, { signal, rpcContext: ingress });
  };
  return { ...f, invoke, frames, children, reads, account,
    memberSetupLaunches: () => memberPreparation?.launches.length ?? 0,
    memberCatalogState: () => ({ revision: memberCatalogRevision, commits: memberCatalogCommits,
      usefulToolsSnapshot: memberCatalog.servers[0]?.toolsSnapshot?.tools.some(tool => tool.name === 'member_ready') === true }),
    ownerCatalogState: () => ({ revision: ownerCatalogRevision, commits: ownerCatalogCommits,
      usefulToolsSnapshot: ownerCatalog.servers[0]?.toolsSnapshot?.tools.some(tool => tool.name === 'owner_ready') === true
        && typeof ownerCatalog.servers[0]?.toolsSnapshot?.checkedAt === 'number' }),
  };
}

function closedProbeFailure(input: unknown): string {
  const parsed = DaemonMcpServersTestResponseSchema.safeParse(input);
  if (!parsed.success || parsed.data.ok) return '{}';
  const failure = parsed.data;
  const stderr = Reflect.get(failure, 'stderrTail');
  const diagnostic = `${failure.error}\n${typeof stderr === 'string' ? stderr : ''}`;
  // Report only closed causal facts, never a selected secret or native stderr.
  return JSON.stringify({ errorCode: failure.errorCode,
    staleCompiledPolicy: diagnostic.includes('TerminalPresentUserPolicySchema'),
    missingModule: diagnostic.includes('ERR_MODULE_NOT_FOUND'),
    nativePathMissing: diagnostic.includes('ENOENT'),
    connectionClosed: diagnostic.includes('Connection closed') });
}

describe.skipIf(process.platform !== 'linux')('installed Machine MCP requester material and native execution', () => {
  it('uses admitted owner Account catalog resolution with an absent policy snapshot', async () => {
    const f = await fixture({ ownerAgentOff: true, policySnapshotMissing: true });
    const sessionId = f.bootstrap.getBoundSessionId();
    expect(sessionId).toBe('owner-agent-mcp');
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'account_automation',
      requesterSessionBootstrap: f.bootstrap, callerInputAuthorization: f.account.authorization,
      machineAdmission: { actorAccountId: f.bootstrap.attribution.accountId, custodianAccountId: 'requester',
        machineId: f.machineId, installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: () => f.bootstrap.isCurrent(),
      localActionContext: { authority: 'account_automation', surface: 'mcp', actionRequestId: f.account.authorization.binding.requestId,
        actionCaller: { kind: 'session', sessionId: 'owner-agent-mcp', starterDepth: 0, turnDepth: 0 } } };
    // This registered catalog outcome happens before stdio and therefore does
    // not borrow the still-stale compiled launcher to decide policy absence.
    const result = await f.rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_MCP_SERVERS_TEST,
      { t: 'byId', serverId: 'not-configured', machineId: f.machineId, directory: f.directory },
      { signal: context.signal, rpcContext: context, localActionContext: context.localActionContext });
    expect(result).toMatchObject({ ok: false, errorCode: 'server_not_found' });
    const catalogReads = f.reads.filter(read => read.path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1);
    expect(catalogReads.length).toBeGreaterThan(0);
    expect(catalogReads.every(read => read.owner && !read.member)).toBe(true);
    expect(f.frames).toEqual([]);
    expect(f.children).toEqual([]);
  });

  it('refuses an admitted separated member with an absent policy snapshot before native effects', async () => {
    const f = await fixture({ policySnapshotMissing: true });
    expect(f.account.authorization.binding).toMatchObject({ accountId: 'member-a', custodianAccountId: 'requester' });
    await expect(f.invoke()).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    expect(f.frames).toEqual([]);
    expect(f.children).toEqual([]);
  });

  it.each(['draft', 'byId'] as const)('keeps admitted owner Agent %s MCP Test on the daemon when isolation is off with its retained Account material', async kind => {
    const f = await fixture({ ownerAgentOff: true });
    const sessionId = 'owner-agent-mcp';
    expect(f.bootstrap.getBoundSessionId()).toBe(sessionId);
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'account_automation',
      requesterSessionBootstrap: f.bootstrap, callerInputAuthorization: f.account.authorization,
      machineAdmission: { actorAccountId: f.bootstrap.attribution.accountId, custodianAccountId: 'requester',
        machineId: f.machineId, installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: () => f.bootstrap.isCurrent(),
      localActionContext: { authority: 'account_automation', surface: 'mcp', actionRequestId: f.account.authorization.binding.requestId,
        actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } } };
    expect(readRequesterAccountActionContext(context.callerInputAuthorization)).toBe(f.account);
    expect(f.account.authorization.binding).toMatchObject({ accountId: f.bootstrap.attribution.accountId,
      custodianAccountId: 'requester', serverIdentityId: f.bootstrap.homeServerIdentityId,
      machineId: f.machineId, installationId: f.installation.installationId, actionId: 'mcp.servers.test' });
    expect(selectHostRequesterExecutionIdentity({ rpcContext: context,
      hostHomeServerIdentityId: f.homeServerIdentityId, hostCustodianAccountId: 'requester',
      hostExecutionTarget: { machineId: f.machineId, installationId: f.installation.installationId },
      sessionRequester: f.bootstrap.attribution, sessionRequesterHomeServerIdentityId: f.bootstrap.homeServerIdentityId,
      sessionCustodianAccountId: 'requester' })).toEqual({ kind: 'isolated', requester: f.bootstrap.attribution, separationRequired: false });
    const before = f.admissionChecks();
    const result = await f.rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_MCP_SERVERS_TEST,
      kind === 'byId' ? { t: 'byId', serverId: 'member', machineId: f.machineId, directory: f.directory }
        : { t: 'draft', machineId: f.machineId, directory: f.directory, binding: null,
          server: { id: 'owner-agent', name: 'owner_agent', transport: 'stdio',
            stdio: { command: process.execPath, args: ['-e', serverProgram] },
            env: { MEMBER_TOKEN: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:member-selected' } },
            createdAt: 1, updatedAt: 1 } },
      { signal: context.signal, rpcContext: context, localActionContext: context.localActionContext });
    expect(f.admissionChecks() - before).toBe(1);
    expect(result, closedProbeFailure(result)).toMatchObject({ ok: true });
    const parsed = DaemonMcpServersTestResponseSchema.parse(result);
    if (parsed.ok) expect(parsed.tools?.map(tool => tool.name)).toEqual(['owner_ready']);
    expect(f.frames).toHaveLength(0);
    expect(f.children).toHaveLength(0);
    const selectedMaterialReads = f.reads.filter(read => read.path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1
      || read.path === '/v1/account/saved-secrets/resources/materials');
    expect(selectedMaterialReads.length).toBeGreaterThan(0);
    expect(selectedMaterialReads.every(read => read.owner && !read.member)).toBe(true);
    expect(f.memberCatalogState().commits).toBe(0);
    if (kind === 'byId') expect(f.ownerCatalogState()).toEqual({ revision: 4, commits: 1, usefulToolsSnapshot: true });
  });

  it.each(['draft', 'byId'] as const)('preserves useful owner %s MCP discovery through the installed registered receiver', async kind => {
    const f = await fixture();
    const result = await f.invoke(kind === 'byId' ? { ownerById: true } : { actor: 'requester', noAuth: true });
    const parsed = DaemonMcpServersTestResponseSchema.safeParse(result);
    expect(parsed.success && parsed.data.ok, closedProbeFailure(result)).toBe(true);
    if (parsed.success && parsed.data.ok) expect(parsed.data.tools?.map(tool => tool.name))
      .toContain(kind === 'byId' ? 'owner_ready' : 'wrong_material');
    expect(f.frames).toHaveLength(0);
    if (kind === 'byId') expect(f.ownerCatalogState()).toEqual({ revision: 4, commits: 1, usefulToolsSnapshot: true });
  });

  it.each(['draft', 'byId'] as const)('discovers useful member %s MCP with requester-selected secrets through the native owner', async kind => {
    const f = await fixture();
    const result = await f.invoke(kind === 'byId' ? { memberById: true } : {}).catch((error: unknown) => {
      // The incumbent registered refusal is the intended missing-behavior RED.
      // Unexpected fixture, module or private-custody failures still escape.
      if (error instanceof PluginError && error.code === 'agent_isolation_unavailable'
        && error.details?.reason === 'agent_launch_kind_unavailable' && error.details?.launchKind === 'mcp_stdio')
        return { errorCode: error.code };
      throw error;
    });
    expect(result, closedProbeFailure(result)).toMatchObject({ ok: true });
    const parsed = DaemonMcpServersTestResponseSchema.parse(result);
    if (parsed.ok) expect(parsed.tools?.map(tool => tool.name)).toContain('member_ready');
    expect(f.frames).toHaveLength(1);
    expect(f.frames[0]?.uid).toBe(2401);
    expect(f.frames[0]?.exactLauncherInvocation).toBe(true);
    expect(f.frames[0]?.exactLauncherPointer).toBe(true);
    expect(f.frames[0]?.materialCount).toBe(1);
    const secretReads = f.reads.filter(read => read.path === '/v1/account/saved-secrets/resources/materials');
    expect(secretReads.length > 0 && secretReads.every(read => read.member && !read.owner)).toBe(true);
    if (kind === 'byId') {
      expect(f.memberCatalogState()).toEqual({ revision: 4, commits: 1, usefulToolsSnapshot: true });
      expect(f.ownerCatalogState().commits).toBe(0);
    }
    expect(f.children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  });
});
