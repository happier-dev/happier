import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { createProjectDefinitionAction } from '@/rpc/handlers/projectDefinitions';
import { prepareRequesterNativeOperation } from '@/daemon/agentIsolation/prepareNativeOperation';
import { createPlainProjectAccountRefRow, mockProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { ApiMachineClient } from '@/api/apiMachine';
import { readProjectAsMember } from './memberProjectInspection';
import { runWorkspaceEffectWorker } from './workspaceEffectWorker';
import { workspaceCheckoutNativeBoundary as boundary } from './workspaceCheckoutNative.testkit';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { PROJECT_DEFINITION_INSPECT_ACTION_ID, PROJECT_WORKTREE_PORTS_REASSIGN_ACTION_ID } from '@happier-dev/protocol/actions/projectDefinitionActionIdsV1';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import { createProjectDotenvPreparation } from '@/workspaces/projectSetup/projectDotenv';
import { createProjectRuntimeDotenvPreparation } from '@/workspaces/projectSetup/projectSetupReadiness';

// Only OS permissions and process launch are replaced. The framed worker,
// read port, source lifetime and canonical Project inspection remain real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    const { workspaceCheckoutFilesystemBoundary } = await import('./workspaceCheckoutNative.testkit');
    return workspaceCheckoutFilesystemBoundary(actual);
});
vi.mock('fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('fs/promises')>();
    const { workspaceCheckoutFilesystemBoundary } = await import('./workspaceCheckoutNative.testkit');
    const filesystem = workspaceCheckoutFilesystemBoundary(actual);
    return { ...filesystem, open: (...args: Parameters<typeof actual.open>) => {
        const path = String(args[0]);
        if (boundary.privateRoots.some(root => path === root || path.startsWith(`${root}/`))) {
            if (boundary.identity.getStore() !== 'member') {
                boundary.phases.push('daemon_definition_read');
                throw Object.assign(new Error('Private read denied'), { code: 'EACCES' });
            }
            boundary.phases.push('member_definition_read');
        }
        return Reflect.apply(filesystem.open, filesystem, args);
    } };
});
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    const { spawnWorkspaceCheckoutNativeBoundary } = await import('./workspaceCheckoutNative.testkit');
    return { ...actual, spawn: (command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => {
        // The Linux scope composer may wrap the admitted sudo target.
        expect([command, ...args]).toContain('sudo');
        expect(args.slice(-2)).toEqual(['/opt/happier/cli/current/happier', 'agent-launch']);
        return spawnWorkspaceCheckoutNativeBoundary(actual.spawn, options);
    } };
});
vi.mock('@happier-dev/cli-common/process', async importOriginal => {
    const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
    return { ...actual, execFileWithDeadline: async (...input: Parameters<typeof actual.execFileWithDeadline>) => {
        if (!input[2]?.inputBytes || input[1]?.at(-1) !== 'agent-launch') return actual.execFileWithDeadline(...input);
        const { runWorkspaceCheckoutCwdBoundary } = await import('./workspaceCheckoutNative.testkit');
        const cwd = await runWorkspaceCheckoutCwdBoundary(input[2].inputBytes, input[2].signal);
        if (cwd) return cwd;
        const frame = await readAgentLaunchFrame(Readable.from([input[2].inputBytes], { objectMode: false }), undefined, true);
        expect(frame).toMatchObject({ action: 'retire_operation' });
        boundary.phases.push('native_retired');
        return { stdout: '', stderr: '' };
    } };
});
afterEach(() => { boundary.reset(); vi.restoreAllMocks(); });

it.skipIf(process.platform !== 'linux')('keeps lazy private dotenv reads inside the member reader lifetime', async () => {
    await withTempDir('member-project-dotenv-', async directory => {
        const requesterIdentity = { kind: 'isolated' as const, separationRequired: true,
            requester: { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } };
        const memberIdentity = { ...deriveAgentIsolationMemberIdentity({ ...requesterIdentity, homeServerIdentityId: 'home' }),
            agentUid: 2401, agentGid: 2401 };
        const workspaceRoot = memberIdentity.workspaceRoot;
        const root = join(workspaceRoot, 'accepted');
        const backing = join(directory, 'accepted');
        await mkdir(backing, { recursive: true });
        await writeFile(join(backing, '.env'), 'DECLARED=member-private-value\nUNDECLARED=private-unselected\n', { mode: 0o600 });
        boundary.mounts = [{ path: workspaceRoot, backing: directory, uid: 2401, gid: 2400, mode: 0o40710 }];
        boundary.privateRoots = [root];
        boundary.launch = async (input, output) => {
            await readAgentLaunchFrame(input);
            await runWorkspaceEffectWorker([], { input, output, signal: new AbortController().signal, currentDirectory: () => workspaceRoot });
        };
        // The daemon can neither traverse nor read the private optional file.
        expect(await createProjectDotenvPreparation(root).read(['DECLARED']))
            .toMatchObject({ kind: 'refused', code: 'project_environment_binding_unavailable' });
        boundary.phases.length = 0;
        const workspace = { id: 'accepted', serverId: 'home', machineId: 'machine', rootPath: root,
            createdAtMs: 1, projectKey: 'project' };
        mockProjectAccountRowsHttpBoundary([createPlainProjectAccountRefRow(workspace)]);
        const snapshot = { enabled: true, memberProvisioning: 'linuxUsersV1' as const,
            status: { kind: 'effective' as const, platform: 'linux' as const }, workspaceRoots: [] };
        const runtime = { credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'member' })).toString('base64url')}.signature`, encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://member-home.test', requesterIdentity,
            agentIsolation: { read: () => snapshot },
            nativeOperationRuntime: { prepareNativeOperation: (input: Parameters<typeof prepareRequesterNativeOperation>[0]) => prepareRequesterNativeOperation(input, {
                homeServerIdentityId: 'home', machineId: 'machine', installationId: 'installation',
                machine: { read: () => snapshot, managedHappierBinaryPath: '/opt/happier/cli/current/happier',
                    readMember: async () => ({ identity: memberIdentity, daemonObservation: {
                        daemonIdentity: 'nonRoot', daemonUid: 2400, daemonUsername: 'daemon', daemonPrimaryGroup: 'daemon',
                    } }) },
            }) } };
        const prepared = createProjectRuntimeDotenvPreparation({ runtime, ingress: { signal: new AbortController().signal },
            workspace,
            context: {}, originalEnvironment: {} });
        expect(await prepared.read([])).toMatchObject({ kind: 'ready', environment: {} });
        expect(boundary.phases).toEqual([]);
        const [first, concurrent] = await Promise.all([prepared.read(['DECLARED']), prepared.read(['DECLARED'])]);
        expect(first).toMatchObject({ kind: 'ready', environment: { DECLARED: 'member-private-value' } });
        expect(concurrent).toEqual(first);
        expect(JSON.stringify(first)).not.toContain('private-unselected');
        await writeFile(join(backing, '.env'), 'DECLARED=changed\n');
        expect(await prepared.read(['DECLARED'])).toEqual(first);
        expect(boundary.phases.filter(phase => phase === 'native_spawn')).toHaveLength(1);
        expect(boundary.phases).not.toContain('daemon_private_readback_denied');
        expect(boundary.childFailure).toBeUndefined();
    });
});

it.skipIf(process.platform !== 'linux').each([PROJECT_DEFINITION_INSPECT_ACTION_ID, PROJECT_WORKTREE_PORTS_REASSIGN_ACTION_ID].flatMap(actionId =>
    (['own', 'foreign', 'symlink'] as const).map(mode => ({ actionId, mode }))))(
    'runs $actionId through the accepted member checkout native lifetime ($mode)', async ({ actionId, mode }) => {
    await withTempDir('member-project-inspect-', async directory => {
        const workspaceRoot = join(directory, 'member');
        const ownRoot = join(workspaceRoot, 'accepted');
        const foreignRoot = join(directory, 'other-member', 'accepted');
        const bytes = '{"version":1,"future":{"member":"own"}}';
        await mkdir(join(ownRoot, '.happier'), { recursive: true });
        await mkdir(join(foreignRoot, '.happier'), { recursive: true });
        await writeFile(join(ownRoot, '.happier/project.json'), bytes);
        await writeFile(join(foreignRoot, '.happier/project.json'), '{"version":1,"future":{"private":"foreign"}}');
        if (mode === 'symlink') await symlink(foreignRoot, join(workspaceRoot, 'escaped'), 'dir');
        const root = mode === 'own' ? ownRoot : mode === 'foreign' ? foreignRoot : join(workspaceRoot, 'escaped');
        boundary.privateRoots = [ownRoot, foreignRoot, join(workspaceRoot, 'escaped')];
        boundary.memberUnreadableRoots = [foreignRoot];
        const requesterIdentity = { kind: 'isolated' as const, separationRequired: true,
            requester: { serverId: 'profile', accountId: 'member', machineId: 'machine', installationId: 'installation' } };
        const memberIdentity = { ...deriveAgentIsolationMemberIdentity({ ...requesterIdentity, homeServerIdentityId: 'home' }),
            workspaceRoot, home: workspaceRoot, agentUid: 2401, agentGid: 2401 };
        const snapshot = { enabled: true, status: { kind: 'effective' as const, platform: 'linux' as const, agentUser: 'happier-agent' as const },
            workspaceRoots: [workspaceRoot], memberIdentity, localTransport: { agentUid: 2401, agentGid: 2401 },
            launch: { managedHappierBinaryPath: '/opt/happier/cli/current/happier', runtimeHome: join(workspaceRoot, 'runtime'),
                environment: {}, selectedEnvironmentKeys: [], selectedMaterials: [] } };
        boundary.launch = async (input, output) => {
            const frame = await readAgentLaunchFrame(input);
            expect(frame.nativeIdentity?.agentUid).toBe(2401);
            await runWorkspaceEffectWorker([], { input, output, signal: new AbortController().signal, currentDirectory: () => workspaceRoot });
        };
        const signal = new AbortController().signal;
        const operations = createActionOperationStore();
        operations.create({ operationId: 'other-preparing', scope: { accountId: 'other-member', machineId: 'machine' },
            actionId: 'projects.prepare', title: 'Prepare', cancellation: 'supported', inputIdentity: '{}',
            domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'home', machineId: 'machine', workspaceRefId: 'other-accepted', cwd: foreignRoot } });
        operations.create({ operationId: 'preparing', scope: { accountId: 'member', machineId: 'machine' },
            actionId: 'projects.prepare', title: 'Prepare', cancellation: 'supported', inputIdentity: '{}',
            domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'home', machineId: 'machine', workspaceRefId: 'accepted', cwd: root } });
        const inspect = () => createProjectDefinitionAction({ serverId: 'home', machineId: 'machine', workingDirectory: root,
            accessPolicy: { kind: 'restrictedRoots', roots: [root] }, readActiveProjectCommands: operations.readActiveProjectCommands })({ actionId,
            input: { workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'accepted', rootPath: root },
                ...(actionId === PROJECT_DEFINITION_INSPECT_ACTION_ID ? { read: { kind: 'editor', target: 'repository' } } : {}) }, context: { surface: 'cli' } });
        if (mode === 'own' && actionId === PROJECT_DEFINITION_INSPECT_ACTION_ID) {
            await expect(inspect()).rejects.toMatchObject({ code: 'EACCES' });
            expect(boundary.phases).toContain('daemon_definition_read');
            boundary.phases.length = 0;
        }
        let result: unknown;
        let failure: unknown;
        try {
            result = await readProjectAsMember({ agentIsolation: { read: () => snapshot }, requesterIdentity,
                workspaceRoot, root, signal, read: inspect });
        } catch (error) { failure = error; }
        expect(boundary.phases).not.toContain('daemon_definition_read');
        expect(boundary.phases).not.toContain('daemon_private_readback_denied');
        if (mode === 'own') {
            expect(failure).toBeUndefined();
            if (actionId === PROJECT_DEFINITION_INSPECT_ACTION_ID) {
                expect(result).toMatchObject({ definition: { document: { bytes } } });
                expect(boundary.phases).toContain('member_definition_read');
            } else expect(result).toMatchObject({ kind: 'unavailable', code: 'project_worktree_ports_active', reason: 'active' });
        } else {
            expect(failure).toMatchObject({ data: { code: 'project_workspace_unavailable' } });
            expect(result).toBeUndefined();
            expect(boundary.phases).not.toContain('member_definition_read');
        }
        expect(boundary.childFailure).toBeUndefined();
    });
});

it.skipIf(process.platform !== 'linux').each([PROJECT_DEFINITION_INSPECT_ACTION_ID, PROJECT_WORKTREE_PORTS_REASSIGN_ACTION_ID])(
    'keeps requester Account reads and native allocation around the installed %s action', async actionId => {
    await withTempDir('accepted-member-project-', async directory => {
        const requesterIdentity = { kind: 'isolated' as const, separationRequired: true,
            requester: { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } };
        const memberIdentity = { ...deriveAgentIsolationMemberIdentity({ ...requesterIdentity, homeServerIdentityId: 'home' }),
            agentUid: 2401, agentGid: 2401 };
        const root = join(memberIdentity.workspaceRoot, 'accepted');
        const backing = join(directory, 'accepted');
        const bytes = '{"version":1,"future":{"requester":"member"}}';
        await mkdir(join(backing, '.happier'), { recursive: true });
        await writeFile(join(backing, '.happier/project.json'), bytes);
        boundary.mounts = [{ path: memberIdentity.workspaceRoot, backing: directory, uid: 2401, gid: 2400, mode: 0o40710 }];
        boundary.privateRoots = [root];
        boundary.launch = async (input, output) => {
            const frame = await readAgentLaunchFrame(input);
            expect(frame).toMatchObject({ nativeIdentity: { agentUid: 2401 }, selectedMaterials: [] });
            expect(JSON.stringify(frame)).not.toContain(credentials.token);
            await runWorkspaceEffectWorker([], { input, output, signal: new AbortController().signal, currentDirectory: () => memberIdentity.workspaceRoot });
        };
        const rows = [createPlainProjectAccountRefRow({ id: 'accepted', serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1 })];
        const accountHttp = mockProjectAccountRowsHttpBoundary(rows);
        const signal = new AbortController().signal;
        const ingress: RpcHandlerContext = { signal, transportRequestId: 'member-inspection' };
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'member' })).toString('base64url')}.signature`, encryption: null };
        const snapshot = { enabled: true, memberProvisioning: 'linuxUsersV1' as const,
            status: { kind: 'effective' as const, platform: 'linux' as const }, workspaceRoots: [] };
        const runtime = { credentials, serverId: 'home', serverHttpBaseUrl: 'https://member-home.test',
            requesterIdentity, nativeOperationRuntime: { prepareNativeOperation: (input: Parameters<typeof prepareRequesterNativeOperation>[0]) => prepareRequesterNativeOperation(input, {
                homeServerIdentityId: 'home', machineId: 'machine', installationId: 'installation',
                machine: { read: () => snapshot, managedHappierBinaryPath: '/opt/happier/cli/current/happier',
                    readMember: async () => ({ identity: memberIdentity, daemonObservation: {
                        daemonIdentity: 'nonRoot', daemonUid: 2400, daemonUsername: 'daemon', daemonPrimaryGroup: 'daemon',
                    } }) },
            }) } };
        const operations = createActionOperationStore();
        const terminals = createTerminalPtySessionManager({ config: readDaemonTerminalPtyConfig({}).sessionManager,
            platform: 'linux', env: {}, ptyProvider: { spawn: () => ({ pid: 0, write() {}, resize() {}, kill() {},
                onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) }) } });
        onTestFinished(() => terminals.dispose());
        const otherRoot = join(directory, 'other-member', 'accepted');
        boundary.memberUnreadableRoots = [otherRoot];
        for (const [workspaceRefId, rootPath] of [['other-accepted', otherRoot], ['accepted', root]] as const) {
            expect(await terminals.ensure({ terminalKey: workspaceRefId, cwd: rootPath,
                launchProcess: { file: '/bin/sh', args: [], env: {} },
                custody: { serverId: 'home', requesterAccountId: workspaceRefId === 'accepted' ? 'member' : 'other-member',
                    machineId: 'machine', installationId: 'installation', workspaceRefId,
                    projectKey: workspaceRefId, rootPath } })).toMatchObject({ ok: true });
        }
        const client: ApiMachineClient = Object.assign(Object.create(ApiMachineClient.prototype), {
            machine: { id: 'machine' }, machineRpcWorkingDirectory: directory,
            filesystemAccessPolicy: { kind: 'restrictedRoots', roots: [directory] },
            lifecycleDependencies: { agentIsolation: { read: () => snapshot } },
            rpcLifecycleRegistrations: [{ resolveProjectFiniteRuntime: async () => runtime,
                readActiveProjectCommands: operations.readActiveProjectCommands, getFiniteTerminalSessions: () => terminals }],
        });
        const result = await client.createProjectDefinitionAction('home', ingress)({ actionId,
            input: { workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'accepted', rootPath: root },
                ...(actionId === PROJECT_DEFINITION_INSPECT_ACTION_ID ? { read: { kind: 'editor', target: 'repository' } } : {}) }, context: {} });
        if (actionId === PROJECT_DEFINITION_INSPECT_ACTION_ID) {
            expect(result).toMatchObject({ definition: { document: { bytes } } });
            expect(boundary.phases).toContain('member_definition_read');
        } else expect(result).toMatchObject({ kind: 'unavailable', code: 'project_worktree_ports_active', reason: 'active' });
        expect(boundary.phases).not.toContain('daemon_definition_read');
        expect(boundary.phases).not.toContain('daemon_private_readback_denied');
        expect(boundary.phases.at(-1)).toBe('native_retired');
        expect(accountHttp.mock.calls.every(call => call[2]?.headers?.Authorization === `Bearer ${credentials.token}`)).toBe(true);
        expect(rows).toHaveLength(1);
    });
});
