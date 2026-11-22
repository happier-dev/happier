import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { createProjectDefinitionAction } from '@/rpc/handlers/projectDefinitions';
import { inspectProjectAsMember } from '@/workspaces/projectSetup/projectSetupReadiness';
import { prepareRequesterNativeOperation } from '@/daemon/agentIsolation/prepareNativeOperation';
import { createPlainProjectAccountRefRow, mockProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { readProjectAsMember } from './memberProjectInspection';
import { runWorkspaceEffectWorker } from './workspaceEffectWorker';
import { workspaceCheckoutNativeBoundary as boundary } from './workspaceCheckoutNative.testkit';

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
        expect(command).toBe('sudo');
        expect(args.slice(-2)).toEqual(['/opt/happier/cli/current/happier', 'agent-launch']);
        return spawnWorkspaceCheckoutNativeBoundary(actual.spawn, options);
    } };
});
vi.mock('@happier-dev/cli-common/process', async importOriginal => {
    const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
    return { ...actual, execFileWithDeadline: async (...input: Parameters<typeof actual.execFileWithDeadline>) => {
        if (input[0] !== 'sudo') return actual.execFileWithDeadline(...input);
        const frame = await readAgentLaunchFrame(Readable.from([input[2]!.inputBytes], { objectMode: false }), undefined, true);
        expect(frame).toMatchObject({ action: 'retire_operation' });
        boundary.phases.push('native_retired');
        return { stdout: '', stderr: '' };
    } };
});
afterEach(() => { boundary.reset(); vi.restoreAllMocks(); });

it.skipIf(process.platform !== 'linux').each(['own', 'foreign', 'symlink'] as const)(
    'inspects an accepted member checkout through its native read lifetime (%s)', async mode => {
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
        const inspect = () => createProjectDefinitionAction({ serverId: 'home', machineId: 'machine', workingDirectory: root,
            accessPolicy: { kind: 'restrictedRoots', roots: [root] } })({ actionId: 'projects.inspect',
            input: { workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'accepted', rootPath: root },
                read: { kind: 'editor', target: 'repository' } }, context: { surface: 'cli' } });
        if (mode === 'own') {
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
        if (mode === 'own') {
            expect(failure).toBeUndefined();
            expect(result).toMatchObject({ definition: { document: { bytes } } });
            expect(boundary.phases).toContain('member_definition_read');
        } else {
            expect(failure).toMatchObject({ data: { code: 'project_workspace_unavailable' } });
            expect(result).toBeUndefined();
            expect(boundary.phases).not.toContain('member_definition_read');
        }
        expect(boundary.childFailure).toBeUndefined();
    });
});

it.skipIf(process.platform !== 'linux')('keeps requester Account reads and native allocation around the complete accepted-checkout inspection', async () => {
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
        const result = await inspectProjectAsMember({ runtime: { credentials, serverId: 'home', serverHttpBaseUrl: 'https://member-home.test',
            requesterIdentity, nativeOperationRuntime: { prepareNativeOperation: input => prepareRequesterNativeOperation(input, {
                homeServerIdentityId: 'home', machineId: 'machine', installationId: 'installation',
                machine: { read: () => snapshot, managedHappierBinaryPath: '/opt/happier/cli/current/happier',
                    readMember: async () => ({ identity: memberIdentity, daemonObservation: {
                        daemonIdentity: 'nonRoot', daemonUid: 2400, daemonUsername: 'daemon', daemonPrimaryGroup: 'daemon',
                    } }) },
            }) } }, ingress, workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'accepted', rootPath: root }, context: {},
            read: capturedRoot => createProjectDefinitionAction({ serverId: 'home', machineId: 'machine', workingDirectory: capturedRoot,
                accessPolicy: { kind: 'restrictedRoots', roots: [capturedRoot] } })({ actionId: 'projects.inspect',
                    input: { workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'accepted', rootPath: root },
                        read: { kind: 'editor', target: 'repository' } }, context: {} }) });
        expect(result).toMatchObject({ definition: { document: { bytes } } });
        expect(boundary.phases).toContain('member_definition_read');
        expect(boundary.phases).not.toContain('daemon_definition_read');
        expect(boundary.phases.at(-1)).toBe('native_retired');
        expect(accountHttp.mock.calls.every(call => call[2]?.headers?.Authorization === `Bearer ${credentials.token}`)).toBe(true);
        expect(rows).toHaveLength(1);
    });
});
