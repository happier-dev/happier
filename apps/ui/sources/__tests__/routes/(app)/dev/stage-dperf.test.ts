import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';

// The route pulls in DemoStage -> captureStageFrame -> react-native-view-shot,
// whose untranspiled JSX barrel cannot be parsed under Vitest; stub the native
// capture boundary so the pure route logic under test can be imported.
vi.mock('react-native-view-shot', () => ({
    captureRef: vi.fn(async () => 'data:image/png;base64,demo'),
    releaseCapture: vi.fn(),
}));

import {
    DPERF_STAGE_FRAME_IDS,
    StageDperfDevRouteContent,
    isDevRouteEnabled,
    prepareStageDperfRuntime,
    resolveNextDperfStageFrameId,
} from '@/app/(app)/dev/stage-dperf';

type DevGlobal = typeof globalThis & { __DEV__?: boolean };

function withDevBuild<T>(enabled: boolean, run: () => T): T {
    const devGlobal = globalThis as DevGlobal;
    const hadOwnDevFlag = Object.prototype.hasOwnProperty.call(devGlobal, '__DEV__');
    const previousDevFlag = devGlobal.__DEV__;
    vi.stubGlobal('__DEV__', enabled);
    try {
        return run();
    } finally {
        if (hadOwnDevFlag) {
            vi.stubGlobal('__DEV__', previousDevFlag);
        } else {
            Reflect.deleteProperty(devGlobal, '__DEV__');
        }
    }
}

function withDebugRouteEnv<T>(value: string | undefined, run: () => T): T {
    const previousDebugFlag = process.env.EXPO_PUBLIC_DEBUG;
    if (value === undefined) {
        delete process.env.EXPO_PUBLIC_DEBUG;
    } else {
        process.env.EXPO_PUBLIC_DEBUG = value;
    }
    try {
        return run();
    } finally {
        if (previousDebugFlag === undefined) {
            delete process.env.EXPO_PUBLIC_DEBUG;
        } else {
            process.env.EXPO_PUBLIC_DEBUG = previousDebugFlag;
        }
    }
}

describe('stage D-PERF dev route frame loop', () => {
    it('loops only the seeded SessionView hero and spotlight frames', () => {
        expect(DPERF_STAGE_FRAME_IDS).toEqual([
            'session-view.hero',
            'session-view.spotlight',
        ]);
        expect(resolveNextDperfStageFrameId('session-view.hero')).toBe('session-view.spotlight');
        expect(resolveNextDperfStageFrameId('session-view.spotlight')).toBe('session-view.hero');
        expect(resolveNextDperfStageFrameId('missing')).toBe('session-view.hero');
    });

    it('preloads lazy stage surfaces before installing the demo firewall', async () => {
        const calls: string[] = [];

        await prepareStageDperfRuntime({
            seedDemoWorld: async () => {
                calls.push('seed');
            },
            preloadStageSurfaces: async (surfaceIds) => {
                calls.push(`preload:${surfaceIds.join(',')}`);
            },
            installDemoFirewall: () => {
                calls.push('firewall');
            },
        });

        expect(calls).toEqual([
            'seed',
            'preload:session-view',
            'firewall',
        ]);
    });

    it('cleans a seeded runtime exactly once when unmounted during preload', async () => {
        const preloadStarted = createDeferred<void>();
        const releasePreload = createDeferred<void>();
        const clearSeededWorld = vi.fn(async () => undefined);
        const uninstallFirewall = vi.fn();

        const screen = await renderScreen(
            React.createElement(StageDperfDevRouteContent, {
                runtimeDeps: {
                    seedDemoWorld: async () => undefined,
                    preloadStageSurfaces: async () => {
                        preloadStarted.resolve();
                        await releasePreload.promise;
                    },
                    installDemoFirewall: vi.fn(),
                    clearDemoWorld: clearSeededWorld,
                    uninstallDemoFirewall: uninstallFirewall,
                },
            }),
        );
        await preloadStarted.promise;

        await screen.unmount();
        expect(clearSeededWorld).toHaveBeenCalledTimes(1);

        releasePreload.resolve();
        await flushHookEffects();

        expect(clearSeededWorld).toHaveBeenCalledTimes(1);
        expect(uninstallFirewall).not.toHaveBeenCalled();
    });

    it('clears the seeded world before uninstalling the firewall on teardown', async () => {
        const calls: string[] = [];
        const screen = await renderScreen(
            React.createElement(StageDperfDevRouteContent, {
                runtimeDeps: {
                    seedDemoWorld: async () => undefined,
                    preloadStageSurfaces: async () => undefined,
                    installDemoFirewall: () => {
                        calls.push('install');
                    },
                    clearDemoWorld: async () => {
                        calls.push('clear');
                    },
                    uninstallDemoFirewall: () => {
                        calls.push('uninstall');
                    },
                },
            }),
        );
        await flushHookEffects();

        await screen.unmount();
        await flushHookEffects();

        expect(calls).toEqual(['install', 'clear', 'uninstall']);
    });
});

describe('stage D-PERF dev route gate', () => {
    it('is enabled only in dev or debug-export builds', () => {
        withDevBuild(true, () => {
            withDebugRouteEnv(undefined, () => {
                expect(isDevRouteEnabled()).toBe(true);
            });
        });

        withDevBuild(false, () => {
            withDebugRouteEnv(undefined, () => {
                expect(isDevRouteEnabled()).toBe(false);
            });
        });

        withDevBuild(false, () => {
            withDebugRouteEnv('1', () => {
                expect(isDevRouteEnabled()).toBe(true);
            });
        });
    });
});
