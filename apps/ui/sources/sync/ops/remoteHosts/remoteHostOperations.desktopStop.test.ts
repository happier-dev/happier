import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real', text: async () => vi.importActual<typeof import('@/text')>('@/text') });
// Metro's deferred module loader is the boundary; Action admission and the runner remain real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeEach(() => installHomeGovernanceBoundaries(home));
function installDesktopOsBoundary(invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>) {
    let callbackId = 0;
    // The actual Tauri event SDK reads the WebView globals, while Happier's command seam
    // also accepts globalThis. Both expose the same genuine native IPC boundary here.
    const internals = { transformCallback: () => ++callbackId,
        invoke: async (command: string, args: Record<string, unknown> = {}) =>
            command === 'plugin:event|listen' ? ++callbackId
                : command === 'plugin:event|unlisten' ? undefined : invoke(command, args) };
    vi.stubGlobal('__TAURI_INTERNALS__', internals);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: internals,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
}
const { storage } = await import('@/sync/domains/state/storage');
void storage;
const [{ createUiRemoteHostActionExecuteV1 }, { captureLazyActionAccountContext }] = await Promise.all([
    import('./remoteHostOperations'), import('@/sync/ops/actions/actionAccountContext'),
]);

afterEach(async () => {
    await standardCleanup();
    const { publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    publishAppliedActiveServerRuntimeAvailability(false);
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); await home.reset();
});

it('discovers configured SSH hosts through the agent-visible Action and the existing desktop task owner', async () => {
    const hosts = [{ id: 'ssh-config:builder', alias: 'builder', hostname: 'builder.test', port: 2222,
        username: 'dev', source: 'ssh-config', sourcePath: '/home/dev/.ssh/config' }];
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    installDesktopOsBoundary(async (command, args) => {
        if (command === 'start_system_task') {
            expect(JSON.parse(String(args.specJson))).toEqual({ protocolVersion: 1, kind: 'local.ssh.discoverConfiguredHosts.v1', params: {} });
            return { taskId: 'configured-ssh-discovery' };
        }
        if (command === 'get_system_task_snapshot') return { events: [], result: {
            protocolVersion: 1, taskId: 'configured-ssh-discovery', ok: true, data: hosts,
        } };
        throw new Error(`Unexpected desktop command: ${command}`);
    });
    const serverId = await home.addHome({ name: 'SSH discovery', serverUrl: 'https://ssh-discovery.test', accountId: 'owner' });
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            remoteHostActionExecute: createUiRemoteHostActionExecuteV1(account),
        }));
        expect(await executor.execute('remote_hosts.ssh.discover', {}, { surface: 'agent',
            authority: 'account_automation', bypassApprovals: true }))
            .toMatchObject({ ok: true, result: { status: 'listed', hosts } });
    } finally { account.dispose(); }
});

async function mountDesktopTunnelControl(fixtureId: string, policy: unknown) {
    await loadSyncSingletonForTests();
    const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
    resetScopedHomeActionExecutorsForTests();
    const serverId = await home.addHome({ name: 'Desktop inventory policy', serverUrl: `https://desktop-policy-${fixtureId}.test`,
        serverIdentityId: `srv_desktop_policy_${fixtureId}`, accountId: 'owner', currentAccount: true });
    const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse(policy) };
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
    storage.setState({ profileScope: scope, settingsScope: scope, settings, settingsVersion: 1 });
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
    const { useRemoteHostSshTunnelControl } = await import('@/components/settings/remoteHosts/useRemoteHostSshTunnelControl');
    const hook = await renderHook(useRemoteHostSshTunnelControl);
    await flushHookEffects({ cycles: 20 });
    return { hook, serverId };
}

it('admits initial and explicit desktop tunnel Refresh through the disabled list Action', async () => {
    const specs: unknown[] = [];
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    installDesktopOsBoundary(async (command, args) => {
        if (command === 'start_system_task') {
            specs.push(JSON.parse(String(args.specJson)));
            return { taskId: 'disabled-list' };
        }
        if (command === 'get_system_task_snapshot') return { events: [], result: {
            protocolVersion: 1, taskId: 'disabled-list', ok: true, data: { ok: true, tunnels: [] },
        } };
        throw new Error(`Unexpected desktop command: ${command}`);
    });
    const { hook } = await mountDesktopTunnelControl('disabled', { v: 1, actions: { 'remote_hosts.tunnel.list': { enabled: false } } });
    try {
        expect(specs).toEqual([]);
        await act(async () => { expect(await hook.getCurrent().refreshTunnels()).toBeNull(); });
        expect(specs).toEqual([]);
        expect(hook.getCurrent().lastErrorMessage).toMatch(/disabled/);
    } finally { await hook.unmount(); }
});

it('keeps Account SSH discovery behind its disabled Action', async () => {
    const specs: unknown[] = [];
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    installDesktopOsBoundary(async (command, args) => {
        if (command === 'start_system_task') {
            specs.push(JSON.parse(String(args.specJson)));
            return { taskId: 'disabled-discovery' };
        }
        if (command === 'get_system_task_snapshot') return { events: [], result: {
            protocolVersion: 1, taskId: 'disabled-discovery', ok: true, data: [],
        } };
        throw new Error(`Unexpected desktop command: ${command}`);
    });
    const mounted = await mountDesktopTunnelControl('discovery-disabled', { v: 1, actions: {
        'remote_hosts.tunnel.list': { enabled: false }, 'remote_hosts.ssh.discover': { enabled: false },
    } });
    const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
    try {
        const result = await createFrontDoorActionExecute()('remote_hosts.ssh.discover', {}, {
            surface: 'agent', authority: 'account_automation', serverId: mounted.serverId,
        });
        expect(specs).toEqual([]);
        expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/disabled/) });
    } finally { await mounted.hook.unmount(); }
});

it('keeps desktop tunnel inventory behind an explicit Ask-first list Action', async () => {
    const specs: unknown[] = [];
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    installDesktopOsBoundary(async (command, args) => {
        if (command === 'start_system_task') {
            specs.push(JSON.parse(String(args.specJson)));
            return { taskId: 'unapproved-list' };
        }
        if (command === 'get_system_task_snapshot') return { events: [], result: {
            protocolVersion: 1, taskId: 'unapproved-list', ok: true, data: { ok: true, tunnels: [] },
        } };
        throw new Error(`Unexpected desktop command: ${command}`);
    });
    const { hook, serverId } = await mountDesktopTunnelControl('approval', { v: 1 });
    let refresh: Promise<string | null> | undefined;
    try {
        await act(async () => { expect(await hook.getCurrent().refreshTunnels()).toBe('unapproved-list'); });
        await flushHookEffects();
        const admittedBeforeAsk = specs.length;
        await act(async () => { await home.requireUiApproval(serverId, 'remote_hosts.tunnel.list'); });
        await act(async () => { refresh = hook.getCurrent().refreshTunnels(); });
        expect(hook.getCurrent().lastErrorMessage).toBeNull();
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().lastErrorMessage).toBeNull();
            expect(home.artifacts(serverId).list()).toHaveLength(1);
        });
        expect(specs).toHaveLength(admittedBeforeAsk);
        expect(hook.getCurrent().approval.approvalPending).toBe(true);
    } finally { await hook.unmount(); }
    expect(await refresh).toBeNull();
});

it('keeps successful desktop listing and refuses a Refresh whose Account retires during admission', async () => {
    const specs: Array<{ kind: string }> = [];
    const held = createDeferred<void>();
    const reached = createDeferred<void>();
    let holdRefresh = false;
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    installDesktopOsBoundary(async (command, args) => {
        if (command === 'start_system_task') {
            specs.push(JSON.parse(String(args.specJson)));
            if (holdRefresh) { reached.resolve(); await held.promise; }
            return { taskId: 'admitted-list' };
        }
        if (command === 'get_system_task_snapshot') return { events: [], result: {
            protocolVersion: 1, taskId: 'admitted-list', ok: true, data: { ok: true, tunnels: [] },
        } };
        throw new Error(`Unexpected desktop command: ${command}`);
    });
    const { hook, serverId } = await mountDesktopTunnelControl('retirement', { v: 1 });
    try {
        expect(hook.getCurrent().lastErrorMessage).toBeNull();
        await waitForHomeGovernance(() => expect(specs).toEqual([{ protocolVersion: 1, kind: 'daemon.sshTunnel.list.v1', params: {} }]));
        holdRefresh = true;
        let refresh: Promise<string | null> | undefined;
        await act(async () => { refresh = hook.getCurrent().refreshTunnels(); });
        await reached.promise;
        await act(async () => { await home.switchAccount(serverId, 'replacement', { currentAccount: true }); });
        held.resolve();
        await act(async () => { expect(await refresh).toBeNull(); });
        expect(specs).toHaveLength(2);
        expect(hook.getCurrent().lastErrorMessage).toBeNull();
    } finally { await hook.unmount(); }
});

it('returns active desktop tunnel inventory to an agent through Action admission and the existing system task', async () => {
    const specs: unknown[] = [];
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    installDesktopOsBoundary(async (command, args) => {
        if (command === 'start_system_task') {
            specs.push(JSON.parse(String(args.specJson)));
            return { taskId: 'desktop-list-action' };
        }
        if (command === 'get_system_task_snapshot') return { events: [], result: {
            protocolVersion: 1, taskId: 'desktop-list-action', ok: true, data: { ok: true, tunnels: [] },
        } };
        throw new Error(`Unexpected desktop command: ${command}`);
    });
    const serverId = await home.addHome({ name: 'Desktop inventory', serverUrl: 'https://desktop-inventory.test', accountId: 'owner' });
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            remoteHostActionExecute: createUiRemoteHostActionExecuteV1(account),
        }));
        expect(await executor.execute('remote_hosts.tunnel.list', {}, { surface: 'agent',
            authority: 'account_automation', bypassApprovals: true }))
            .toMatchObject({ ok: true, result: { status: 'completed', taskId: 'desktop-list-action',
                result: { ok: true, data: { ok: true, tunnels: [] } } } });
        expect(specs).toEqual([{ protocolVersion: 1, kind: 'daemon.sshTunnel.list.v1', params: {} }]);
    } finally { account.dispose(); }
});

it('starts the exact desktop stop task and leaves terminal failure settlement with the incumbent runner', async () => {
    const specs: unknown[] = [];
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    installDesktopOsBoundary(async (command, args) => {
        if (command === 'start_system_task') {
            specs.push(JSON.parse(String(args.specJson)));
            return { taskId: 'desktop-stop-exact' };
        }
        if (command === 'get_system_task_snapshot') return { events: [], result: {
            protocolVersion: 1, taskId: 'desktop-stop-exact', ok: false, error: { code: 'stop_failed', message: 'Stop failed' },
        } };
        throw new Error(`Unexpected desktop command: ${command}`);
    });
    const serverId = await home.addHome({ name: 'Desktop tunnel', serverUrl: 'https://desktop-tunnel.test', accountId: 'owner' });
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const result = await createUiRemoteHostActionExecuteV1(account)({ actionId: 'remote_hosts.tunnel.stop',
            input: { target: { kind: 'desktop', tunnelKey: 'exact-private-tunnel' } } }, { surface: 'ui', authority: 'present_user' });
        expect(result).toEqual({ ok: true, result: { status: 'task_started', taskId: 'desktop-stop-exact' } });
        expect(specs).toEqual([{ protocolVersion: 1, kind: 'daemon.sshTunnel.stop.v1', params: { tunnelKey: 'exact-private-tunnel' } }]);
        const { getDefaultSystemTaskRunner } = await import('@/components/systemTasks');
        expect(getDefaultSystemTaskRunner().getSnapshot('desktop-stop-exact')?.result).toMatchObject({ ok: false, error: { code: 'stop_failed' } });
        expect(await createUiRemoteHostActionExecuteV1(account)({ actionId: 'remote_hosts.tunnel.stop',
            input: { target: { kind: 'native', leaseId: 'native:unknown-on-desktop' } } }, {}))
            .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'native_host_required' } });
    } finally { account.dispose(); }
});

it('preserves desktop bridge failure settlement through mounted Action admission', async () => {
    let stopAttempted = false;
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    installDesktopOsBoundary(async (command, args) => {
        if (command === 'start_system_task') {
            const spec = JSON.parse(String(args.specJson));
            if (spec.kind === 'daemon.sshTunnel.stop.v1') {
                stopAttempted = true;
                throw new Error('system task bridge unavailable');
            }
            return { taskId: 'desktop-list-for-stop-error' };
        }
        if (command === 'get_system_task_snapshot') return { events: [], result: {
            protocolVersion: 1, taskId: 'desktop-list-for-stop-error', ok: true, data: { ok: true, tunnels: [] },
        } };
        throw new Error(`Unexpected desktop command: ${command}`);
    });
    await loadSyncSingletonForTests();
    const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
    resetScopedHomeActionExecutorsForTests();
    const serverId = await home.addHome({ name: 'Desktop stop error', serverUrl: 'https://desktop-stop-error.test',
        serverIdentityId: 'desktop-stop-error', accountId: 'owner', currentAccount: true });
    const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
        approvalWaivedSurfaces: { 'remote_hosts.tunnel.stop': ['ui'] } }) };
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
    storage.setState({ profileScope: scope, settingsScope: scope, settings, settingsVersion: 1 });
    home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
    const { useRemoteHostSshTunnelControl } = await import('@/components/settings/remoteHosts/useRemoteHostSshTunnelControl');
    const { t } = await import('@/text');
    const hook = await renderHook(useRemoteHostSshTunnelControl);
    try {
        // The real secure-storage scope producer resolves asynchronously after mount.
        await flushHookEffects({ cycles: 20 });
        await act(async () => { await hook.getCurrent().refreshTunnels(); });
        await flushHookEffects();
        let stopped: Promise<string | null> | undefined;
        await act(async () => { stopped = hook.getCurrent().stopTunnel('exact-private-failed-tunnel'); });
        await waitForHomeGovernance(() => expect(stopAttempted).toBe(true));
        await act(async () => { await stopped; });
        expect(hook.getCurrent().isUnavailable).toBe(true);
        expect(hook.getCurrent().lastErrorMessage).toBe(t('settings.systemTaskBridgeUnavailable'));
    } finally { await hook.unmount(); }
});
