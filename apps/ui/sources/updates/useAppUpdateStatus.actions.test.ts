import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createRootLayoutFeaturesResponse, renderHook } from '@/dev/testkit';
import { useAppUpdateStatus } from './useAppUpdateStatus';
import { executeAppUpdateAction } from './appUpdateActionRuntime';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// Tauri IPC/events and Expo's native SDK are genuine platform boundaries. No updater is mocked.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('expo-updates', () => ({
    useUpdates: () => ({ currentlyRunning: { isEmbeddedLaunch: true }, isChecking: false,
        isDownloading: false, isRestarting: false, isUpdateAvailable: false, isUpdatePending: false }),
    checkForUpdateAsync: () => { throw new Error('Unexpected native OTA check in desktop renderer'); },
    fetchUpdateAsync: () => { throw new Error('Unexpected native OTA fetch in desktop renderer'); },
    reloadAsync: () => { throw new Error('Unexpected native OTA restart in desktop renderer'); },
}));
// Session-envelope HTTP/process work is unrelated to this app-update journey.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Unexpected Session-envelope API call'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('executes desktop skip, check, update, retry and restart through the mounted canonical app owner', async () => {
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_DESKTOP_UPDATES_ENABLED', '1');
    vi.stubGlobal('__DEV__', false);
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => { saved.set(key, value); } });
    let offeredVersion = '1.2.0';
    let downloads = 0;
    const invoke = vi.fn(async (command: string) => {
        if (command === 'desktop_fetch_update') return { version: offeredVersion, currentVersion: '1.0.0', downloaded: false };
        if (command === 'desktop_download_update') {
            downloads += 1;
            if (downloads === 1) throw new Error('test-only download failure');
            return true;
        }
        if (command === 'desktop_install_update') return true;
        throw new Error(`Unexpected platform command: ${command}`);
    });
    const internals = { invoke };
    vi.stubGlobal('__TAURI_INTERNALS__', internals);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: internals, addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(createRootLayoutFeaturesResponse({
        features: { updates: { ota: { enabled: false } } },
    }))));
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ appUpdateAction: executeAppUpdateAction }));
    const context = { surface: 'ui' as const, authority: 'present_user' as const };
    const hook = await renderHook(() => useAppUpdateStatus());
    await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().model.item.state).toBe('available')); });
    expect(await executor.execute('app.updates.get', {}, context)).toMatchObject({ ok: true,
        result: { channel: 'desktop', latestVersion: '1.2.0', canSkip: true } });
    expect(await executor.execute('app.updates.skip', { version: 'different' }, context)).toMatchObject({ ok: false, errorCode: 'app_update_unavailable' });
    expect(saved.size).toBe(0);
    await act(async () => { await executor.execute('app.updates.skip', { version: '1.2.0' }, context); });
    expect(hook.getCurrent().model.item.skipped).toBe(true);
    expect(saved.get('desktop_update_dismissed_version')).toBe('1.2.0');
    offeredVersion = '1.3.0';
    await act(async () => { await executor.execute('app.updates.check', {}, context); });
    expect(hook.getCurrent().model.item).toMatchObject({ latestVersion: '1.3.0', skipped: false });
    await act(async () => {
        expect(await executor.execute('app.updates.update', {}, context)).toEqual({ ok: true, result: { status: 'requested' } });
    });
    expect(await executor.execute('app.updates.get', {}, context)).toMatchObject({ ok: true, result: { state: 'failed', action: 'retry' } });
    await act(async () => { await executor.execute('app.updates.retry', {}, context); });
    expect(downloads).toBe(2);
    expect(hook.getCurrent().model.item.state).toBe('ready');
    expect(invoke.mock.calls.some(([command]) => command === 'desktop_install_update')).toBe(false);
    await act(async () => { await executor.execute('app.updates.restart', {}, context); });
    expect(hook.getCurrent().model.item.state).toBe('running');
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_install_update')).toHaveLength(1);
    await hook.unmount();
    expect(await executor.execute('app.updates.get', {}, context)).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
});
