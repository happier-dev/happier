import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { UseUpdatesReturnType } from 'expo-updates';

import { createDeferred, createRootLayoutFeaturesResponse, renderHook } from '@/dev/testkit';
import { flushHookEffects } from '@/hooks/server/serverFeatureHookHarness.testHelpers';

const appStateRef = vi.hoisted(() => ({
    listener: null as ((nextAppState: string) => void) | null,
    remove: vi.fn(),
}));

const platformRef = vi.hoisted(() => ({ current: 'ios' }));

const expoUpdatesStateRef = vi.hoisted(() => ({
    current: {
        currentlyRunning: {
            isEmbeddedLaunch: true,
            isEmergencyLaunch: false,
            emergencyLaunchReason: null,
            channel: 'preview',
            runtimeVersion: '18',
            updateId: 'current-update',
        },
        isStartupProcedureRunning: false,
        isChecking: false,
        isDownloading: false,
        isRestarting: false,
        isUpdateAvailable: false,
        isUpdatePending: false,
        restartCount: 0,
        checkError: undefined,
        downloadError: undefined,
        lastCheckForUpdateTimeSinceRestart: undefined,
        downloadProgress: undefined,
        availableUpdate: undefined,
        downloadedUpdate: undefined,
    } as UseUpdatesReturnType,
}));

const checkForUpdateAsyncMock = vi.hoisted(() => vi.fn(async () => ({ isAvailable: false })));
const fetchUpdateAsyncMock = vi.hoisted(() => vi.fn(async () => {}));
const reloadAsyncMock = vi.hoisted(() => vi.fn(async () => {}));
const useExpoUpdatesMock = vi.hoisted(() => vi.fn(() => expoUpdatesStateRef.current));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock();

    return {
        ...base,
        AppState: {
            addEventListener: vi.fn((_eventType: string, listener: (nextAppState: string) => void) => {
                appStateRef.listener = listener;
                return { remove: appStateRef.remove };
            }),
        },
        Platform: Object.defineProperties({ ...base.Platform }, {
            OS: {
                enumerable: true,
                get: () => platformRef.current,
            },
            select: {
                enumerable: true,
                value: <Value,>(config: { ios?: Value; android?: Value; web?: Value; default?: Value }) => {
                    return config[platformRef.current as keyof typeof config] ?? config.default;
                },
            },
        }),
    };
});

vi.mock('expo-updates', () => ({
    checkForUpdateAsync: checkForUpdateAsyncMock,
    fetchUpdateAsync: fetchUpdateAsyncMock,
    reloadAsync: reloadAsyncMock,
    useUpdates: useExpoUpdatesMock,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function stubFeatureResponse(otaEnabled: boolean): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
            ok: true,
            json: async () => createRootLayoutFeaturesResponse({
                features: {
                    updates: {
                        ota: { enabled: otaEnabled },
                    },
                },
            }),
        })) as unknown as typeof fetch,
    );
}

async function flushMore(): Promise<void> {
    await flushHookEffects(10);
}

async function flushMoreInAct(): Promise<void> {
    await act(async () => {
        await flushMore();
    });
}

beforeEach(() => {
    vi.stubGlobal('__DEV__', false);
    appStateRef.listener = null;
    appStateRef.remove.mockReset();
    appStateRef.remove.mockImplementation(() => {
        appStateRef.listener = null;
    });
    platformRef.current = 'ios';
    expoUpdatesStateRef.current = {
        currentlyRunning: {
            isEmbeddedLaunch: true,
            isEmergencyLaunch: false,
            emergencyLaunchReason: null,
            channel: 'preview',
            runtimeVersion: '18',
            updateId: 'current-update',
        },
        isStartupProcedureRunning: false,
        isChecking: false,
        isDownloading: false,
        isRestarting: false,
        isUpdateAvailable: false,
        isUpdatePending: false,
        restartCount: 0,
        checkError: undefined,
        downloadError: undefined,
        lastCheckForUpdateTimeSinceRestart: undefined,
        downloadProgress: undefined,
        availableUpdate: undefined,
        downloadedUpdate: undefined,
    };
    checkForUpdateAsyncMock.mockReset();
    checkForUpdateAsyncMock.mockResolvedValue({ isAvailable: false });
    fetchUpdateAsyncMock.mockReset();
    fetchUpdateAsyncMock.mockResolvedValue(undefined);
    reloadAsyncMock.mockReset();
    reloadAsyncMock.mockResolvedValue(undefined);
    useExpoUpdatesMock.mockImplementation(() => expoUpdatesStateRef.current);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useUpdates (OTA runtime)', () => {
    it('gates OTA checks and OTA-only state when updates.ota is disabled', async () => {
        stubFeatureResponse(false);
        expoUpdatesStateRef.current = {
            ...expoUpdatesStateRef.current,
            isChecking: true,
            isUpdateAvailable: true,
            isUpdatePending: true,
            downloadProgress: 0.5,
            lastCheckForUpdateTimeSinceRestart: new Date('2026-04-10T09:00:00.000Z'),
        };

        const { useUpdates } = await import('./useUpdates');
        const harness = await renderHook(() => useUpdates());
        await flushMoreInAct();

        expect(checkForUpdateAsyncMock).not.toHaveBeenCalled();
        expect(harness.getCurrent()).toMatchObject({
            otaUpdatesEnabled: false,
            updateAvailable: false,
            isChecking: false,
            isUpdateAvailable: false,
            isUpdatePending: false,
            downloadProgress: undefined,
            lastCheckForUpdateTimeSinceRestart: undefined,
            currentlyRunning: {
                isEmbeddedLaunch: true,
                channel: 'preview',
                runtimeVersion: '18',
                updateId: 'current-update',
            },
        });

        await harness.unmount();
    });

    it('reports OTA runtime as unsupported on web and hides OTA-only state', async () => {
        stubFeatureResponse(true);
        platformRef.current = 'web';
        expoUpdatesStateRef.current = {
            ...expoUpdatesStateRef.current,
            isChecking: true,
            isUpdateAvailable: true,
            isUpdatePending: true,
            downloadProgress: 0.5,
            lastCheckForUpdateTimeSinceRestart: new Date('2026-04-10T09:00:00.000Z'),
        };

        const { useUpdates } = await import('./useUpdates');
        const harness = await renderHook(() => useUpdates());
        await flushMoreInAct();

        expect(harness.getCurrent()).toMatchObject({
            otaUpdatesEnabled: true,
            otaRuntimeSupported: false,
            updateAvailable: false,
            isChecking: false,
            isUpdateAvailable: false,
            isUpdatePending: false,
            downloadProgress: undefined,
            lastCheckForUpdateTimeSinceRestart: undefined,
        });
        expect(checkForUpdateAsyncMock).not.toHaveBeenCalled();

        await harness.unmount();
    });

    it('shares startup checks across multiple consumers and exposes detailed OTA state', async () => {
        stubFeatureResponse(true);
        const lastChecked = new Date('2026-04-10T09:00:00.000Z');
        expoUpdatesStateRef.current = {
            ...expoUpdatesStateRef.current,
            isUpdateAvailable: true,
            isUpdatePending: true,
            downloadProgress: 1,
            lastCheckForUpdateTimeSinceRestart: lastChecked,
        };

        const { useUpdates } = await import('./useUpdates');
        const harness = await renderHook(() => {
            const first = useUpdates();
            const second = useUpdates();
            return { first, second };
        });
        await flushMoreInAct();
        await vi.waitFor(() => {
            expect(harness.getCurrent().first.otaUpdatesEnabled).toBe(true);
            expect(checkForUpdateAsyncMock).toHaveBeenCalledTimes(1);
        });
        expect(harness.getCurrent().first).toMatchObject({
            otaUpdatesEnabled: true,
            updateAvailable: true,
            isUpdateAvailable: true,
            isUpdatePending: true,
            downloadProgress: 1,
            lastCheckForUpdateTimeSinceRestart: lastChecked,
        });
        expect(harness.getCurrent().second.currentlyRunning).toMatchObject({
            isEmbeddedLaunch: true,
            isEmergencyLaunch: false,
            emergencyLaunchReason: null,
            channel: 'preview',
            runtimeVersion: '18',
            updateId: 'current-update',
        });

        await harness.unmount();
    });

    it('rechecks when the app becomes active through the shared runtime listener', async () => {
        stubFeatureResponse(true);

        const { useUpdates } = await import('./useUpdates');
        const harness = await renderHook(() => useUpdates());
        await flushMoreInAct();
        await vi.waitFor(() => {
            expect(harness.getCurrent().otaUpdatesEnabled).toBe(true);
        });

        expect(typeof appStateRef.listener).toBe('function');

        checkForUpdateAsyncMock.mockClear();
        await act(async () => {
            appStateRef.listener?.('active');
            await flushMore();
        });

        expect(checkForUpdateAsyncMock).toHaveBeenCalledTimes(1);

        await harness.unmount();
    });

    it('stops shared OTA app-state checks after updates.ota is disabled', async () => {
        stubFeatureResponse(true);

        const { useUpdates } = await import('./useUpdates');
        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');

        const firstHarness = await renderHook(() => useUpdates());
        await flushMoreInAct();
        await vi.waitFor(() => {
            expect(firstHarness.getCurrent().otaUpdatesEnabled).toBe(true);
            expect(typeof appStateRef.listener).toBe('function');
        });

        await firstHarness.unmount();
        resetServerFeaturesClientForTests();

        stubFeatureResponse(false);

        const secondHarness = await renderHook(() => useUpdates());
        await flushMoreInAct();
        await vi.waitFor(() => {
            expect(secondHarness.getCurrent().otaUpdatesEnabled).toBe(false);
        });

        checkForUpdateAsyncMock.mockClear();
        await act(async () => {
            appStateRef.listener?.('active');
            await flushMore();
        });

        expect(checkForUpdateAsyncMock).not.toHaveBeenCalled();

        await secondHarness.unmount();
    });

    it('dedupes concurrent manual checkForUpdates calls', async () => {
        stubFeatureResponse(true);

        const { useUpdates } = await import('./useUpdates');
        const harness = await renderHook(() => useUpdates());
        await flushMoreInAct();
        await vi.waitFor(() => {
            expect(harness.getCurrent().otaUpdatesEnabled).toBe(true);
        });

        checkForUpdateAsyncMock.mockClear();

        const deferred = createDeferred<void>();
        checkForUpdateAsyncMock.mockImplementationOnce(async () => {
            await deferred.promise;
            return { isAvailable: false };
        });

        const current = harness.getCurrent();
        let firstCheck!: Promise<void>;
        let secondCheck!: Promise<void>;
        await act(async () => {
            firstCheck = current.checkForUpdates();
            secondCheck = current.checkForUpdates();
        });

        expect(checkForUpdateAsyncMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            deferred.resolve();
            await Promise.all([firstCheck, secondCheck]);
        });

        await harness.unmount();
    });

    it('swallows manual OTA check failures from expo-updates', async () => {
        stubFeatureResponse(true);
        checkForUpdateAsyncMock.mockRejectedValueOnce(new Error('check failed'));

        const { useUpdates } = await import('./useUpdates');
        const harness = await renderHook(() => useUpdates());
        await flushMoreInAct();
        await vi.waitFor(() => {
            expect(harness.getCurrent().otaUpdatesEnabled).toBe(true);
        });

        checkForUpdateAsyncMock.mockClear();
        checkForUpdateAsyncMock.mockRejectedValueOnce(new Error('manual check failed'));

        await expect(harness.getCurrent().checkForUpdates()).resolves.toBeUndefined();
        expect(checkForUpdateAsyncMock).toHaveBeenCalledTimes(1);

        await harness.unmount();
    });

    it('swallows reload failures from expo-updates', async () => {
        stubFeatureResponse(true);

        const { useUpdates } = await import('./useUpdates');
        const harness = await renderHook(() => useUpdates());
        await flushMoreInAct();
        await vi.waitFor(() => {
            expect(harness.getCurrent().otaUpdatesEnabled).toBe(true);
        });

        reloadAsyncMock.mockRejectedValueOnce(new Error('reload failed'));

        await expect(harness.getCurrent().reloadApp()).resolves.toBeUndefined();
        expect(reloadAsyncMock).toHaveBeenCalledTimes(1);

        await harness.unmount();
    });
});
