import * as filesystem from 'node:fs/promises';
import * as nativeProcess from '@happier-dev/cli-common/process';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { authorizePluginExecLaunchForHost, authorizeResolvedProjectExecLaunchForHost,
    createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { admitAgentIsolationLaunchForHost, type HostAgentIsolationLaunchSnapshot,
    type HostRequesterExecutionIdentity } from './agentIsolationLaunchPolicy';
import { createAgentIsolationSessionContext } from './agentIsolationSessionContext';
import { logger } from '@/ui/logger';
import { deriveAgentIsolationMemberIdentity } from './provisioning';
import { readAgentLaunchFrame } from './agentLaunchFrame';

vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof filesystem>();
    return { ...actual, realpath: vi.fn(actual.realpath) };
});

vi.mock('@happier-dev/cli-common/process', async importOriginal => {
    const actual = await importOriginal<typeof nativeProcess>();
    return { ...actual, execFileWithDeadline: vi.fn(actual.execFileWithDeadline) };
});

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

afterEach(() => {
    vi.mocked(filesystem.realpath).mockReset();
    vi.mocked(nativeProcess.execFileWithDeadline).mockReset();
    vi.restoreAllMocks();
});

it.each([
    ['material', 'session_launch_material_missing'],
    ['binary', 'managed_binary_missing'],
    ['mcp', 'session_mcp_context_missing'],
] as const)('names the missing %s operand without exposing Session content', async (missing, cause) => {
    const context = createAgentIsolationSessionContext({
        machine: { read: () => ({ enabled: true, status: { kind: 'effective', platform: 'linux' }, workspaceRoots: [] }) },
        managedHappierBinaryPath: missing === 'binary' ? undefined : '/managed/happier',
        readMaterial: () => missing === 'material' ? undefined : { runtimeHome: '/member/runtime', environment: {}, selectedMaterials: [] },
    });
    await expect(context.prepareLaunch!({ agentNativeLaunch: true,
        ...(missing === 'mcp' ? {} : { sessionMcpContext: { v: 1, socketPath: '/private/mcp.sock', bearerToken: 'private-token' } }),
    })).rejects.toMatchObject({ code: 'agent_isolation_unavailable',
        details: { cause, phase: 'native_execution_preparation' } });
});

const requester: HostRequesterExecutionIdentity = { kind: 'isolated', separationRequired: true,
    requester: { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } };
const snapshot = (root: string): HostAgentIsolationLaunchSnapshot => ({ enabled: true,
    status: { kind: 'effective', platform: 'linux' }, workspaceRoots: [root], localTransport: { agentUid: 2401 },
    launch: { managedHappierBinaryPath: '/managed/happier', runtimeHome: '/member/runtime',
        selectedEnvironmentKeys: [], selectedMaterials: [] } });

it.skipIf(process.platform !== 'linux')('admits a member-private cwd through request Exec and refuses an older RunAs helper without host fallback', async () => {
    const memberIdentity = { ...deriveAgentIsolationMemberIdentity({ ...requester, homeServerIdentityId: 'home' }),
        agentUid: 2401, agentGid: 2401 };
    const root = join(memberIdentity.home, 'work');
    const cwd = join(root, 'alias');
    const canonicalCwd = join(root, 'repo');
    const runtimeHome = join(memberIdentity.home, 'runtime');
    const { realpath } = await vi.importActual<typeof filesystem>('node:fs/promises');
    const lookup = vi.mocked(filesystem.realpath).mockImplementation(path => {
        if (String(path).startsWith(memberIdentity.home + '/')) {
            return Promise.reject(Object.assign(new Error('daemon cannot traverse home'), { code: 'EACCES' }));
        }
        return realpath(path);
    });
    const { execFileWithDeadline: run } = await vi.importActual<typeof nativeProcess>('@happier-dev/cli-common/process');
    let oldHelper = false;
    vi.mocked(nativeProcess.execFileWithDeadline).mockImplementation(async (command, args, options) => {
        if (!args.includes('/managed/happier') || !options?.inputBytes) return run(command, args, options);
        const request = await readAgentLaunchFrame(Readable.from([Buffer.from(options.inputBytes)], { objectMode: false }), undefined, true);
        expect(request).toMatchObject({ action: 'resolve_cwd', cwd, workspaceRoots: [root],
            nativeIdentity: { username: memberIdentity.username, agentUid: 2401, agentGid: 2401, home: memberIdentity.home } });
        expect(options.cwd).toBe(process.cwd());
        if (oldHelper) throw Object.assign(new Error('agent_launch_frame_invalid'), { code: 1 });
        return { stdout: JSON.stringify({ status: 'resolved', cwd: canonicalCwd, workspaceRoots: [root] }), stderr: '' };
    });
    const service = createStablePluginExecService({
        signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        resolveExecutable: async () => ({ command: '/bin/pwd' }), resolvePath: async () => cwd,
        agentIsolation: { requesterIdentity: requester, read: () => {
            const held = snapshot(root);
            return { ...held, memberIdentity, launch: { ...held.launch!, runtimeHome } };
        } },
    });
    const request = { executable: { kind: 'systemTool' as const, id: 'pwd' }, cwd };
    const launch = await authorizePluginExecLaunchForHost(service, request);
    try {
        expect(launch).toMatchObject({ command: 'sudo', cwd: canonicalCwd, launcherCwd: process.cwd() });
        const frame = await readAgentLaunchFrame(Readable.from([Buffer.from(launch.stdinPreamble!)], { objectMode: false }));
        expect(frame.cwd).toBe(canonicalCwd);
    } finally { await launch.release(); }
    oldHelper = true;
    await expect(authorizePluginExecLaunchForHost(service, request)).rejects.toMatchObject({
        code: 'agent_isolation_unavailable', details: { reason: 'workspace_not_ready' },
    });
    expect(lookup.mock.calls.filter(([path]) => path === cwd || path === root)).toEqual([]);
});

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
        const paths = vi.mocked(filesystem.realpath);
        paths.mockClear();
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
