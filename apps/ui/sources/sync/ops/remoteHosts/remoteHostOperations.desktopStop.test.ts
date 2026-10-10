import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
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
// Tauri event subscription is the desktop OS boundary; the bridge and runner remain real.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
const { storage } = await import('@/sync/domains/state/storage');
void storage;
const [{ createUiRemoteHostActionExecuteV1 }, { captureLazyActionAccountContext }] = await Promise.all([
    import('./remoteHostOperations'), import('@/sync/ops/actions/actionAccountContext'),
]);

afterEach(async () => { await standardCleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await home.reset(); });

it('starts the exact desktop stop task and leaves terminal failure settlement with the incumbent runner', async () => {
    const specs: unknown[] = [];
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
        if (command === 'start_system_task') {
            specs.push(JSON.parse(String(args.specJson)));
            return { taskId: 'desktop-stop-exact' };
        }
        if (command === 'get_system_task_snapshot') return { events: [], result: {
            protocolVersion: 1, taskId: 'desktop-stop-exact', ok: false, error: { code: 'stop_failed', message: 'Stop failed' },
        } };
        throw new Error(`Unexpected desktop command: ${command}`);
    } });
    const serverId = await home.addHome({ name: 'Desktop tunnel', serverUrl: 'https://desktop-tunnel.test', accountId: 'owner' });
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const result = await createUiRemoteHostActionExecuteV1(account)({ actionId: 'remote_hosts.tunnel.stop',
            input: { target: { kind: 'desktop', tunnelKey: 'exact-private-tunnel' } } }, {});
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
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
        if (command === 'start_system_task') {
            const spec = JSON.parse(String(args.specJson));
            if (spec.kind === 'daemon.sshTunnel.stop.v1') throw new Error('system task bridge unavailable');
            return { taskId: 'desktop-list-for-stop-error' };
        }
        if (command === 'get_system_task_snapshot') return { events: [], result: {
            protocolVersion: 1, taskId: 'desktop-list-for-stop-error', ok: true, data: { ok: true, tunnels: [] },
        } };
        throw new Error(`Unexpected desktop command: ${command}`);
    } });
    await loadSyncSingletonForTests();
    const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
    resetScopedHomeActionExecutorsForTests();
    const serverId = await home.addHome({ name: 'Desktop stop error', serverUrl: 'https://desktop-stop-error.test',
        serverIdentityId: 'desktop-stop-error', accountId: 'owner', currentAccount: true });
    const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
        approvalWaivedSurfaces: { 'remote_hosts.tunnel.stop': ['ui'] } }) };
    storage.setState({ settings, settingsVersion: 1 });
    home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
    const { useRemoteHostSshTunnelControl } = await import('@/components/settings/remoteHosts/useRemoteHostSshTunnelControl');
    const { t } = await import('@/text');
    const hook = await renderHook(useRemoteHostSshTunnelControl);
    try {
        await act(async () => { await hook.getCurrent().stopTunnel('exact-private-failed-tunnel'); });
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().isUnavailable).toBe(true);
            expect(hook.getCurrent().lastErrorMessage).toBe(t('settings.systemTaskBridgeUnavailable'));
        });
    } finally { await hook.unmount(); }
});
