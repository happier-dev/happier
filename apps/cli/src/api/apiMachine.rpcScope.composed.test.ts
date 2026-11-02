import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Server, type Socket as ServerSocket } from 'socket.io';
import { io } from 'socket.io-client';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { RPC_METHODS, resolveSocketRpcSessionAuthorization } from '@happier-dev/protocol/rpc';
import { SessionTransferRpcMethodV1Schema, SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { RpcHandlerContext, RpcRequest } from './rpc/types';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { ApiMachineClient } from './apiMachine';
import { registerMachineDiagnosticsRpcHandlers } from './machine/rpcHandlers.diagnostics';
import { configuration } from '@/configuration';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createManagedConnectionSupervisor, DEFAULT_MANAGED_CONNECTION_POLICY } from '@happier-dev/connection-supervisor';
import { callSocketRpc, createHappierSocket } from '@happier-dev/sync-client';
import { createDeferred } from '@/testkit/async/deferred';
import { logger } from '@/ui/logger';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createActionExecutor, getActionSpec } from '@happier-dev/protocol/actions';
import { ActionsSettingsV1Schema, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { accountSettingsParse } from '@happier-dev/protocol';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { authorizeMachineRpcRequest } from './machine/machineRpcAuthorization';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createScmBackendRegistry } from '@/scm/registry';
import { WorkflowAcceptedAuthorizationV1Schema } from '@happier-dev/protocol/workflows';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { createDirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import { prepareWorkspaceFileExport } from '@/machines/transfer/prepareWorkspaceFileExport';
import { DaemonTerminalEnsureResponseSchema, DaemonTerminalStreamReadResponseSchema } from '@happier-dev/protocol/daemon/terminal';
import { TerminalStreamReadResponseSchema, decodeTerminalStreamBytesFrame } from '@happier-dev/protocol/terminal/stream';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createInstalledMachineRpcDatabaseBoundary, createInstalledMachineRpcRelay } from '@/daemon/testkit/installedMachineRpcRelay.testkit';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createLanguageServerHost } from '@/lsp/languageServerHost';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { registerLanguageIntelligenceHandlers } from '@/rpc/handlers/languageIntelligence';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createProductionDaemonWorkspaceSyncRuntime } from '@/daemon/startup/createProductionDaemonWorkspaceSyncRuntime';
import { createDaemonWorkspaceSyncRuntime } from '@/daemon/startup/createDaemonWorkspaceSyncRuntime';
import { registerMachineWorkspaceSyncRpcHandlers } from '@/api/machine/rpcHandlers.workspaceSync';
import { readProjectAccountRows, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createPlainProjectAccountRefRow, mockProjectAccountRowsHttpBoundary, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import axios from 'axios';
import { updateSettings, readStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { registerProjectOpenRpcHandlers } from '@/rpc/handlers/projects/registerProjectOpenRpcHandlers';
import { ProjectAccountRowV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { getFirstPartyComponentCatalogEntry, resolveFirstPartyInstallLayout, resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { readAgentIsolationNativeIdentity } from '@/daemon/agentIsolation/agentIsolationNativeIdentity';
import { observeAgentIsolationNativeReadiness } from '@/daemon/agentIsolation/agentIsolationReadiness';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createWorkspaceSyncPeerIdentityValidator } from '@/workspaces/sync/transport/workspaceSyncPeerIdentity';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createMachineSetupNativeBackend } from '@happier-dev/cli-common/machineSetup';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

const installedDatabase = vi.hoisted(() => ({ current: null as ReturnType<typeof createInstalledMachineRpcDatabaseBoundary> | null }));
const nativeDiffBoundary = vi.hoisted(() => ({ executable: null as string | null, logPath: null as string | null }));

vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
        path === nativeDiffBoundary.executable || actual.existsSync(path) };
});
vi.mock('child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('child_process')>();
    return { ...actual, spawn: (command: string, args: readonly string[] = [], options?: import('child_process').SpawnOptions) => {
        if (command !== nativeDiffBoundary.executable) return actual.spawn(command, args, options);
        // Substitute the third-party executable at the OS boundary. Argument
        // construction, child ownership, file reads and transport stay real.
        return actual.spawn(process.execPath, ['-e', "const fs = require('node:fs'); const [before, after] = process.argv.slice(-2); const a = fs.readFileSync(before, 'utf8'); const b = fs.readFileSync(after, 'utf8'); fs.appendFileSync(process.env.HAPPIER_TEST_DIFF_LOG, 'native-diff-complete\\n'); process.stdout.write(a === b ? '' : a + b);", '--', ...args],
            { ...options, env: { ...options?.env, HAPPIER_TEST_DIFF_LOG: nativeDiffBoundary.logPath ?? '' } });
    } };
});

// Persistence is the boundary: exercise the actual server registration and machine-availability policy.
vi.mock('../../../server/sources/storage/db', () => ({
    db: {
        machine: {
            findFirst: async (...args: Parameters<ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']['machine']['findFirst']>) =>
                installedDatabase.current ? installedDatabase.current.db.machine.findFirst(...args) : ({ revokedAt: null, replacedByMachineId: null }),
            // An owned predecessor Machine uses the retained carrier without
            // an installation proof; this suite tests method scope registration.
            findUnique: async (...args: Parameters<ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']['machine']['findUnique']>) =>
                installedDatabase.current ? installedDatabase.current.db.machine.findUnique(...args)
                    : ({ id: 'machine-1', kind: 'persistent', accountId: 'account-1', installationId: null }),
            findMany: async (...args: Parameters<ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']['machine']['findMany']>) => {
                if (!installedDatabase.current) throw new Error('Installed Home database fixture is unavailable');
                return installedDatabase.current.db.machine.findMany(...args);
            },
        },
        $transaction: async <T>(operation: (tx: ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db']) => Promise<T>) => {
            if (!installedDatabase.current) throw new Error('Installed Home database fixture is unavailable');
            return installedDatabase.current.db.$transaction(operation);
        },
    },
    getDbProviderFromEnv: () => 'postgres',
}));

// Resolve the server during collection, before the socket lifecycle's test deadline.
// The dynamic path preserves the server's Vitest alias without compiling it under CLI aliases.
const serverModulePath = '../../../server/sources/app/api/socket/rpc/registerSocketRpcHandlers';
const { registerSocketRpcHandlers }: {
    registerSocketRpcHandlers: (params: Readonly<{ userId: string; socket: ServerSocket; io: Server }>) => void;
} = await import(serverModulePath);
const forwarderModulePath = '../../../server/sources/app/api/socket/rpc/forwardRpcCall';
const { forwardRpcCall }: {
    forwardRpcCall: (params: Readonly<{
        io: Server; targetUserId: string; method: string; callParams: unknown; traceId: string; timeoutMs: null;
        machineAdmission?: RpcRequest['machineAdmission']; callerAuthority?: RpcRequest['callerAuthority'];
    }>) => Promise<unknown>;
} = await import(forwarderModulePath);

async function readNativePrerequisiteAccess(path: string, mode: number): Promise<'absent' | 'access_denied' | null> {
    try { await access(path, mode); return null; }
    catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code === 'ENOENT') return 'absent';
        if (code === 'EACCES') return 'access_denied';
        throw error;
    }
}

describe('installed Machine filesystem requester custody', () => {
    it('preserves observed native RunAs and credentialed owner SCM through Home CALL without daemon hook effects', async context => {
        if (process.platform !== 'linux') return context.skip('Native RunAs requires the provisioned Linux identity');
        // getent distinguishes an absent key (exit 2) from a broken lookup.
        // The identity owner intentionally projects both as unavailable, which
        // alone is not evidence that this test's native prerequisite is absent.
        const account = spawnSync('getent', ['--service=files', 'passwd', 'happier-agent'], { encoding: 'utf8' });
        if (account.error) throw account.error;
        if (account.status === 2 && account.stdout.trim() === '') return context.skip('Native prerequisite: files/passwd happier-agent key is absent (getent exit 2)');
        expect(account.status, 'The native account lookup must settle successfully before identity admission').toBe(0);
        const identity = await readAgentIsolationNativeIdentity();
        const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', channel: resolveManagedCliReleaseChannelSync().ringId });
        const installedCli = join(layout.currentPath, getFirstPartyComponentCatalogEntry('happier-cli').binaryRelativePath);
        const binaryAccess = await readNativePrerequisiteAccess(installedCli, fsConstants.X_OK);
        if (binaryAccess) {
            return context.skip(`Native prerequisite: canonical managed Happier CLI ${binaryAccess}`);
        }
        const workspaceAccess = await readNativePrerequisiteAccess('/srv/happier', fsConstants.W_OK | fsConstants.X_OK);
        if (workspaceAccess) {
            return context.skip(`Native prerequisite: provisioned /srv/happier Workspace root ${workspaceAccess}`);
        }
        const root = await mkdtemp('/srv/happier/m-cov-scm-');
        onTestFinished(() => rm(root, { recursive: true, force: true }));
        await chmod(root, 0o2770);
        runScmExecutable(root, 'git', ['init', '--shared=group']);
        runScmExecutable(root, 'git', ['config', 'user.email', 'native-owner@example.test']);
        runScmExecutable(root, 'git', ['config', 'user.name', 'Native Owner']);
        const nativeWorkspace = await createMachineSetupNativeBackend().observe({ id: 'native-scm-workspace',
            kind: 'workspaceAccess', path: root, group: 'happier-workspace', agentUsername: 'happier-agent' });
        if (nativeWorkspace.status !== 'satisfied') {
            return context.skip(`Native exact-Workspace enrollment prerequisite: ${nativeWorkspace.status}; this test cannot provision Git trust or groups`);
        }
        const status = await observeAgentIsolationNativeReadiness({ installedCli, roots: [root], privateRoots: [] });
        expect(status).toEqual({ kind: 'effective', platform: 'linux', agentUser: 'happier-agent' });
        const f = await createInstalledFilesystemMachineFixture({ agentIsolation: { read: () => ({ enabled: true, status, workspaceRoots: [root] }) } });
        const runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: f.directory, controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.scm.backend.git'],
                agentIsolation: { read: () => ({ enabled: true, status, workspaceRoots: [root] }) } } });
        onTestFinished(() => runtime.dispose());
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        await writeFile(join(root, 'owned.txt'), 'native-scm-owner');
        runScmExecutable(root, 'git', ['add', 'owned.txt']);
        const hookUid = join(root, 'hook-uid');
        const disclosure = join(root, 'disclosed-private-material');
        const privateMaterial = join(f.directory, 'custodian-private-material');
        await writeFile(privateMaterial, 'private-custodian-content', { mode: 0o600 });
        await writeFile(join(root, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\nset -eu\nid -u > ${quote(hookUid)}\nif test -r ${quote(privateMaterial)}; then cat ${quote(privateMaterial)} > ${quote(disclosure)}; fi\n`, { mode: 0o775 });
        // The installed catalog owns backend activation and the native command
        // port. Do not replace it with a hand-wired backend/runner fixture.
        registerScmHandlers(f.rpcHandlerManager, root, { machineId: 'machine' });
        installedDatabase.current = createInstalledMachineRpcDatabaseBoundary({ machineId: 'machine', ownerAccountId: 'requester',
            installation: f.installation, members: [{ accountId: 'member-use', accessLevel: 'view' }, { accountId: 'member-manage', accessLevel: 'admin' }] });
        onTestFinished(() => { installedDatabase.current = null; });
        const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager, machineId: 'machine',
            transportOwnerAccountId: 'requester', ui: { installation: f.installation }, methods: [RPC_METHODS.SCM_COMMIT_CREATE, RPC_METHODS.SCM_REMOTE_PUSH] });
        const remote = join(f.directory, 'remote.git');
        await mkdir(remote);
        runScmExecutable(remote, 'git', ['init', '--bare']);
        let authenticatedRequests = 0;
        const authorization = `Basic ${Buffer.from('native-owner:synthetic-scm-token').toString('base64')}`;
        const server = createServer((request, response) => {
            if (request.headers.authorization !== authorization) {
                response.writeHead(401, { 'www-authenticate': 'Basic realm="Native SCM"' }).end(); return;
            }
            authenticatedRequests++;
            const advertise = request.method === 'GET' && request.url?.includes('service=git-receive-pack');
            response.writeHead(200, { 'content-type': advertise ? 'application/x-git-receive-pack-advertisement' : 'application/x-git-receive-pack-result' });
            if (advertise) response.write('001f# service=git-receive-pack\n0000');
            const child = spawn('git', ['receive-pack', '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), remote], { stdio: ['pipe', 'pipe', 'pipe'] });
            child.stdout.pipe(response); child.stderr.resume();
            child.once('error', error => response.destroy(error)); child.once('close', () => response.end());
            if (advertise) child.stdin.end(); else request.pipe(child.stdin);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing native SCM HTTP endpoint');
        const url = `http://127.0.0.1:${address.port}/repository.git`;
        runScmExecutable(root, 'git', ['remote', 'add', 'origin', url]);
        const credentials = join(f.directory, 'git-credentials');
        const config = join(f.directory, 'gitconfig');
        await writeFile(credentials, url.replace('http://', 'http://native-owner:synthetic-scm-token@') + '\n', { mode: 0o600 });
        await writeFile(config, `[credential]\n\thelper = store --file=${quote(credentials)}\n`, { mode: 0o600 });
        const gitEnvironment = createEnvKeyScope(['GIT_CONFIG_GLOBAL']);
        gitEnvironment.patch({ GIT_CONFIG_GLOBAL: config });
        onTestFinished(() => gitEnvironment.restore());
        try {
            const commit = { cwd: root, message: 'Native owner commit' };
            for (const actorAccountId of ['member-use', 'member-manage', 'foreign-account']) {
                expect(await relay.invokeUi(RPC_METHODS.SCM_COMMIT_CREATE, commit, { actorAccountId })).toHaveProperty('errorCode');
            }
            expect(await access(hookUid).then(() => true, () => false)).toBe(false);
            await expect(relay.invokeUi(RPC_METHODS.SCM_COMMIT_CREATE, commit)).resolves.toMatchObject({ success: true });
            // P11 permits fixed host overrides to disable a hook entirely, or
            // executing it as the actual Agent. Neither permits daemon code.
            const observedHookUid = await readFile(hookUid, 'utf8').catch(error => {
                if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
                throw error;
            });
            if (observedHookUid !== null) expect(observedHookUid.trim()).toBe(String(identity.agentUid));
            expect(await access(disclosure).then(() => true, () => false)).toBe(false);
            const branch = runScmExecutable(root, 'git', ['branch', '--show-current']);
            const head = runScmExecutable(root, 'git', ['rev-parse', 'HEAD']);
            await expect(relay.invokeUi(RPC_METHODS.SCM_REMOTE_PUSH, { cwd: root, remote: 'origin', branch })).resolves.toMatchObject({ success: true });
            expect(authenticatedRequests).toBeGreaterThan(0);
            expect(runScmExecutable(remote, 'git', ['rev-parse', `refs/heads/${branch}`])).toBe(head);
            const requestsAfterOwner = authenticatedRequests;
            for (const actorAccountId of ['member-use', 'member-manage', 'foreign-account']) {
                expect(await relay.invokeUi(RPC_METHODS.SCM_REMOTE_PUSH, { cwd: root, remote: 'origin', branch }, { actorAccountId })).toHaveProperty('errorCode');
            }
            expect(authenticatedRequests).toBe(requestsAfterOwner);
            expect(await readFile(privateMaterial, 'utf8')).toBe('private-custodian-content');
        } finally { await relay.close(); await f.machine.shutdown(); }
    });
    it('accepts an owner Project through Home CALL and the canonical row writer without member acceptance', async () => {
        const f = await createInstalledFilesystemMachineFixture();
        const directory = join(f.directory, 'project-open-owner');
        const memberDirectory = join(f.directory, 'project-open-member');
        await mkdir(directory); await mkdir(memberDirectory);
        await writeFile(join(directory, 'owner.txt'), 'owner-project-native-directory');
        const home = f.homeServerIdentityId;
        await updateSettings(current => ({ ...current, activeServerId: f.serverId, servers: { ...current.servers,
            [f.serverId]: { id: f.serverId, name: 'Project fixture Home', serverUrl: f.serverHttpBaseUrl, webappUrl: f.serverHttpBaseUrl,
                createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
                homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: home,
                    canonicalServerUrl: f.serverHttpBaseUrl, revision: 1, endpoints: [{ kind: 'https', url: f.serverHttpBaseUrl }] }) } } }));
        await writeStoredCredentialsForServerId(f.serverId, f.bootstrap.credentials);
        const getHome = vi.mocked(axios.get).getMockImplementation();
        const postHome = vi.mocked(axios.post).getMockImplementation();
        if (!getHome || !postHome) throw new Error('Missing authenticated Home HTTP boundary');
        const rows: unknown[] = [];
        const rowBoundary = mockProjectAccountRowsHttpBoundary(rows);
        const rowTransport = rowBoundary.getMockImplementation();
        if (!rowTransport) throw new Error('Missing canonical Project row HTTP boundary');
        vi.mocked(axios.get).mockImplementation(getHome);
        rowBoundary.mockImplementation(async (url, body, options) => String(url).includes('/project-rows/')
            ? rowTransport(url, body, options) : postHome(url, body, options));
        onTestFinished(() => withdrawActiveProjectAccountRowsSnapshot());
        registerProjectOpenRpcHandlers(f.rpcHandlerManager, { serverId: f.serverId, machineId: 'machine', runtime: {
            serverId: f.serverId, serverHttpBaseUrl: f.serverHttpBaseUrl, machineId: 'machine', accountId: 'requester',
            readCredentials: () => readStoredCredentialsForServerId(f.serverId),
        } });
        installedDatabase.current = createInstalledMachineRpcDatabaseBoundary({ machineId: 'machine', ownerAccountId: 'requester',
            installation: f.installation, members: [{ accountId: 'member-use', accessLevel: 'view' }, { accountId: 'member-manage', accessLevel: 'admin' }] });
        onTestFinished(() => { installedDatabase.current = null; });
        const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager, machineId: 'machine',
            transportOwnerAccountId: 'requester', ui: { installation: f.installation }, methods: [RPC_METHODS.PROJECTS_OPEN] });
        try {
            await expect(relay.invokeUi(RPC_METHODS.PROJECTS_OPEN, { serverId: home, machineId: 'machine',
                source: { kind: 'folder', path: directory }, materialization: { kind: 'attach' } })).resolves.toMatchObject({
                kind: 'opened', directory, workspace: { serverId: home, machineId: 'machine', rootPath: directory }, setup: 'notRequired',
            });
            const acceptedRows = rows.map(row => ProjectAccountRowV1Schema.parse(row));
            const workspaceRows = acceptedRows.filter(row => row.key.kind === 'workspace-ref');
            const graphRows = acceptedRows.filter(row => row.key.kind === 'relationship-graph');
            expect(acceptedRows).toHaveLength(2);
            expect(workspaceRows).toHaveLength(1);
            expect(workspaceRows[0]).toMatchObject({ key: { kind: 'workspace-ref', serverId: home },
                content: { t: 'plain', v: { value: { machineId: 'machine', rootPath: directory } } } });
            expect(graphRows).toHaveLength(1);
            expect(graphRows[0]).toMatchObject({ key: { kind: 'relationship-graph' },
                content: { t: 'plain', v: { value: { relationships: [] } } } });
            const accepted = JSON.stringify(rows);
            for (const actorAccountId of ['member-use', 'member-manage', 'foreign-account']) {
                const refused = await relay.invokeUi(RPC_METHODS.PROJECTS_OPEN, { serverId: home, machineId: 'machine',
                    source: { kind: 'folder', path: memberDirectory }, materialization: { kind: 'attach' } }, { actorAccountId });
                expect(refused).toHaveProperty('errorCode');
                expect(refused).not.toHaveProperty('workspace');
            }
            expect(JSON.stringify(rows)).toBe(accepted);
            expect(await readFile(join(directory, 'owner.txt'), 'utf8')).toBe('owner-project-native-directory');
        } finally { await relay.close(); await f.machine.shutdown(); }
    });
    for (const mode of ['without engine', 'with native engine'] as const) {
    it(`retains real Workspace Sync root custody and owner bytes through Home CALL without member disclosure (${mode})`, async context => {
        const binaries = { manager: process.env.HAPPIER_MUTAGEN_LIVE_MANAGER_BIN,
            agent: process.env.HAPPIER_MUTAGEN_LIVE_AGENT_BIN, custody: process.env.HAPPIER_PROCESS_CUSTODY_LIVE_BIN };
        const native = mode === 'with native engine';
        if (native) {
            // Consume the existing real-engine recipe's source-built binaries,
            // never substitute a fixture which implements the engine protocol.
            const missing: string[] = [];
            for (const [name, path] of Object.entries(binaries)) {
                if (!path?.trim()) { missing.push(`${name}:not_configured`); continue; }
                const unavailable = await readNativePrerequisiteAccess(path, fsConstants.X_OK);
                if (unavailable) missing.push(`${name}:${unavailable}`);
            }
            if (missing.length) return context.skip(`Native Workspace Sync prerequisites unavailable: ${missing.join(', ')}`);
        }
        const f = await createInstalledFilesystemMachineFixture();
        const syncEnvironment = createEnvKeyScope(['MUTAGEN_DATA_DIRECTORY']);
        syncEnvironment.patch({ MUTAGEN_DATA_DIRECTORY: undefined });
        onTestFinished(() => syncEnvironment.restore());
        const source = join(f.directory, 'sync-source');
        const destination = join(f.directory, 'sync-destination');
        await mkdir(source); await mkdir(destination);
        await writeFile(join(source, 'owned.txt'), 'owner-workspace-sync-content');
        await writeFile(join(destination, 'owned.txt'), 'owner-workspace-sync-content');
        const policyInput = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const contentPolicy = { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) };
        const home = f.homeServerIdentityId;
        const relationship = { v: 1 as const, relationshipId: 'owner-sync-relationship', controllerMachineId: 'machine',
            alphaWorkspaceRefId: 'source', betaWorkspaceRefId: 'destination', mode: 'keep_both_in_sync' as const,
            enabled: true, contentPolicy, createdAtMs: 1, updatedAtMs: 1 };
        const graphKey = { kind: 'relationship-graph' as const };
        const rows = [createPlainProjectAccountRefRow({ id: 'source', serverId: home, machineId: 'machine', rootPath: source, createdAtMs: 1 }),
            createPlainProjectAccountRefRow({ id: 'destination', serverId: home, machineId: 'machine', rootPath: destination, createdAtMs: 1 }),
            { key: graphKey, revision: 1, content: { t: 'plain', v: { key: graphKey, value: { relationships: [relationship] } } } }];
        const postHome = vi.mocked(axios.post).getMockImplementation();
        if (!postHome) throw new Error('Missing authenticated Home HTTP boundary');
        vi.mocked(axios.post).mockImplementation(async (url, body, options) => {
            if (String(url).endsWith('/project-rows/list') || String(url).endsWith('/project-rows/read')) {
                return projectAccountRowsReadHttpResponse(rows, String(url), body);
            }
            return postHome(url, body, options);
        });
        await readProjectAccountRows({ credentials: f.bootstrap.credentials, serverId: home, publication: 'installed' });
        onTestFinished(() => withdrawActiveProjectAccountRowsSnapshot());
        const runtime = await createProductionDaemonWorkspaceSyncRuntime({ happyHomeDir: f.directory,
            activeServerDir: join(f.directory, 'sync-state'), activeServerId: home,
            localMachineId: 'machine', releaseChannel: 'stable', credentials: f.bootstrap.credentials, isCurrent: f.isHomeCurrent }, {
            createDaemonRuntime: dependencies => createDaemonWorkspaceSyncRuntime({ ...dependencies, ...(native ? {
                resolveInstalledComponentPaths: () => ({ currentPath: binaries.manager!, resolvedCurrentPath: null }),
                resolveArtifactPaths: () => ({ managerPath: binaries.manager!, agentPath: binaries.agent! }),
                assertArtifactPayload: () => ({ engineVersion: 'source-built-mutagen-iroh-production-composed', protocolEpoch: 'external-stream-v1' }),
            } : {
                // Package acquisition is an external system boundary. Target
                // file custody must remain useful when its optional engine is absent.
                resolveInstalledComponentPaths: () => ({ currentPath: join(f.directory, 'absent-mutagen-engine'), resolvedCurrentPath: null }),
                ensureInstalledComponent: async () => { throw Object.assign(new Error('Fixture has no sync engine package'), { code: 'engine_unavailable' }); },
            }),
            }),
            ...(native ? { createPeerIdentityValidator: () => createWorkspaceSyncPeerIdentityValidator({ resolveExecutable: () => binaries.custody! }) } : {}),
        });
        onTestFinished(() => runtime.stop());
        registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: f.rpcHandlerManager, service: runtime.workspaceSync });
        installedDatabase.current = createInstalledMachineRpcDatabaseBoundary({ machineId: 'machine', ownerAccountId: 'requester',
            installation: f.installation, members: [{ accountId: 'member-use', accessLevel: 'view' }, { accountId: 'member-manage', accessLevel: 'admin' }] });
        onTestFinished(() => { installedDatabase.current = null; });
        const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager, machineId: 'machine',
            transportOwnerAccountId: 'requester', ui: { installation: f.installation },
            methods: [RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE, RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ,
                RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH] });
        try {
            // This fixture seeds the definition but has never bootstrapped it.
            // Match the canonical new-target producer, not receipt-less reentry.
            await expect(relay.invokeUi(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE, {
                v: 1, bootstrapOperationId: relationship.relationshipId, owner: { kind: 'relationship', relationshipId: relationship.relationshipId },
                transientRelationship: relationship,
                targetWorkspaceRefId: 'destination', endpointRole: 'beta', policyDigest: contentPolicy.policyDigest,
                targetBootstrap: 'use_existing', createIfMissing: false,
            })).resolves.toMatchObject({ state: 'ready' });
            const request = { relationshipId: relationship.relationshipId, workspaceRefId: 'destination', path: 'owned.txt', maxBytes: 1024 };
            await expect(relay.invokeUi(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ, request))
                .resolves.toMatchObject({ status: 'text', text: 'owner-workspace-sync-content' });
            for (const actorAccountId of ['member-use', 'member-manage', 'foreign-account']) {
                const refused = await relay.invokeUi(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ, request, { actorAccountId });
                expect(refused).toHaveProperty('errorCode');
                expect(refused).not.toHaveProperty('text');
                expect(JSON.stringify(refused)).not.toContain('owner-workspace-sync-content');
                const flush = await relay.invokeUi(RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH, { relationshipId: relationship.relationshipId }, { actorAccountId });
                expect(flush).toHaveProperty('errorCode');
                expect(flush).not.toHaveProperty('status');
            }
            if (native) {
                await writeFile(join(source, 'native-owner-copy.txt'), 'bytes-copied-by-native-sync-engine');
                await expect(relay.invokeUi(RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH, { relationshipId: relationship.relationshipId }))
                    .resolves.toMatchObject({ status: { relationshipId: relationship.relationshipId, state: 'watching' } });
                await expect.poll(() => readFile(join(destination, 'native-owner-copy.txt'), 'utf8'))
                    .toBe('bytes-copied-by-native-sync-engine');
            }
            expect(await readFile(join(source, 'owned.txt'), 'utf8')).toBe('owner-workspace-sync-content');
        } finally { await relay.close(); await runtime.stop(); await f.machine.shutdown(); }
    });
    }
    it('runs native difftastic output for the admitted owner through Home CALL and refuses member process launch', async () => {
            const f = await createInstalledFilesystemMachineFixture();
            installedDatabase.current = createInstalledMachineRpcDatabaseBoundary({ machineId: 'machine', ownerAccountId: 'requester',
                installation: f.installation, members: [{ accountId: 'member-use', accessLevel: 'view' },
                    { accountId: 'member-manage', accessLevel: 'admin' }] });
            onTestFinished(() => { installedDatabase.current = null; });
            const before = join(f.directory, 'before.txt');
            const after = join(f.directory, 'after.txt');
            await writeFile(before, 'owner_before_native_diff\n');
            await writeFile(after, 'owner_after_native_diff\n');
            nativeDiffBoundary.executable = resolveCliRuntimeAssetPath('tools', 'unpacked', process.platform === 'win32' ? 'difft.exe' : 'difft');
            nativeDiffBoundary.logPath = join(f.directory, 'native-diff.log');
            onTestFinished(() => { nativeDiffBoundary.executable = null; nativeDiffBoundary.logPath = null; });
            const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager, machineId: 'machine',
                transportOwnerAccountId: 'requester', ui: { installation: f.installation }, methods: [RPC_METHODS.DIFFTASTIC] });
            try {
                const request = { args: ['--color=never', '--display=inline', before, after], cwd: f.directory };
                await expect(relay.invokeUi(RPC_METHODS.DIFFTASTIC, request)).resolves.toMatchObject({ success: true,
                    stdout: expect.stringContaining('owner_after_native_diff') });
                expect(await readFile(nativeDiffBoundary.logPath!, 'utf8')).toBe('native-diff-complete\n');
                for (const actorAccountId of ['member-use', 'member-manage', 'foreign-account']) {
                    const refused = await relay.invokeUi(RPC_METHODS.DIFFTASTIC, request, { actorAccountId });
                    expect(refused).toHaveProperty('errorCode');
                    expect(refused).not.toHaveProperty('stdout');
                    expect(refused).not.toHaveProperty('stderr');
                    expect(JSON.stringify(refused)).not.toContain('owner_before_native_diff');
                    expect(JSON.stringify(refused)).not.toContain('owner_after_native_diff');
                }
                expect(await readFile(nativeDiffBoundary.logPath!, 'utf8')).toBe('native-diff-complete\n');
                expect(f.admissionChecks()).toBeGreaterThan(0);
            } finally { await relay.close(); await f.machine.shutdown(); }
        });
    it('produces owner admission from Home resource facts before native LSP output and refuses delegated members', async () => {
        const f = await createInstalledFilesystemMachineFixture();
        const messagesPath = join(f.directory, 'native-lsp-messages.jsonl');
        await writeFile(messagesPath, '');
        const registry = createResolvedContributionRegistry({ languageServers: [{ provenance: 'external', source: { kind: 'path' },
            pluginId: 'fixture', identity: { pluginId: 'fixture', localId: 'owner' }, manifestPath: join(f.directory, 'plugin.json'),
            definition: { id: 'owner', title: 'Owner LSP', languageIds: { typescript: 'typescript' },
                filePatterns: ['**/*.ts'], executable: { kind: 'systemTool', id: 'fixture-server' }, args: [],
                initializationOptions: { disablePushDiagnostics: true } } }] });
        const host = createLanguageServerHost({ readCurrentContributionRegistry: () => registry,
            async openProtocol(input) {
                // Executable resolution is the native process boundary. The
                // catalog, LSP protocol, supervisor and document owner stay real.
                const service = createStablePluginExecService({
                    signal: input.signal, processOwner: input.processOwner, isOccurrenceCurrent: () => !input.signal.aborted,
                    resolveExecutable: async () => ({ command: process.execPath,
                        args: [resolve('src/lsp/__fixtures__/languageServer.cjs'), messagesPath,
                            JSON.stringify({ disablePushDiagnostics: true })] }), resolvePath: async () => f.directory });
                return service.clients.spawn({ kind: 'jsonRpc', framing: 'contentLength', cancellationMethod: '$/cancelRequest',
                    launch: { executable: input.definition.executable, cwd: f.directory } });
            } });
        registerLanguageIntelligenceHandlers(f.rpcHandlerManager, f.directory, { host, machineId: 'machine',
            effectAdmission: createFilesystemEffectAdmission({
                resolveHomeServerIdentityId: async () => f.isHomeCurrent() ? f.homeServerIdentityId : null,
                resolveHostIdentity: async () => ({ custodianAccountId: 'requester', machineId: 'machine',
                    installationId: f.installation.installationId }),
            }) });
        installedDatabase.current = createInstalledMachineRpcDatabaseBoundary({ machineId: 'machine', ownerAccountId: 'requester',
            installation: f.installation, members: [{ accountId: 'member-use', accessLevel: 'view' },
                { accountId: 'member-manage', accessLevel: 'admin' }] });
        onTestFinished(() => { installedDatabase.current = null; });
        const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager, machineId: 'machine',
            transportOwnerAccountId: 'requester', ui: { installation: f.installation },
            methods: [RPC_METHODS.DAEMON_LSP_SYNC, RPC_METHODS.DAEMON_LSP_QUERY,
                RPC_METHODS.DAEMON_LSP_WATCH, RPC_METHODS.DAEMON_LSP_RESTART] });
        const requests = [
            [RPC_METHODS.DAEMON_LSP_SYNC, { rootPath: f.directory, op: { op: 'open',
                path: 'owner.ts', languageId: 'typescript', version: 1,
                text: 'owner-only-document', unsaved: false } }],
            [RPC_METHODS.DAEMON_LSP_QUERY, { rootPath: f.directory, path: 'owner.ts', kind: 'hover',
                position: { line: 0, character: 1 } }],
            [RPC_METHODS.DAEMON_LSP_WATCH, { rootPath: f.directory }],
            [RPC_METHODS.DAEMON_LSP_RESTART, { rootPath: f.directory }],
        ] as const;
        try {
            await expect(relay.invokeUi(...requests[0])).resolves.toMatchObject({ status: 'ok' });
            const hovered = await relay.invokeUi(...requests[1]);
            expect(hovered).toMatchObject({ status: 'ok', kind: 'hover' });
            expect(JSON.stringify(hovered)).toContain('owner-only-document');
            const beforeQuery = f.admissionChecks();
            await expect(f.invoke(...requests[1])).resolves.toMatchObject({ status: 'ok', kind: 'hover' });
            expect(f.admissionChecks() - beforeQuery).toBe(1);
            await expect(relay.invokeUi(...requests[2])).resolves.toMatchObject({ status: 'ok',
                servers: [expect.objectContaining({ state: 'ready' })] });
            const nativeMessages = await readFile(messagesPath, 'utf8');
            for (const actorAccountId of ['member-use', 'member-manage', 'foreign-account']) {
                for (const [method, params] of requests) {
                    const refused = await relay.invokeUi(method, params, { actorAccountId });
                    expect(refused).toHaveProperty('errorCode');
                    expect(refused).not.toHaveProperty('servers');
                    expect(refused).not.toHaveProperty('diagnostics');
                    expect(refused).not.toHaveProperty('symbols');
                    expect(JSON.stringify(refused)).not.toContain('owner-only-document');
                }
            }
            expect(await readFile(messagesPath, 'utf8')).toBe(nativeMessages);
            await expect(relay.invokeUi(...requests[3])).resolves.toMatchObject({ status: 'ok' });
            expect(f.admissionChecks()).toBeGreaterThan(0);
        } finally { await relay.close(); await host.dispose(); await f.machine.shutdown(); }
    });
    it.runIf(process.platform !== 'win32')('keeps listed symlinks confined and reports typed path denials through installed Machine ingress', async () => {
        const f = await createInstalledFilesystemMachineFixture();
        const actionsSettings = setActionApprovalOverride({ settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
            actionId: 'daemon.filesystem.writeFile', surface: 'rpc', approvalRequired: false });
        const executor = createCliActionExecutor({ token: f.bootstrap.credentials.token, credentials: f.bootstrap.credentials,
            sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: f.serverId,
            serverIdentityId: f.homeServerIdentityId, serverHttpBaseUrl: f.serverHttpBaseUrl,
            actionsSettingsProvider: createActionSettingsProvider({
                accountSettings: accountSettingsParse({ actionsSettingsV1: actionsSettings }), allowEnvironmentOverride: false,
            }),
            filesystemActionExecute: f.machine.createFilesystemActionExecutor(f.serverId) });
        f.machine.setRPCHandlers({ spawnSession: async () => { throw new Error('No Session spawn expected'); },
            stopSession: async () => true, requestShutdown() {} }, { externalActionIngressOwner: {
            currentServerId: f.serverId,
            executor: { execute: (id, input, context) => executor.execute(id, input, { ...context, serverId: f.serverId, actionsSettings }) },
            resolveTarget: async () => ({ kind: 'machine', machineId: 'machine' }),
        } });
        const rootPath = join(f.directory, 'explicit-root');
        const outside = join(f.directory, 'outside-root');
        await mkdir(rootPath);
        await mkdir(outside);
        await writeFile(join(rootPath, 'regular.txt'), 'ordinary-owner-file');
        await writeFile(join(outside, 'private.txt'), 'synthetic-outside-file', { mode: 0o600 });
        await symlink(join(outside, 'private.txt'), join(rootPath, 'outside-link'));
        await symlink(outside, join(rootPath, 'outside-directory'));
        const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager, machineId: 'machine',
            transportOwnerAccountId: 'account-1', methods: ['daemon.filesystem.readFile', 'daemon.filesystem.writeFile', RPC_METHODS.LIST_DIRECTORY,
                'daemon.filesystem.getDirectoryTree', RPC_METHODS.READ_FILE] });
        const invoke = (method: string, params: unknown, callerAuthority: 'present_user' | 'account_automation',
            actorAccountId = 'requester', role: 'use' | 'manage' = 'manage') => relay.invoke(method, params, {
                callerAuthority, machineAdmission: { actorAccountId, custodianAccountId: 'requester', machineId: 'machine',
                    installationId: f.installation.installationId, role, encryptionMode: 'plain' },
            });
        try {
            for (const authority of ['present_user', 'account_automation'] as const) {
                await expect(invoke(RPC_METHODS.LIST_DIRECTORY, { rootPath, path: '.' }, authority)).resolves.toMatchObject({
                    success: true, entries: expect.arrayContaining([expect.objectContaining({ name: 'outside-link', type: 'other' })]),
                });
                await expect(invoke('daemon.filesystem.readFile', { rootPath, path: 'regular.txt' }, authority)).resolves.toMatchObject({
                    success: true, content: Buffer.from('ordinary-owner-file').toString('base64'),
                });
                await expect(invoke('daemon.filesystem.writeFile', { rootPath, path: 'owner-write.txt',
                    content: Buffer.from('ordinary-owner-write').toString('base64') }, authority)).resolves.toMatchObject({ success: true });
                expect(await readFile(join(rootPath, 'owner-write.txt'), 'utf8')).toBe('ordinary-owner-write');
                for (const [method, path] of [['daemon.filesystem.readFile', 'outside-link'], [RPC_METHODS.READ_FILE, 'outside-link'],
                    ['daemon.filesystem.writeFile', 'outside-link'],
                    [RPC_METHODS.LIST_DIRECTORY, 'outside-directory'], ['daemon.filesystem.getDirectoryTree', 'outside-directory']] as const) {
                    const result = await invoke(method, { rootPath, path, ...(method.endsWith('getDirectoryTree') ? { maxDepth: 1 } : {}),
                        ...(method.endsWith('writeFile') ? { content: Buffer.from('rejected-write').toString('base64') } : {}) }, authority);
                    expect(result).toMatchObject({ success: false, errorCode: 'access_denied' });
                    expect(result).not.toHaveProperty('content');
                    expect(result).not.toHaveProperty('entries');
                    expect(result).not.toHaveProperty('tree');
                }
                expect(await readFile(join(outside, 'private.txt'), 'utf8') === 'synthetic-outside-file').toBe(true);
                // Listing the original link does not widen the requested extent.
                const widened = await invoke('daemon.filesystem.readFile', { rootPath: f.directory,
                    path: join(rootPath, 'outside-link') }, authority);
                expect(typeof widened === 'object' && widened !== null && 'success' in widened && widened.success === true).toBe(true);
                expect(typeof widened === 'object' && widened !== null && 'content' in widened
                    && widened.content === Buffer.from('synthetic-outside-file').toString('base64')).toBe(true);
                for (const method of ['daemon.filesystem.readFile', RPC_METHODS.READ_FILE] as const) {
                    const result = await invoke(method, { rootPath: f.directory, path: join(outside, 'private.txt') }, authority, 'member', 'use');
                    expect(result).toMatchObject({ success: true, content: Buffer.from('synthetic-outside-file').toString('base64') });
                }
            }
        } finally {
            await relay.close();
            await f.machine.shutdown();
        }
    });
    it('allows Manage diagnostics through the server forwarder while refusing Use', async () => {
        const f = await createInstalledFilesystemMachineFixture();
        const stackDirectory = join(f.directory, 'synthetic-stack');
        const logsDirectory = join(stackDirectory, 'logs');
        await mkdir(logsDirectory, { recursive: true });
        const logPath = join(logsDirectory, 'runner.log');
        const runtimePath = join(stackDirectory, 'stack.runtime.json');
        const marker = 'OWNER_RELAY_DIAGNOSTIC_FIXTURE';
        await writeFile(logPath, marker, { mode: 0o600 });
        await writeFile(runtimePath, JSON.stringify({ fixture: marker, logs: { runner: logPath } }), { mode: 0o600 });
        // The real collector must read only this test's Stack context, never
        // the executor's ambient managed Stack runtime or logs.
        const env = createEnvKeyScope(['HAPPIER_STACK_STACK', 'HAPPIER_STACK_ENV_FILE', 'HAPPIER_STACK_RUNTIME_STATE_PATH']);
        env.patch({ HAPPIER_STACK_STACK: 'synthetic-owner-relay', HAPPIER_STACK_ENV_FILE: join(stackDirectory, 'stack.env'),
            HAPPIER_STACK_RUNTIME_STATE_PATH: runtimePath });
        onTestFinished(() => env.restore());
        const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager, machineId: 'machine',
            transportOwnerAccountId: 'account-1', methods: [RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS, RPC_METHODS.BUGREPORT_GET_LOG_TAIL] });
        const invoke = (method: string, params: unknown, actorAccountId = 'requester', role: 'use' | 'manage' = 'manage') =>
            relay.invoke(method, params, { callerAuthority: 'present_user',
                machineAdmission: { actorAccountId, custodianAccountId: 'requester', machineId: 'machine',
                    installationId: f.installation.installationId, role, encryptionMode: 'plain' } });
        try {
            await expect(invoke(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS, {})).resolves.toMatchObject({
                runtime: { platform: process.platform, nodeVersion: process.version },
                stackContext: { stackName: 'synthetic-owner-relay', runtimeStatePath: runtimePath,
                    runtimeState: expect.stringContaining(marker), logCandidates: expect.arrayContaining([logPath]) },
            });
            await expect(invoke(RPC_METHODS.BUGREPORT_GET_LOG_TAIL, { path: logPath })).resolves.toMatchObject({ ok: true, tail: marker });
            for (const [method, params] of [[RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS, {}],
                [RPC_METHODS.BUGREPORT_GET_LOG_TAIL, { path: logPath }]] as const) {
                const result = await invoke(method, params, 'member', 'use');
                expect(result).toMatchObject({ errorCode: 'agent_isolation_unavailable' });
                expect(result).not.toMatchObject({ ok: true });
                expect(result).not.toHaveProperty('stackContext');
                expect(result).not.toHaveProperty('tail');
                expect(JSON.stringify(result)).not.toContain(marker);
            }
            await expect(invoke(RPC_METHODS.BUGREPORT_GET_LOG_TAIL, { path: logPath }, 'member', 'manage'))
                .resolves.toMatchObject({ ok: true, tail: marker });
            f.retire();
            const withdrawn = await invoke(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS, {});
            expect(withdrawn).toHaveProperty('errorCode');
            expect(withdrawn).not.toHaveProperty('stackContext');
            expect(JSON.stringify(withdrawn)).not.toContain(marker);
            expect(f.admissionChecks()).toBeGreaterThan(0);
        } finally {
            await relay.close();
            await f.machine.shutdown();
        }
    });
    it('trusts Home socket admission once while direct ingress still verifies Home', async () => {
        const f = await createInstalledFilesystemMachineFixture();
        const path = join(f.directory, 'socket-admitted-read.txt');
        await writeFile(path, 'admitted-owner-content');
        const method = 'machine:daemon.filesystem.readFile';
        const http = createServer();
        const sockets = new Server(http, { path: '/v1/updates/' });
        sockets.on('connection', socket => {
            socket.data = { clientType: 'machine-scoped', machineId: 'machine' };
            void socket.join(`rpc:requester:${method}`);
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback socket endpoint');
        const transport = createHappierSocket({ endpoint: `http://127.0.0.1:${address.port}`,
            token: 'test-token', clientType: 'machine-scoped', machineId: 'machine' });
        Reflect.set(f.machine, 'activeTransportGeneration', 1);
        Reflect.set(f.machine, 'socket', transport.socket);
        const install: unknown = Reflect.get(f.machine, 'installSocketEventHandlers');
        if (typeof install !== 'function') throw new Error('Missing installed Machine socket listener');
        Reflect.apply(install, f.machine, [transport.socket, 1]);
        try {
            await transport.transport.connect();
            const before = f.admissionChecks();
            await expect(forwardRpcCall({ io: sockets, targetUserId: 'requester', method,
                callParams: { rootPath: f.directory, path }, traceId: 'admit-once', timeoutMs: null,
                callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester',
                    machineId: 'machine', installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' },
            })).resolves.toMatchObject({ ok: true, result: { success: true, content: Buffer.from('admitted-owner-content').toString('base64') } });
            expect(f.admissionChecks() - before).toBe(0);
            await expect(f.invoke('daemon.filesystem.readFile', { rootPath: f.directory, path }))
                .resolves.toMatchObject({ success: true });
            expect(f.admissionChecks() - before).toBe(1);
            // A transported field cannot impersonate the host-private source argument.
            const forgedDirectRequest = {
                method, params: { rootPath: f.directory, path }, callerAuthority: 'present_user',
                machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'machine',
                    installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' },
                machineAdmissionVerifiedByHome: true,
            } satisfies RpcRequest & Readonly<{ machineAdmissionVerifiedByHome: true }>;
            await expect(f.rpcHandlerManager.handleRequest(forgedDirectRequest)).resolves.toMatchObject({ success: true });
            expect(f.admissionChecks() - before).toBe(2);
            f.retire();
            await expect(f.rpcHandlerManager.handleRequest(forgedDirectRequest)).resolves.toHaveProperty('errorCode');
            expect(f.admissionChecks() - before).toBe(3);
        } finally {
            await transport.transport.destroy();
            await f.machine.shutdown();
            await new Promise<void>(resolve => sockets.close(() => resolve()));
        }
    });
    it('rejects a client-supplied Machine admission before the Home forwards private reads', async () => {
        const f = await createInstalledFilesystemMachineFixture();
        const path = join(f.directory, 'forged-admission.txt');
        await writeFile(path, 'private-forgery-control');
        installedDatabase.current = createInstalledMachineRpcDatabaseBoundary({ machineId: 'machine', ownerAccountId: 'requester',
            installation: f.installation });
        onTestFinished(() => { installedDatabase.current = null; });
        const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager, machineId: 'machine',
            transportOwnerAccountId: 'requester', ui: { installation: f.installation }, methods: ['daemon.filesystem.readFile'] });
        try {
            const before = f.admissionChecks();
            const response = await relay.invokeUiRaw('daemon.filesystem.readFile', { rootPath: f.directory, path }, {
                machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'machine',
                    installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' },
            });
            expect(response).toHaveProperty('errorCode');
            expect(response).not.toHaveProperty('content');
            expect(JSON.stringify(response)).not.toContain('private-forgery-control');
            expect(f.admissionChecks()).toBe(before);
        } finally { await relay.close(); await f.machine.shutdown(); }
    });
    it('verifies range reads once at admission and permits admitted Manage', async () => {
        const f = await createInstalledFilesystemMachineFixture();
        const path = join(f.directory, 'admitted-range.bin');
        const bytes = Buffer.alloc(1024 * 1024, 79);
        await writeFile(path, bytes);
        const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager, machineId: 'machine',
            transportOwnerAccountId: 'account-1', methods: ['daemon.filesystem.readFile'] });
        const invoke = (actorAccountId: string) => relay.invoke('daemon.filesystem.readFile',
            { rootPath: f.directory, path, offset: 0, length: bytes.length }, { callerAuthority: 'present_user',
                machineAdmission: { actorAccountId, custodianAccountId: 'requester', machineId: 'machine',
                    installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' } });
        try {
            const before = f.admissionChecks();
            await expect(invoke('requester')).resolves.toMatchObject({
                success: true, content: bytes.toString('base64'), sizeBytes: bytes.length, eof: true,
            });
            expect(f.admissionChecks() - before).toBe(1);
            await expect(invoke('member')).resolves.toMatchObject({ success: true, content: bytes.toString('base64') });
            f.retire();
            await expect(invoke('requester')).resolves.not.toMatchObject({ success: true });
        } finally {
            await relay.close();
            await f.machine.shutdown();
        }
    });
    it('allows admitted file access with isolation disabled through the server forwarder', async () => {
        const f = await createInstalledFilesystemMachineFixture();
        const terminalEnv = createEnvKeyScope(['HAPPIER_DAEMON_TERMINAL_SHELL', 'NODE_REPL_HISTORY']);
        terminalEnv.patch({ HAPPIER_DAEMON_TERMINAL_SHELL: process.execPath, NODE_REPL_HISTORY: join(f.directory, 'terminal-history') });
        onTestFinished(() => terminalEnv.restore());
        const rootPath = join(f.directory, 'relay-workspace');
        await mkdir(rootPath);
        const path = join(rootPath, 'private-source.txt');
        await writeFile(path, 'owner-private-relay-fixture', { mode: 0o600 });
        const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager, machineId: 'machine',
            transportOwnerAccountId: 'account-1', methods: ['daemon.filesystem.readFile', RPC_METHODS.READ_FILE, RPC_METHODS.WRITE_FILE,
                RPC_METHODS.STAT_FILE, RPC_METHODS.CAPABILITIES_DETECT,
                RPC_METHODS.DAEMON_TERMINAL_ENSURE, RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT,
                RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES, RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
                RPC_METHODS.DAEMON_TERMINAL_RESIZE, RPC_METHODS.DAEMON_TERMINAL_CLOSE] });
        const invoke = (method: string, params: unknown, actorAccountId = 'requester', role: 'use' | 'manage' = 'manage') =>
            relay.invoke(method, params, { callerAuthority: 'present_user',
                machineAdmission: { actorAccountId, custodianAccountId: 'requester', machineId: 'machine',
                    installationId: f.installation.installationId, role, encryptionMode: 'plain' } });
        try {
            await expect(invoke('daemon.filesystem.readFile', { rootPath, path }))
                .resolves.toMatchObject({ success: true, content: Buffer.from('owner-private-relay-fixture').toString('base64') });
            const replacement = { path, content: Buffer.from('updated-owner-relay-fixture').toString('base64') };
            await expect(invoke(RPC_METHODS.WRITE_FILE, replacement)).resolves.toMatchObject({ success: true });
            expect(await readFile(path, 'utf8')).toBe('updated-owner-relay-fixture');
            await expect(invoke(RPC_METHODS.STAT_FILE, { path, includeContentHash: true })).resolves.toMatchObject({
                success: true, exists: true, kind: 'file', sizeBytes: Buffer.byteLength('updated-owner-relay-fixture'),
                contentHash: createHash('sha256').update('updated-owner-relay-fixture').digest('hex'),
            });
            const detectRequest = { requests: [{ id: 'tool.systemTasks' }], bypassCache: true };
            await expect(invoke(RPC_METHODS.CAPABILITIES_DETECT, detectRequest)).resolves.toMatchObject({
                protocolVersion: 1, results: { 'tool.systemTasks': { ok: true,
                    data: { available: true, methods: ['start', 'poll', 'respond', 'wait'] } } },
            });
            for (const method of ['daemon.filesystem.readFile', RPC_METHODS.READ_FILE] as const)
                await expect(invoke(method, { rootPath, path }, 'member', 'use')).resolves.toMatchObject({
                    success: true, content: Buffer.from('updated-owner-relay-fixture').toString('base64'),
                });
            await expect(invoke(RPC_METHODS.WRITE_FILE, replacement, 'member', 'use')).resolves.toMatchObject({ success: true });
            await expect(invoke(RPC_METHODS.STAT_FILE, { path, includeContentHash: true }, 'member', 'use'))
                .resolves.toMatchObject({ success: true, exists: true, contentHash: createHash('sha256').update('updated-owner-relay-fixture').digest('hex') });
            await expect(invoke(RPC_METHODS.CAPABILITIES_DETECT, detectRequest, 'member', 'use'))
                .resolves.toMatchObject({ protocolVersion: 1, results: { 'tool.systemTasks': { ok: true,
                    data: { available: true, methods: ['start', 'poll', 'respond', 'wait'] } } } });
            await expect(invoke('daemon.filesystem.readFile', { rootPath, path }, 'member', 'manage'))
                .resolves.toMatchObject({ success: true, content: Buffer.from('updated-owner-relay-fixture').toString('base64') });
            expect(await readFile(path, 'utf8')).toBe('updated-owner-relay-fixture');
            // Spend the same installed owner admission on the genuine native
            // PTY. Its controlled REPL avoids ambient shell startup files; split
            // the marker into codes so terminal echo cannot satisfy execution.
            const terminal = DaemonTerminalEnsureResponseSchema.parse(await invoke(RPC_METHODS.DAEMON_TERMINAL_ENSURE,
                { terminalKey: 'owner-relay-shell', cwd: rootPath, cols: 80, rows: 24 }));
            expect(terminal).toMatchObject({ ok: true, reused: false });
            if (!terminal.ok) throw new Error(`Owner relay terminal refused: ${terminal.errorCode}`);
            try {
                const marker = 'OWNER_NATIVE_RELAY_READY';
                const program = `process.stdout.write(String.fromCharCode(${[...marker].map(character => character.charCodeAt(0)).join(',')}))`;
                await expect(invoke(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT, { terminalId: terminal.terminalId,
                    event: { t: 'text', text: program } })).resolves.toMatchObject({ ok: true });
                await expect(invoke(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT, { terminalId: terminal.terminalId,
                    event: { t: 'key', key: 'Enter', modifiers: [] } })).resolves.toMatchObject({ ok: true });
                let byteOffset = 0;
                let legacyCursor = 0;
                let receivedOutput = '';
                await vi.waitFor(async () => {
                    const output = TerminalStreamReadResponseSchema.parse(await invoke(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
                        { terminalId: terminal.terminalId, byteOffset, maxBytes: 4096, maxFrames: 8 }));
                    expect(output.ok).toBe(true);
                    if (!output.ok) throw new Error('Owner relay terminal output unavailable');
                    if (process.platform === 'win32') {
                        // ConPTY explicitly advertises legacy text fidelity;
                        // preserve that supported contract without pretending
                        // its bytes have been qualified by this owner journey.
                        expect(output.frames).toContainEqual(expect.objectContaining({ t: 'legacyOnly', provider: 'windows-conpty' }));
                        const legacy = DaemonTerminalStreamReadResponseSchema.parse(await invoke(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
                            { terminalId: terminal.terminalId, cursor: legacyCursor, maxBytes: 4096, maxEvents: 8 }));
                        expect(legacy.ok).toBe(true);
                        if (!legacy.ok) throw new Error('Owner relay terminal text unavailable');
                        receivedOutput += legacy.events.flatMap(event => event.t === 'data' ? [event.data] : []).join('');
                        legacyCursor = legacy.nextCursor;
                    } else {
                        const bytes = output.frames.flatMap(frame => frame.t === 'bytes' ? [Buffer.from(decodeTerminalStreamBytesFrame(frame))] : []);
                        receivedOutput += Buffer.concat(bytes).toString('utf8');
                    }
                    byteOffset = output.nextByteOffset;
                    expect(receivedOutput).toContain(marker);
                }, { timeout: 10_000 });
                await expect(invoke(RPC_METHODS.DAEMON_TERMINAL_RESIZE, { terminalId: terminal.terminalId, cols: 100, rows: 30 }))
                    .resolves.toMatchObject({ ok: true });
                for (const role of ['use', 'manage'] as const) {
                    for (const [method, request] of [
                        [RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'owner-relay-shell', cwd: rootPath }],
                        [RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT, { terminalId: terminal.terminalId, event: { t: 'text', text: 'forbidden-member-effect' } }],
                        [RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES, { terminalId: terminal.terminalId, byteOffset: 0 }],
                        [RPC_METHODS.DAEMON_TERMINAL_STREAM_READ, { terminalId: terminal.terminalId, cursor: 0 }],
                    ] as const) {
                        const denied = await invoke(method, request, 'member', role);
                        if (method === RPC_METHODS.DAEMON_TERMINAL_ENSURE && role === 'manage') {
                            const memberTerminal = DaemonTerminalEnsureResponseSchema.parse(denied);
                            expect(memberTerminal).toMatchObject({ ok: true, reused: false });
                            if (!memberTerminal.ok) throw new Error('Manage terminal unavailable');
                            expect(memberTerminal.terminalId).not.toBe(terminal.terminalId);
                            await expect(invoke(RPC_METHODS.DAEMON_TERMINAL_CLOSE, { terminalId: memberTerminal.terminalId }, 'member', 'manage'))
                                .resolves.toMatchObject({ ok: true });
                            continue;
                        }
                        expect(denied).toMatchObject(method === RPC_METHODS.DAEMON_TERMINAL_ENSURE
                            ? { ok: false, errorCode: 'terminal_forbidden' }
                            : method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ
                                ? { ok: false, errorCode: 'terminal_forbidden' }
                                : { ok: false, code: 'terminal_forbidden' });
                        expect(denied).not.toHaveProperty('terminalId');
                        expect(denied).not.toHaveProperty('events');
                        expect(denied).not.toHaveProperty('frames');
                    }
                }
                await expect(invoke(RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'owner-relay-shell', cwd: rootPath }))
                    .resolves.toMatchObject({ ok: true, reused: true, terminalId: terminal.terminalId });
            } finally {
                await expect(invoke(RPC_METHODS.DAEMON_TERMINAL_CLOSE, { terminalId: terminal.terminalId }))
                    .resolves.toMatchObject({ ok: true });
            }
            expect(f.admissionChecks()).toBeGreaterThan(0);
        } finally {
            await relay.close();
            await f.machine.shutdown();
        }
    });
    it('retains actual filesystem scope through registered owner exports and refuses private deputy publication', async () => {
        const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
        const f = await createInstalledFilesystemMachineFixture({ directTransferExport: {
            prepareExportSession: async (request, filesystemScope) => {
                if (request.t !== 'workspace_file_download_v1') throw new Error('Unexpected export purpose');
                if (!filesystemScope) throw new Error('Missing actual Machine filesystem scope');
                return prepareWorkspaceFileExport({ lifecycle, request, filesystemScope, accessPolicy: { kind: 'osUser' } });
            },
        } });
        const path = join(f.directory, 'owner-transfer.bin');
        const bytes = Buffer.alloc(300_000, 79);
        await writeFile(path, bytes);
        const request = { t: 'workspace_file_download_v1', workingDirectory: f.directory, path, asZip: false };
        try {
            for (const callerAuthority of ['present_user', 'account_automation'] as const) {
                await expect(f.invoke(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE, request, { callerAuthority }))
                    .resolves.toMatchObject({ success: true, name: 'owner-transfer.bin', sizeBytes: bytes.length,
                        manifestHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
            }
            expect(lifecycle.getState().publishedTransferCount).toBe(2);
            await expect(f.invoke(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE, request, { actorAccountId: 'member', role: 'use' }))
                .resolves.toMatchObject({ errorCode: 'agent_isolation_unavailable' });
            f.retire();
            await expect(f.invoke(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE, request))
                .resolves.not.toMatchObject({ success: true });
            expect(lifecycle.getState().publishedTransferCount).toBe(2);
        } finally { await lifecycle.stop(); }
    });
    it.each(['present_user', 'account_automation'] as const)('uses authenticated held Home for %s filesystem effects without an exact saved descriptor', async callerAuthority => {
        const f = await createInstalledFilesystemMachineFixture();
        const rootPath = join(f.directory, 'workspace');
        await mkdir(rootPath);
        const path = join(rootPath, 'ordinary.txt');
        await writeFile(path, 'owner-file-fixture');
        await updateSettings(current => ({ ...current, servers: { ...current.servers,
            [f.serverId]: { ...current.servers![f.serverId], homeConnectionDescriptorAuthority: 'advisory' } } }));
        try {
            expect(await resolveServerProfileHomeIdentityId('filesystem-profile')).toBeNull();
            const result = await f.invoke('daemon.filesystem.readFile', { rootPath, path }, { callerAuthority });
            expect(result).toMatchObject({ success: true, content: Buffer.from('owner-file-fixture').toString('base64') });
            const beforeList = f.admissionChecks();
            await expect(f.invoke(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST, { rootPath }, { callerAuthority }))
                .resolves.toMatchObject({ ok: true, paths: ['ordinary.txt'], truncated: false });
            expect(f.admissionChecks() - beforeList).toBe(1);
            await expect(f.invoke(RPC_METHODS.LIST_DIRECTORY, { rootPath, path: '.' }, { callerAuthority }))
                .resolves.toMatchObject({ success: true, entries: [{ name: 'ordinary.txt', type: 'file' }] });
            await expect(f.invoke(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH, { rootPath, query: 'owner-file-fixture' }, { callerAuthority }))
                .resolves.toMatchObject({ ok: true, files: [{ path: 'ordinary.txt' }] });
            // Preserve the predecessor's presence-only raw mutation contract;
            // Account automation uses the separate full Action approval route.
            const replacement = { path, content: Buffer.from('updated-owner-fixture').toString('base64') };
            if (callerAuthority === 'present_user') {
                await expect(f.invoke(RPC_METHODS.WRITE_FILE, replacement, { callerAuthority }))
                    .resolves.toMatchObject({ success: true });
                expect(await readFile(path, 'utf8')).toBe('updated-owner-fixture');
            } else {
                await expect(f.invoke(RPC_METHODS.WRITE_FILE, replacement, { callerAuthority }))
                    .resolves.toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
                expect(await readFile(path, 'utf8')).toBe('owner-file-fixture');
            }
            expect(f.admissionChecks()).toBeGreaterThan(0);
        } finally { await f.machine.shutdown(); }
    });
    it('permits admitted Use while refusing copied Session, missing Home and withdrawn admission', async () => {
        const f = await createInstalledFilesystemMachineFixture();
        const rootPath = join(f.directory, 'workspace');
        await mkdir(rootPath);
        const path = join(rootPath, 'private.txt');
        await writeFile(path, 'private-fixture-bytes');
        const requests = [
            ['daemon.filesystem.readFile', { rootPath, path }],
            [RPC_METHODS.LIST_DIRECTORY, { rootPath, path: '.' }],
            [RPC_METHODS.WRITE_FILE, { path, content: Buffer.from('forbidden-replacement').toString('base64') }],
            [RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH, { rootPath, query: 'private-fixture-bytes' }],
        ] as const;
        const copiedOrigin = { v: 1 as const, caller: { kind: 'session' as const, sessionId: 'copied-owner-session', starterDepth: 0, turnDepth: 0 },
            sourceTurnId: 'agent-turn', callerPermissionMode: null, requestId: 'copied-owner-files' };
        const refuse = async (ingress: NonNullable<Parameters<typeof f.invoke>[2]>) => {
            for (const [method, request] of requests) {
                const result = await f.invoke(method, request, ingress);
                expect(result).not.toMatchObject({ success: true });
                expect(result).not.toMatchObject({ ok: true });
                expect(result).not.toHaveProperty('content');
                expect(result).not.toHaveProperty('files');
                expect(JSON.stringify(result)).not.toContain('private-fixture-bytes');
            }
            expect(await readFile(path, 'utf8')).toBe('private-fixture-bytes');
        };
        for (const callerAuthority of ['present_user', 'account_automation'] as const)
            await expect(f.invoke('daemon.filesystem.readFile', { rootPath, path }, { actorAccountId: 'member', role: 'use', callerAuthority }))
                .resolves.toMatchObject({ success: true, content: Buffer.from('private-fixture-bytes').toString('base64') });
        await refuse({ sessionActionOrigin: copiedOrigin });
        f.setHeldHome(null);
        await refuse({});
        f.setHeldHome(f.homeServerIdentityId);
        f.retire();
        await refuse({ callerAuthority: 'account_automation' });
    });
});

describe('scoped Describe cancellation through the real relay and Machine listener', () => {
    it.each(['full', 'section', 'cooperative', 'legacy'] as const)('%s preserves cancellation response custody', async scenario => {
        const method = RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE;
        const entered = createDeferred();
        const release = createDeferred();
        const cancelled = createDeferred();
        const completed = createDeferred();
        const payload = { body: 'x'.repeat(2_233_988) };
        const manager = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain', logger: () => {},
            authorizeRequest: async () => ({ ok: true }) });
        let handlerSignal: AbortSignal | undefined;
        manager.registerHandler(method, async (_input, context) => {
            handlerSignal = context?.signal;
            context?.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
            entered.resolve();
            await release.promise;
            return payload;
        });
        const http = createServer();
        const sockets = new Server(http, { maxHttpBufferSize: payload.body.length * 2 });
        sockets.on('connection', socket => {
            socket.data = socket.handshake.query.clientType === 'user'
                ? { clientType: 'user-scoped', authAuthority: 'present_user' }
                : { clientType: 'machine-scoped', machineId: 'machine-1' };
            socket.on('drain', (ack: () => void) => ack());
            registerSocketRpcHandlers({ userId: 'account-1', socket, io: sockets });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback socket endpoint');
        const endpoint = new URL(`http://${address.address}:${address.port}`);
        const target = io(endpoint.href, { autoConnect: false, reconnection: false });
        const caller = io(endpoint.href, { autoConnect: false, reconnection: false, query: { clientType: 'user' } });
        const client: ApiMachineClient = Object.assign(Object.create(ApiMachineClient.prototype), {
            rpcHandlerManager: manager, activeTransportGeneration: 1, socket: target,
            machine: { id: 'machine-1' }, connectedClientRpcMethods: new Set<string>(),
        });
        const acknowledgements: number[] = [];
        const connect = async (socket: ReturnType<typeof io>) => {
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('connect_error', reject);
                socket.connect();
            });
        };
        try {
            if (scenario === 'legacy') {
                // cli-v0.2.0 (526aa0db) has no CANCEL listener and ACKs its result unconditionally.
                target.on(SOCKET_RPC_EVENTS.REQUEST, async (_request: RpcRequest, ack: (response: unknown) => void) => {
                    entered.resolve();
                    await release.promise;
                    ack(payload);
                    completed.resolve();
                });
            } else {
                const install: unknown = Reflect.get(client, 'installSocketEventHandlers');
                if (typeof install !== 'function') throw new Error('Missing native Machine listener owner');
                Reflect.apply(install, client, [target, 1]);
            }
            await connect(target);
            target.io.engine.on('packetCreate', packet => {
                if (packet.type === 'message' && typeof packet.data === 'string' && /^3\d+\[/.test(packet.data)) {
                    acknowledgements.push(Buffer.byteLength(packet.data));
                }
            });
            if (scenario === 'legacy') target.emit(SOCKET_RPC_EVENTS.REGISTER, { method: `machine-1:${method}` });
            else manager.onSocketConnect(target);
            if (scenario !== 'legacy') await expect(manager.waitForRegisteredHandlers([method], { timeoutMs: 5_000 }))
                .resolves.toEqual({ status: 'ready' });
            await connect(caller);
            const controller = new AbortController();
            const call = (signal?: AbortSignal) => callSocketRpc({ socket: caller,
                target: { kind: 'machine', id: 'machine-1' }, method,
                params: scenario === 'section' ? { deferredSections: true, sectionRead: { digest: 'section', offset: 0 } } : {},
                content: { mode: 'plain' }, timeoutMs: null, signal,
                ...(scenario === 'cooperative' ? { waitForResultOnCancel: true } : {}),
            });
            const pending = call(controller.signal);
            const aborted = scenario === 'cooperative' ? undefined
                : expect(pending).rejects.toMatchObject({ rpcErrorCode: 'SOCKET_RPC_ABORTED' });
            await entered.promise;
            controller.abort();
            if (scenario !== 'legacy') {
                await cancelled.promise;
                expect(handlerSignal?.aborted).toBe(true);
            }
            release.resolve();
            if (scenario === 'cooperative') {
                await expect(pending).resolves.toEqual(payload);
                expect(acknowledgements).toHaveLength(1);
            } else {
                await aborted;
                if (scenario === 'legacy') await completed.promise;
                else await manager.waitForIdle();
                // Ordered native socket traffic drains any response emitted by the settled handler.
                await target.emitWithAck('drain');
                const sentBytes = acknowledgements.reduce((sum, bytes) => sum + bytes, 0);
                if (scenario === 'legacy') expect(sentBytes).toBeGreaterThan(payload.body.length);
                else expect(sentBytes).toBe(0);
                const lateCount = acknowledgements.length;
                await expect(call()).resolves.toEqual(payload);
                expect(acknowledgements).toHaveLength(lateCount + 1);
            }
        } finally {
            release.resolve();
            caller.disconnect();
            target.disconnect();
            manager.onSocketDisconnect();
            await new Promise<void>(resolve => sockets.close(() => resolve()));
        }
    });
});

describe('Machine RPC retired transport diagnostics', () => {
    it('returns a terminal spawn result on the admitted transport after an overlapping replacement becomes active', async () => {
        const method = 'machine-1:session.spawn_new.settlement';
        const entered = createDeferred();
        const release = createDeferred();
        const store = createActionOperationStore();
        const spec = getActionSpec('session.spawn_new');
        const runner = createActionOperationRunner({
            store,
            resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }),
            generateOperationId: () => 'spawn-operation',
        });
        const terminal = {
            type: 'success' as const,
            disposition: 'created' as const,
            sessionId: 'created-session',
            executionTarget: { serverId: 'home', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] as string[] },
            initialInput: { status: 'notRequested' as const },
        };
        const manager = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain' });
        manager.registerHandler('session.spawn_new.settlement', async () => runner.observe({
            actionId: 'session.spawn_new', requestId: 'creation-attempt', input: { placement: 'managed' },
            scope: { accountId: 'account-1', machineId: 'machine-1' },
            execute: async () => {
                entered.resolve();
                await release.promise;
                return { ok: true, result: terminal };
            },
        }));
        const client: ApiMachineClient = Object.assign(Object.create(ApiMachineClient.prototype), {
            rpcHandlerManager: manager, activeTransportGeneration: 0, socket: null,
        });
        const http = createServer();
        const sockets = new Server(http, { path: '/v1/updates/' });
        sockets.on('connection', (socket) => {
            socket.data = { clientType: 'machine-scoped', machineId: 'machine-1' };
            void socket.join(`rpc:account-1:${method}`);
        });
        await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback socket endpoint');
        const transports: ReturnType<typeof createHappierSocket>[] = [];
        const connect = async () => {
            const generation = transports.length + 1;
            const transport = createHappierSocket({ endpoint: `http://127.0.0.1:${address.port}`,
                token: 'test-token', clientType: 'machine-scoped', machineId: 'machine-1' });
            transports.push(transport);
            Reflect.set(client, 'activeTransportGeneration', generation);
            Reflect.set(client, 'socket', transport.socket);
            const install: unknown = Reflect.get(client, 'installSocketEventHandlers');
            if (typeof install !== 'function') throw new Error('Missing native Machine listener owner');
            Reflect.apply(install, client, [transport.socket, generation]);
            await transport.transport.connect();
        };
        try {
            await connect();
            const response = forwardRpcCall({ io: sockets, targetUserId: 'account-1', method,
                callParams: {}, traceId: 'spawn-settlement', timeoutMs: null });
            await entered.promise;
            // A replacement can become active before the accepted request finishes while
            // the admitted socket remains connected and still owns this acknowledgement.
            await connect();
            release.resolve();
            let settled = false;
            void response.finally(() => { settled = true; });
            await expect.poll(() => settled).toBe(true);
            await expect(response).resolves.toEqual({ ok: true, result: { ok: true, result: terminal } });
            expect(store.list({ accountId: 'account-1', machineId: 'machine-1' }).items)
                .toMatchObject([{ state: 'succeeded' }]);
        } finally {
            release.resolve();
            await Promise.all(transports.map(({ transport }) => transport.destroy()));
            manager.onSocketDisconnect();
            await new Promise<void>((resolve) => sockets.close(() => resolve()));
        }
    });

    it.each(['held-handler', 'stale-entry', 'current'] as const)('%s preserves native ACK custody without replay', async (scenario) => {
        const method = 'machine-1:reply.contract';
        const traceId = 'private-correlation-never-log';
        const requestId = `sha256:${createHash('sha256').update(traceId).digest('hex')}`;
        const entered = createDeferred();
        const release = createDeferred();
        const effect = vi.fn(async () => {
            entered.resolve();
            if (scenario === 'held-handler') await release.promise;
            return { receipt: 'private-result-never-log' };
        });
        const managerLogs = vi.fn();
        const manager = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain', logger: managerLogs });
        manager.registerHandler('reply.contract', effect);
        // Exercise the native listener without unrelated Machine constructor Actions.
        // Transport retirement remains the actual supervisor + Socket.IO adapter.
        const client: ApiMachineClient = Object.assign(Object.create(ApiMachineClient.prototype), {
            rpcHandlerManager: manager, activeTransportGeneration: 0, socket: null,
        });
        const warnings = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const http = createServer();
        const sockets = new Server(http, { path: '/v1/updates/' });
        const serverSockets: ServerSocket[] = [];
        sockets.on('connection', (socket) => {
            socket.data = { clientType: 'machine-scoped', machineId: 'machine-1' };
            // Trusted registration is outside this listener/retirement contract.
            void socket.join(`rpc:account-1:${method}`);
            serverSockets.push(socket);
        });
        await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback socket endpoint');
        const transports: ReturnType<typeof createHappierSocket>[] = [];
        const supervisor = createManagedConnectionSupervisor({
            ...DEFAULT_MANAGED_CONNECTION_POLICY,
            probeReadiness: async () => ({ status: 'ready' }),
            createTransport: () => {
                const transport = createHappierSocket({ endpoint: `http://127.0.0.1:${address.port}`,
                    token: 'test-token', clientType: 'machine-scoped', machineId: 'machine-1' });
                transports.push(transport);
                Reflect.set(client, 'activeTransportGeneration', transports.length);
                Reflect.set(client, 'socket', transport.socket);
                const install: unknown = Reflect.get(client, 'installSocketEventHandlers');
                if (typeof install !== 'function') throw new Error('Missing native Machine listener owner');
                Reflect.apply(install, client, [transport.socket, transports.length]);
                return transport.transport;
            },
        });
        const forward = () => forwardRpcCall({ io: sockets, targetUserId: 'account-1', method,
            callParams: { secret: 'private-params-never-log' }, traceId, timeoutMs: null });
        try {
            await supervisor.start();
            await expect.poll(() => supervisor.getState().phase).toBe('online');
            await expect.poll(() => serverSockets.length).toBe(1);
            const original = transports[0].socket;
            // A native callback already queued at retirement can still enter the
            // captured listener. Capture that genuine boundary callback, not a
            // mock of the listener's generation decision or dispatch logic.
            const queuedListener: unknown = original.listeners(SOCKET_RPC_EVENTS.REQUEST)[0];
            if (typeof queuedListener !== 'function') throw new Error('Missing native RPC listener');
            if (scenario === 'current') {
                await expect(forward()).resolves.toMatchObject({ ok: true, result: { receipt: 'private-result-never-log' } });
                expect(effect).toHaveBeenCalledTimes(1);
                expect(warnings).not.toHaveBeenCalled();
                return;
            }
            const originalWait = scenario === 'held-handler' ? forward() : null;
            if (originalWait) await entered.promise;
            await supervisor.stop();
            await supervisor.start();
            await expect.poll(() => supervisor.getState().phase).toBe('online');
            await expect.poll(() => serverSockets.length).toBe(2);
            const replacementRequests = vi.fn();
            transports[1].socket.on(SOCKET_RPC_EVENTS.REQUEST, replacementRequests);
            if (originalWait) {
                // Existing native disconnect settlement must precede completion
                // of an accepted effect; the warning must not invent a failure.
                await expect(originalWait).resolves.toMatchObject({ ok: false, errorCode: 'RPC_OUTCOME_UNKNOWN',
                    error: 'RPC target disconnected after request submission' });
                release.resolve();
                await expect.poll(() => warnings.mock.calls.length).toBe(1);
                expect(effect).toHaveBeenCalledTimes(1);
            } else {
                const ack = vi.fn();
                await Reflect.apply(queuedListener, original, [{ method: 'private-scope:unregistered\nsecret',
                    params: { secret: 'private-params-never-log' }, traceId }, ack]);
                expect(effect).not.toHaveBeenCalled();
                expect(ack).not.toHaveBeenCalled();
            }
            expect(warnings.mock.calls).toEqual([['[API MACHINE] RPC transport retired before acknowledgement', {
                phase: scenario === 'held-handler' ? 'after-handler' : 'before-handler',
                method: scenario === 'held-handler' ? 'reply.contract' : '<unregistered>', requestId,
                transportGeneration: 1, activeTransportGeneration: 2, connected: false, sameSocket: false,
            }]]);
            expect(JSON.stringify(warnings.mock.calls)).not.toContain('private-');
            if (scenario === 'held-handler') {
                expect(managerLogs.mock.calls).toContainEqual(['[RPC] Request completed', expect.objectContaining({
                    method: 'reply.contract', requestId, outcomeCode: 'ok',
                })]);
            }
            expect(transports[1].socket.connected).toBe(true);
            expect(replacementRequests).not.toHaveBeenCalled();
        } finally {
            release.resolve();
            await supervisor.stop();
            manager.onSocketDisconnect();
            warnings.mockRestore();
            await new Promise<void>((resolve) => sockets.close(() => resolve()));
        }
    });
});

describe('ApiMachineClient RPC scope on the server registration harness', () => {
    it('preserves admitted Manage Account automation through registered SCM while refusing Session deputies', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'machine-owner-automation-'));
        const boundary = { machineId: 'machine', resolveInstallationId: () => 'installation',
            resolveCustodianAccountId: async () => 'owner', resolveHomeServerIdentityId: async () => 'home',
            verifyMachineAdmission: async () => true };
        const manager = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain',
            authorizeRequest: request => authorizeMachineRpcRequest(request, boundary) });
        registerScmHandlers(manager, directory, { machineId: 'machine', registry: createScmBackendRegistry([]) });
        const registration = registerSessionHandlers(manager, directory, { resolveHostHomeServerIdentityId: async () => 'home' });
        const admission = (actorAccountId: string) => ({ actorAccountId, custodianAccountId: 'owner', machineId: 'machine',
            installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const });
        try {
            await expect(manager.handleRequest({ method: `machine:${RPC_METHODS.SCM_STATUS_SNAPSHOT}`, params: { cwd: directory },
                callerAuthority: 'account_automation', machineAdmission: admission('owner') })).resolves.toMatchObject({ success: true });
            await expect(manager.handleRequest({ method: `machine:${RPC_METHODS.SCM_STATUS_SNAPSHOT}`, params: { cwd: directory },
                callerAuthority: 'account_automation', machineAdmission: admission('member') }))
                .resolves.toMatchObject({ success: true });
            const rpcContext = { machineAdmission: admission('owner'), callerAuthority: 'account_automation' as const,
                verifyMachineAdmissionCurrent: async () => true };
            await expect(manager.invokeLocal(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: directory }, {
                rpcContext, localActionContext: { authority: 'account_automation' },
            })).resolves.toMatchObject({ success: true });
            const caller = { kind: 'session' as const, sessionId: 'owner-agent', starterDepth: 0, turnDepth: 0 };
            for (const localActionContext of [
                { authority: 'account_automation' as const, actionCaller: caller },
                { authority: 'account_automation' as const, actionCaller: { kind: 'workflowRun' as const, runId: 'session-workflow',
                    authorization: WorkflowAcceptedAuthorizationV1Schema.parse({ admittedPermissionCeiling: 'default',
                        principal: { kind: 'session', sessionId: caller.sessionId } }) } },
                { authority: 'account_automation' as const, requesterWorkAttributionV1: {
                    serverId: 'profile', accountId: 'owner', machineId: 'machine', installationId: 'installation' } },
            ]) {
                await expect(manager.invokeLocal(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: directory }, {
                    rpcContext, localActionContext,
                })).resolves.toMatchObject({ errorCode: 'agent_isolation_unavailable' });
            }
            // An actual full host context is structurally accepted by the
            // narrower delegation port; neither nested provenance nor an
            // explicit local override may erase its Session caller.
            const nested: RpcHandlerContext = { ...rpcContext, signal: new AbortController().signal,
                localActionContext: { authority: 'account_automation', actionCaller: caller } };
            for (const localActionContext of [undefined, { authority: 'account_automation' as const }]) {
                await expect(manager.invokeLocal(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: directory }, {
                    rpcContext: nested, localActionContext,
                })).resolves.toMatchObject({ errorCode: 'agent_isolation_unavailable' });
            }
            await expect(manager.invokeLocal(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: directory }, {
                rpcContext, localActionContext: { authority: 'account_automation', actionCaller: { kind: 'workflowRun', runId: 'host-workflow',
                    authorization: WorkflowAcceptedAuthorizationV1Schema.parse({ admittedPermissionCeiling: 'default', principal: { kind: 'host' } }) } },
            })).resolves.toMatchObject({ success: true });
            await expect(manager.handleRequest({ method: `machine:${RPC_METHODS.PREVIEW_ENV}`,
                params: { keys: ['MI1_OWNER_AUTOMATION'], extraEnv: { MI1_OWNER_AUTOMATION: 'owner-operation' } },
                callerAuthority: 'account_automation', machineAdmission: admission('owner') }))
                .resolves.toMatchObject({ values: { MI1_OWNER_AUTOMATION: { value: 'owner-operation' } } });
            // These are pre-existing presence restrictions, not the new MI-1 gate.
            const bash = await manager.handleRequest({ method: `machine:${RPC_METHODS.BASH}`, params: { argv: ['unreached'] },
                callerAuthority: 'account_automation', machineAdmission: admission('owner') });
            expect(bash).not.toMatchObject({ errorCode: 'agent_isolation_unavailable' });
            expect(bash).toMatchObject({ success: false });
        } finally { await registration.dispose(); await rm(directory, { recursive: true, force: true }); }
    });
    it('allows Manage and refuses Use raw execution through the server forwarder', async () => {
        const f = await createInstalledFilesystemMachineFixture();
        const directory = f.directory;
        const markerPath = join(directory, 'private-source');
        await writeFile(markerPath, 'synthetic-owner-private', { mode: 0o600 });
        const relay = await createInstalledMachineRpcRelay({ manager: f.rpcHandlerManager, machineId: 'machine',
            transportOwnerAccountId: 'account-1', methods: [RPC_METHODS.BASH] });
        const invoke = async (actorAccountId: string, role: 'use' | 'manage', params: unknown) => {
            // Home supplies this admitted stamp at the forwarding boundary;
            // command authors never choose daemon requester context themselves.
            return await relay.invoke(RPC_METHODS.BASH, params, {
                callerAuthority: 'present_user', machineAdmission: { actorAccountId, custodianAccountId: 'requester', machineId: 'machine',
                    installationId: f.installation.installationId, role, encryptionMode: 'plain' } });
        };
        try {
            const readScript = "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))";
            for (const params of [
                { argv: [process.execPath, '-e', readScript, markerPath], timeout: 0 },
                { command: `"${process.execPath}" -e "${readScript}" "${markerPath}"`, cwd: '/', timeout: 0 },
            ]) {
                const result = await invoke('member', 'use', params);
                expect(result).toMatchObject({ errorCode: 'agent_isolation_unavailable' });
                expect(JSON.stringify(result)).not.toContain('synthetic-owner-private');
            }
            await expect(invoke('member', 'manage', { argv: [process.execPath, '-e', readScript, markerPath], timeout: 0 }))
                .resolves.toMatchObject({ success: true, stdout: 'synthetic-owner-private' });
            await expect(invoke('requester', 'manage', { argv: [process.execPath, '-e', "process.stdout.write('owner-positive')"], timeout: 0 }))
                .resolves.toMatchObject({ success: true, stdout: 'owner-positive' });
            expect(f.admissionChecks()).toBeGreaterThan(0);
        } finally {
            await relay.close();
            await f.machine.shutdown();
        }
    });
    it.each(['reconnect', 'replacement'] as const)('re-admits a permanently refused method after socket %s', async (transition) => {
        const manager = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain', logger: () => {} });
        manager.registerHandler(RPC_METHODS.CAPABILITIES_DESCRIBE, () => ({ protocolVersion: 1 }));
        const method = `machine-1:${RPC_METHODS.CAPABILITIES_DESCRIBE}`;
        const http = createServer();
        const sockets = new Server(http);
        sockets.on('connection', (socket) => {
            socket.data = { clientType: 'machine-scoped', machineId: socket.handshake.query.machineId };
            registerSocketRpcHandlers({ userId: 'account-1', socket, io: sockets });
        });
        await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback socket endpoint');
        const url = `http://127.0.0.1:${address.port}`;
        const first = io(url, { autoConnect: false, reconnection: false, query: { machineId: 'machine-2' } });
        let next = first;
        const connect = async (socket: ReturnType<typeof io>) => {
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('connect_error', reject);
                socket.connect();
            });
            manager.onSocketConnect(socket);
        };
        try {
            const rejection = new Promise<unknown>((resolve) => first.once(SOCKET_RPC_EVENTS.ERROR, resolve));
            await connect(first);
            await expect(rejection).resolves.toMatchObject({ type: 'register', method, retryable: false });
            const emit = vi.spyOn(first, 'emit');
            expect(manager.replayUnacknowledgedHandlerRegistrations()).toEqual([]);
            expect(emit).not.toHaveBeenCalled();
            // Replacement can begin a new admission without a prior manager disconnect callback.
            if (transition === 'reconnect') manager.onSocketDisconnect();
            first.disconnect();
            if (transition === 'replacement') {
                next = io(url, { autoConnect: false, reconnection: false, query: { machineId: 'machine-1' } });
            } else {
                first.io.opts.query = { machineId: 'machine-1' };
            }
            await connect(next);
            await expect(manager.waitForRegisteredHandlers([RPC_METHODS.CAPABILITIES_DESCRIBE], { timeoutMs: 5_000 }))
                .resolves.toEqual({ status: 'ready' });
            expect(manager.replayUnacknowledgedHandlerRegistrations()).toEqual([]);
        } finally {
            manager.onSocketDisconnect();
            first.disconnect();
            next.disconnect();
            await new Promise<void>((resolve) => sockets.close(() => resolve()));
        }
    });

    it('retains bound Session log-tail dispatch through the real Action owner', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'session-log-contract-'));
        const path = join(dir, 'session.log');
        await writeFile(path, '0123456789', 'utf8');
        const manager = new RpcHandlerManager({ scopePrefix: 'session-1', encryptionMode: 'plain' });
        const registration = registerSessionHandlers(manager, dir, {
            sessionId: 'session-1',
            transcriptActionExecutor: createCliActionExecutor({
                token: 'test-token', sessionId: 'session-1', mode: 'e2ee',
                ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
                sessionLogAccess: { workingDirectory: dir, accessPolicy: { kind: 'restrictedRoots', roots: [dir] } },
            }),
        });
        try {
            await expect(manager.handleRequest({
                method: `session-1:${RPC_METHODS.SESSION_LOG_TAIL}`,
                params: { path, offset: 2, maxBytes: 4 },
            })).resolves.toMatchObject({ ok: true, path, tail: '2345', offset: 2, nextOffset: 6, truncated: true });
        } finally {
            await registration.dispose();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it.each([false, true])('registers without Forbidden errors with machine diagnostics=%s', async (includeDiagnostics) => {
        const client = new ApiMachineClient('test-token', {
            id: 'machine-1', encryptionMode: 'plain', metadata: null, metadataVersion: 0,
            daemonState: null, daemonStateVersion: 0,
        });
        // Observe the existing private transport owner without adding a production inspection API.
        const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
        expect(manager).toBeInstanceOf(RpcHandlerManager);
        if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing machine RPC owner');
        if (includeDiagnostics) registerMachineDiagnosticsRpcHandlers({ rpcHandlerManager: manager });
        const http = createServer();
        const sockets = new Server(http);
        const settled: unknown[] = [];
        const errors: unknown[] = [];
        const connectedServerSocket = new Promise<ServerSocket>((resolve) => {
            sockets.on('connection', (socket) => {
                socket.data = socket.handshake.query.clientType === 'user'
                    ? { clientType: 'user-scoped' }
                    : { clientType: 'machine-scoped', machineId: 'machine-1' };
                // Model the trusted Account authentication stamp supplied before the real RPC owner.
                socket.data.authAuthority = 'present_user';
                socket.data.authTokenAuthenticationEvidence = [];
                socket.onAnyOutgoing((event, payload) => {
                    if (event === SOCKET_RPC_EVENTS.REGISTERED || event === SOCKET_RPC_EVENTS.ERROR) settled.push(payload);
                    if (event === SOCKET_RPC_EVENTS.ERROR) errors.push(payload);
                });
                registerSocketRpcHandlers({ userId: 'account-1', socket, io: sockets });
                resolve(socket);
            });
        });
        await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback socket endpoint');
        const clientSocket = io(`http://127.0.0.1:${address.port}`, { autoConnect: false, reconnection: false });
        const emit = vi.spyOn(clientSocket, 'emit');
        const temporaryDirs: string[] = [];
        let callerSocket: ReturnType<typeof io> | undefined;
        try {
            await new Promise<void>((resolve, reject) => {
                clientSocket.once('connect', resolve);
                clientSocket.once('connect_error', reject);
                clientSocket.connect();
            });
            const serverSocket = await connectedServerSocket;
            clientSocket.on(SOCKET_RPC_EVENTS.REQUEST, (request: RpcRequest, ack: (result: unknown) => void) => {
                void manager.handleRequest(request).then(ack);
            });
            manager.onSocketConnect(clientSocket);
            const methods = emit.mock.calls
                .filter(([event]) => event === SOCKET_RPC_EVENTS.REGISTER)
                .map(([, payload]) => (payload as { method: string }).method);
            expect(methods.length).toBeGreaterThan(0);
            await expect.poll(() => settled.length).toBe(methods.length);
            // Transfers are dual-scope by the canonical wire schema and the server's explicit machine exemption.
            expect(methods.filter((method) =>
                resolveSocketRpcSessionAuthorization(method)?.routeToSessionOwnerDaemon === true
                && !SessionTransferRpcMethodV1Schema.safeParse(method.slice(method.indexOf(':') + 1)).success,
            )).toEqual([]);
            expect(errors).toEqual([]);
            await expect(manager.waitForRegisteredHandlers(methods.map((method) => method.slice(method.indexOf(':') + 1)),
                { timeoutMs: 5_000 })).resolves.toEqual({ status: 'ready' });
            expect(methods).toContain(`machine-1:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT}`);
            expect(methods).toContain(`machine-1:${RPC_METHODS.CAPABILITIES_DESCRIBE}`);
            const connectedAccountControlMethod = 'machine-1:daemon.connectedAccounts.control.command';
            expect(methods).toContain(connectedAccountControlMethod);
            callerSocket = io(`http://127.0.0.1:${address.port}`, {
                autoConnect: false, reconnection: false, query: { clientType: 'user' },
            });
            const caller = callerSocket;
            await new Promise<void>((resolve, reject) => {
                caller.once('connect', resolve);
                caller.once('connect_error', reject);
                caller.connect();
            });
            await expect(caller.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.CALL, {
                method: connectedAccountControlMethod,
                params: { v: 1, machineId: 'machine-1', command: {
                    operation: 'describeService', service: { pluginId: 'acme.accounts', localId: 'work' },
                } },
            })).resolves.toEqual({ ok: true, result: { status: 'unavailable', code: 'connected_account_daemon_runtime_unavailable' } });
            await expect(serverSocket.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.REQUEST,
                { method: `machine-1:${RPC_METHODS.CAPABILITIES_DESCRIBE}`, params: {} }))
                .resolves.toMatchObject({ protocolVersion: 1 });
            if (includeDiagnostics) {
                const method = 'machine-1:daemon.session.log.tail';
                expect(methods).toContain(method);
                expect(methods).not.toContain(`machine-1:${RPC_METHODS.SESSION_LOG_TAIL}`);
                const logsDir = join(configuration.happyHomeDir, 'logs');
                await mkdir(logsDir, { recursive: true });
                const logDir = await mkdtemp(join(logsDir, 'machine-log-contract-'));
                temporaryDirs.push(logDir);
                const logPath = join(logDir, 'session.log');
                const contents = 'first line\nlast line\n';
                await writeFile(logPath, contents, 'utf8');
                // This registration fixture has no installed Machine/Home
                // custody or currentness proof. Account authentication alone
                // must not grant private log bytes. Authorized reads remain
                // covered by rpcHandlers.diagnostics.test.ts.
                const response = await caller.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.CALL,
                    { method, params: { path: logPath, maxBytes: 1024 } });
                expect(response).toMatchObject({ ok: true, result: {
                    success: false, errorCode: 'filesystem_identity_custody_unavailable',
                } });
                expect(response).not.toHaveProperty('result.tail');
            }
        } finally {
            manager.onSocketDisconnect();
            callerSocket?.disconnect();
            clientSocket.disconnect();
            await client.shutdown();
            await new Promise<void>((resolve) => sockets.close(() => resolve()));
            await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
        }
    });
});
