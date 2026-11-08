import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { authorizeResolvedProjectExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { admitAgentIsolationLaunchForHost, type HostAgentIsolationLaunchSnapshot,
    type HostRequesterExecutionIdentity } from './agentIsolationLaunchPolicy';
import { createAgentIsolationSessionContext } from './agentIsolationSessionContext';
import { logger } from '@/ui/logger';

it.skipIf(process.platform !== 'linux')('admits a shared-agent Session with its prepared native home before any Project exists', async () => {
    await withTempDir('shared-session-native-home-', async home => {
        const requester = { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' };
        const material = { runtimeHome: join(home, 'runtime'), environment: {}, selectedMaterials: [] };
        const context = createAgentIsolationSessionContext({
            machine: { read: () => ({ enabled: true, status: { kind: 'effective', platform: 'linux' }, workspaceRoots: [] }) },
            managedHappierBinaryPath: '/managed/happier', sessionRequester: requester,
            sessionRequesterHomeServerIdentityId: 'home', hostHomeServerIdentityId: 'home',
            sessionCustodianAccountId: 'owner', readMaterial: () => material,
        });
        const launch = await authorizeResolvedProjectExecLaunchForHost({
            launch: { command: '/bin/echo', args: ['ready'], cwd: home, env: {} },
            agentIsolation: context, agentNativeLaunch: true,
            sessionMcpContext: { v: 1, socketPath: join(home, 'mcp.sock'), bearerToken: 'synthetic-session-token' },
            mcpLaunchMaterial: { ...material, nativeIdentity: { home, agentUid: 2401, agentGid: 2401 } },
            signal: new AbortController().signal, assertCurrent() {},
        });
        try {
            expect(launch).toMatchObject({ command: 'sudo', cwd: home, launcherCwd: process.cwd() });
            expect(launch.args).toEqual(['-n', '-u', 'happier-agent', '--', '/managed/happier', 'agent-launch']);
        } finally { await launch.release(); }
    });
});

afterEach(() => vi.restoreAllMocks());

const requester: HostRequesterExecutionIdentity = { kind: 'isolated', separationRequired: true,
    requester: { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } };
const snapshot = (root: string): HostAgentIsolationLaunchSnapshot => ({ enabled: true,
    status: { kind: 'effective', platform: 'linux' }, workspaceRoots: [root], localTransport: { agentUid: 2401 },
    launch: { managedHappierBinaryPath: '/managed/happier', runtimeHome: '/member/runtime',
        selectedEnvironmentKeys: [], selectedMaterials: [] } });

it.skipIf(process.platform !== 'linux')('identifies the exact workspace admission branch and checked cwd in file diagnostics', async () => {
    await withTempDir('workspace-refusal-diagnostics-', async cwd => {
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        await expect(admitAgentIsolationLaunchForHost({ cwd, requesterIdentity: requester, agentNativeLaunch: true,
            context: { read: () => ({ ...snapshot(cwd), workspaceRoots: [] }) } }))
            .rejects.toMatchObject({ code: 'agent_isolation_unavailable', details: { reason: 'workspace_not_ready' } });
        expect(diagnostic).toHaveBeenCalledWith('[P11] Workspace admission refused', expect.objectContaining({
            branch: 'workspace_roots_empty', cwd, requestedCwd: cwd,
            ...(process.geteuid ? { effectiveUid: process.geteuid() } : {}),
        }));
    });
});

it.skipIf(process.platform !== 'linux')('walks member roots only after preparation creates the admitted workspace', async () => {
    await withTempDir('member-admitted-roots-', async root => {
        const cwd = join(root, 'workspace');
        const prepared = snapshot(cwd);
        const admitted = await admitAgentIsolationLaunchForHost({ cwd, requesterIdentity: requester, agentNativeLaunch: true,
            context: { read: () => ({ ...prepared, workspaceRoots: [] }), async prepareLaunch() {
                await filesystem.mkdir(cwd);
                return { read: () => prepared };
            } } });
        expect(admitted).toMatchObject({ cwd, snapshot: { localTransport: { agentUid: 2401 } } });
    });
});

it.skipIf(process.platform !== 'linux')('resolves one requester and walks each path once; withdrawal applies at the next admission', async () => {
    await withTempDir('member-admitted-once-', async cwd => {
        const held = snapshot(cwd);
        let current: HostRequesterExecutionIdentity = requester;
        let requesterReads = 0;
        const paths = vi.spyOn(filesystem, 'realpath');
        const context = { read: () => held,
            async resolveRequesterIdentity() { requesterReads++; return current; },
            async prepareLaunch() {
                current = { kind: 'unknown', reason: 'requester_authority_unavailable' };
                return { read: () => held };
            } };
        await expect(admitAgentIsolationLaunchForHost({ cwd, agentNativeLaunch: true, context })).resolves.toMatchObject({ cwd });
        expect(requesterReads).toBe(1);
        expect(paths.mock.calls.filter(([path]) => path === cwd)).toHaveLength(2);
        await expect(admitAgentIsolationLaunchForHost({ cwd, agentNativeLaunch: true, context }))
            .rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
        expect(requesterReads).toBe(2);
    });
});

it.skipIf(process.platform !== 'linux')('consumes an already verified requester without invoking its resolver again', async () => {
    await withTempDir('member-held-requester-', async cwd => {
        let requesterReads = 0;
        await expect(admitAgentIsolationLaunchForHost({ cwd, requesterIdentity: requester,
            context: { read: () => snapshot(cwd), async resolveRequesterIdentity() {
                requesterReads++; return { kind: 'unknown', reason: 'requester_authority_unavailable' };
            } } })).resolves.toMatchObject({ cwd });
        expect(requesterReads).toBe(0);
    });
});

it.skipIf(process.platform !== 'linux')('resolves requester custody once through the production Exec tuple finalizer', async () => {
    await withTempDir('member-exec-admission-', async cwd => {
        let requesterReads = 0;
        const launch = await authorizeResolvedProjectExecLaunchForHost({
            launch: { command: '/bin/echo', args: ['ready'], cwd, env: {} },
            agentIsolation: { read: () => snapshot(cwd), async resolveRequesterIdentity() {
                requesterReads++; return requester;
            }, async prepareLaunch() { return { read: () => snapshot(cwd) }; } },
            signal: new AbortController().signal, assertCurrent() {},
        });
        try {
            expect(launch).toMatchObject({ command: 'sudo' });
            expect(requesterReads).toBe(1);
        } finally { await launch.release(); }
    });
});
