import * as React from 'react';
import * as ReactNative from 'react-native';
import { DemoStage } from '@/components/onboarding/tour/stage/DemoStage';
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
    prepareStageDperfRuntime,
    resolveNextDperfStageFrameId,
} from '@/app/(app)/dev/stage-dperf';

describe('stage D-PERF dev route frame loop', () => {
    it('captures a registered phone screen at viewport size with persistent phone safe areas and no stage camera', async () => {
        const dimensions = vi.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue({ width: 393, height: 852, scale: 1, fontScale: 1 });
        vi.stubGlobal('window', { location: { search: '?capture=phone&frame=session-view.hero' } });
        const screen = await renderScreen(React.createElement(StageDperfDevRouteContent, {
            runtimeDeps: {
                seedDemoWorld: async () => undefined,
                preloadStageSurfaces: async () => undefined,
                installDemoFirewall: () => undefined,
                clearDemoWorld: async () => undefined,
                uninstallDemoFirewall: () => undefined,
            },
        }));
        try {
            await flushHookEffects();
            const capture = screen.findHostByTestId('demo-stage-phone-screen');
            expect(capture?.props.dataSet).toMatchObject({
                'frame-id': 'session-view.hero',
                'viewport-width': '393',
                'viewport-height': '852',
                'safe-area-top': '59',
                'safe-area-bottom': '34',
                'safe-area-left': '0',
                'safe-area-right': '0',
            });
            expect(screen.findAllByType(DemoStage)).toHaveLength(0);
            expect(screen.findHostByTestId('demo-stage-device-frame')).toBeNull();
            expect(screen.findHostByTestId('demo-stage-camera-outer')).toBeNull();
        } finally {
            await screen.unmount();
            vi.unstubAllGlobals();
            dimensions.mockRestore();
        }
    });

    it('uses the registered phone composition in a phone-width capture', async () => {
        const dimensions = vi.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
        const screen = await renderScreen(React.createElement(StageDperfDevRouteContent, {
            runtimeDeps: {
                seedDemoWorld: async () => undefined,
                preloadStageSurfaces: async () => undefined,
                installDemoFirewall: () => undefined,
                clearDemoWorld: async () => undefined,
                uninstallDemoFirewall: () => undefined,
            },
        }));
        try {
            await flushHookEffects();
            expect(screen.findByType(DemoStage).props.frames.find((frame: { id: string }) => frame.id === 'session-view.hero').device).toBe('phone');
        } finally {
            await screen.unmount();
            dimensions.mockRestore();
        }
    });
    it('cycles the seeded frames and falls back to the first for an unknown id', () => {
        const [first, second] = DPERF_STAGE_FRAME_IDS;
        expect(resolveNextDperfStageFrameId(first)).toBe(second);
        expect(resolveNextDperfStageFrameId(second)).toBe(first);
        expect(resolveNextDperfStageFrameId('missing')).toBe(first);
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
