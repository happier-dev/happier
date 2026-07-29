import * as React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';

import {
    DemoStage,
    resolveMountedStageFrames,
    STAGE_SURFACE_MATERIALIZE_FADE_MS,
} from './DemoStage';
import type { StageFrame } from './stageFrames';
import type { SpotlightTargetRef } from './useSpotlightTarget';

const stageSurfaceLifecycle = vi.hoisted(() => ({
    listenerCount: 0,
    liveMountCount: 0,
    mountCount: 0,
    suspend: false,
}));

const suspendedSurfacePromise = new Promise<never>(() => undefined);

const stageSnapshotBoundary = vi.hoisted(() => ({
    captureRef: vi.fn(async () => 'data:image/png;base64,stage-freeze'),
    releaseCapture: vi.fn(),
}));

vi.mock('react-native-view-shot', () => ({
    captureRef: stageSnapshotBoundary.captureRef,
    releaseCapture: stageSnapshotBoundary.releaseCapture,
}));

vi.mock('./stageSurfaces', async () => {
    const ReactModule = await import('react');
    const reactNativeModule = await import('react-native');
    const spotlightTargetModule = await import('./useSpotlightTarget');
    const MockView = reactNativeModule.View as React.ElementType;

    function RegisteredStageSurface(props: Readonly<{ device?: StageFrame['device'] }>): React.ReactElement {
        if (stageSurfaceLifecycle.suspend) throw suspendedSurfacePromise;
        const targetRef = ReactModule.useRef<SpotlightTargetRef | null>(null);
        const targetProps = spotlightTargetModule.useSpotlightTarget(targetRef, 'stage-target');
        ReactModule.useEffect(() => {
            stageSurfaceLifecycle.mountCount += 1;
            stageSurfaceLifecycle.liveMountCount += 1;
            stageSurfaceLifecycle.listenerCount += 1;
            return () => {
                stageSurfaceLifecycle.liveMountCount -= 1;
                stageSurfaceLifecycle.listenerCount -= 1;
            };
        }, []);
        return ReactModule.createElement(MockView, {
            ref: targetRef,
            testID: props.device ? `mock-stage-device:${props.device}` : 'mock-stage-device:missing',
            onLayout: targetProps.onLayout,
            style: targetProps.style,
        });
    }

    return {
        stageSurfaceById: new Map([
            ['sessions-list', { component: RegisteredStageSurface }],
            ['session-view', { component: RegisteredStageSurface }],
        ]),
    };
});

const demoFrames = [
    { id: 'sessions-list.hero', surface: 'sessions-list', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'sessions-list.spotlight', surface: 'sessions-list', device: 'desktop', spotlight: 'session-list-item', zoom: 1.7, dim: 0.55 },
    { id: 'session-view.hero', surface: 'session-view', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'session-view.spotlight', surface: 'session-view', device: 'desktop', spotlight: 'session-header-actions', zoom: 1.8, dim: 0.55 },
] as const satisfies readonly StageFrame[];

function resetStageSurfaceLifecycle(): void {
    stageSurfaceLifecycle.listenerCount = 0;
    stageSurfaceLifecycle.liveMountCount = 0;
    stageSurfaceLifecycle.mountCount = 0;
    stageSurfaceLifecycle.suspend = false;
    stageSnapshotBoundary.captureRef.mockClear();
    stageSnapshotBoundary.releaseCapture.mockClear();
}

type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

function intersectionOverUnion(first: Rect, second: Rect): number {
    const intersectionWidth = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
    const intersectionHeight = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
    const intersectionArea = intersectionWidth * intersectionHeight;
    const unionArea = first.width * first.height + second.width * second.height - intersectionArea;
    return unionArea > 0 ? intersectionArea / unionArea : 0;
}

describe('resolveMountedStageFrames', () => {
    it('keeps previous warm, current mounted, and next pre-mounted', () => {
        expect(resolveMountedStageFrames(demoFrames, 'session-view.hero').map((frame) => frame.id)).toEqual([
            'sessions-list.spotlight',
            'session-view.hero',
            'session-view.spotlight',
        ]);
    });

    it('falls back to the first frame when the active id is missing', () => {
        expect(resolveMountedStageFrames(demoFrames, 'missing').map((frame) => frame.id)).toEqual([
            'sessions-list.hero',
            'sessions-list.spotlight',
        ]);
    });
});

describe('DemoStage', () => {
    afterEach(() => {
        standardCleanup();
        resetStageSurfaceLifecycle();
        vi.unstubAllGlobals();
    });

    it('renders only lifecycle-eligible frame slots and keeps staged surfaces non-interactive', async () => {
        const screen = await renderScreen(
            <DemoStage
                frames={demoFrames}
                activeFrameId="session-view.hero"
                reducedMotion={false}
            />,
            { flushOptions: { cycles: 0 } },
        );

        expect(screen.findByTestId('demo-stage-frame-sessions-list.hero')).toBeNull();
        expect(screen.findByTestId('demo-stage-frame-sessions-list.spotlight')).not.toBeNull();
        expect(screen.findByTestId('demo-stage-frame-session-view.hero')).not.toBeNull();
        expect(screen.findByTestId('demo-stage-frame-session-view.spotlight')).toBeNull();

        const activeSlot = screen.findByTestId('demo-stage-frame-session-view.hero');
        expect(activeSlot?.props.pointerEvents).toBe('none');
        expect(StyleSheet.flatten(activeSlot?.props.style)).toMatchObject({
            opacity: 1,
        });
    });

    it('fills the stage host so the measured DeviceFrame can become visible', async () => {
        const screen = await renderScreen(
            <DemoStage
                frames={demoFrames}
                activeFrameId="session-view.hero"
                reducedMotion={false}
            />,
            { flushOptions: { cycles: 0 } },
        );

        expect(StyleSheet.flatten(screen.findByTestId('demo-stage')?.props.style)).toMatchObject({
            alignItems: 'stretch',
            flex: 1,
            minHeight: 0,
            minWidth: 0,
        });
    });

    it('renders the device frame shell fallback while a lazy surface is still loading', async () => {
        stageSurfaceLifecycle.suspend = true;
        const screen = await renderScreen(
            <DemoStage
                frames={demoFrames}
                activeFrameId="session-view.hero"
                reducedMotion={false}
            />,
            { flushOptions: { cycles: 0 } },
        );

        expect(screen.findByTestId('demo-stage-device-frame-shell')).not.toBeNull();
        expect(screen.findByTestId('demo-stage-frame-session-view.hero-loading')).not.toBeNull();
    });

    it('materializes resolved stage content with a tokenized fade no longer than 200ms', async () => {
        const screen = await renderScreen(
            <DemoStage
                frames={demoFrames}
                activeFrameId="session-view.hero"
                reducedMotion={false}
            />,
            { flushOptions: { cycles: 0 } },
        );

        expect(STAGE_SURFACE_MATERIALIZE_FADE_MS).toBeGreaterThan(0);
        expect(STAGE_SURFACE_MATERIALIZE_FADE_MS).toBeLessThanOrEqual(200);
        const materializedContent = screen.findByTestId('demo-stage-frame-session-view.hero-content');
        expect(materializedContent?.type).toBe('Animated.View');
        expect(StyleSheet.flatten(materializedContent?.props.style)).toMatchObject({ opacity: 1 });
    });

    it('keeps an unregistered spotlight at full-surface framing instead of zooming to shell center', async () => {
        const missingTargetFrames = [
            {
                id: 'session-view.missing-target',
                surface: 'session-view',
                device: 'desktop',
                spotlight: 'missing-stage-target',
                zoom: 1.8,
                dim: 0.55,
            },
        ] as const satisfies readonly StageFrame[];
        const screen = await renderScreen(
            <DemoStage
                frames={missingTargetFrames}
                activeFrameId="session-view.missing-target"
                reducedMotion={false}
            />,
            { flushOptions: { cycles: 0 } },
        );

        expect(StyleSheet.flatten(screen.findByTestId('demo-stage-camera-inner')?.props.style)).toMatchObject({
            transform: [{ scale: 1 }],
        });
    });

    it('passes the active frame device to its real surface composition', async () => {
        const phoneFrames = [
            { id: 'session-view.phone', surface: 'session-view', device: 'phone', zoom: 1, dim: 0 },
        ] as const satisfies readonly StageFrame[];
        const screen = await renderScreen(
            <DemoStage
                frames={phoneFrames}
                activeFrameId="session-view.phone"
                reducedMotion={false}
            />,
            { flushOptions: { cycles: 0 } },
        );

        expect(screen.findByTestId('mock-stage-device:phone')).not.toBeNull();
        expect(screen.findByTestId('mock-stage-device:missing')).toBeNull();
    });

    it('keeps same-surface frame cycles bounded to one mounted surface and listener set', async () => {
        const sameSurfaceFrames = [
            { id: 'session-view.hero', surface: 'session-view', device: 'desktop', zoom: 1, dim: 0 },
            { id: 'session-view.spotlight', surface: 'session-view', device: 'desktop', spotlight: 'stage-target', zoom: 1.8, dim: 0.55 },
        ] as const satisfies readonly StageFrame[];

        const screen = await renderScreen(
            <DemoStage
                frames={sameSurfaceFrames}
                activeFrameId="session-view.hero"
                reducedMotion={false}
            />,
            { flushOptions: { cycles: 0 } },
        );

        for (let index = 0; index < 8; index += 1) {
            const activeFrameId = index % 2 === 0 ? 'session-view.spotlight' : 'session-view.hero';
            await screen.update(
                <DemoStage
                    frames={sameSurfaceFrames}
                    activeFrameId={activeFrameId}
                    reducedMotion={false}
                />,
            );
        }

        expect(screen.findAllByTestId('mock-stage-device:desktop')).toHaveLength(1);
        expect(stageSurfaceLifecycle.mountCount).toBe(1);
        expect(stageSurfaceLifecycle.liveMountCount).toBe(1);
        expect(stageSurfaceLifecycle.listenerCount).toBe(1);
    });

    it('pre-captures the live surface at rest and does not capture again at camera-motion start', async () => {
        vi.useFakeTimers();
        try {
            let notifySurfaceMutation: (() => void) | null = null;
            vi.stubGlobal('MutationObserver', class {
                constructor(callback: () => void) {
                    notifySurfaceMutation = callback;
                }

                observe(): void {}

                disconnect(): void {}
            });
            const sameSurfaceFrames = [
                { id: 'session-view.hero', surface: 'session-view', device: 'desktop', zoom: 1, dim: 0 },
                { id: 'session-view.spotlight', surface: 'session-view', device: 'desktop', spotlight: 'stage-target', zoom: 1.8, dim: 0.55 },
            ] as const satisfies readonly StageFrame[];

            const screen = await renderScreen(
                <DemoStage
                    frames={sameSurfaceFrames}
                    activeFrameId="session-view.hero"
                    reducedMotion={false}
                />,
                {
                    flushOptions: { cycles: 2 },
                    createNodeMock: (element) => {
                        const testID = (element as { props?: { testID?: string } }).props?.testID;
                        return testID?.endsWith('-capture-source') ? {} : null;
                    },
                },
            );

            expect(screen.findByTestId('demo-stage-surface-session-view-capture-source')).not.toBeNull();
            expect(stageSnapshotBoundary.captureRef).toHaveBeenCalledTimes(1);
            expect(screen.findByTestId('demo-stage-camera-frozen-frame')).not.toBeNull();
            expect(StyleSheet.flatten(screen.findByTestId('demo-stage-camera-frozen-outer')?.props.style)).toMatchObject({
                opacity: 0,
            });
            expect(screen.findAllByTestId('mock-stage-device:desktop')).toHaveLength(1);

            await act(async () => {
                notifySurfaceMutation?.();
                vi.advanceTimersByTime(3000);
            });
            expect(stageSnapshotBoundary.captureRef).toHaveBeenCalledTimes(2);

            await screen.update(
                <DemoStage
                    frames={sameSurfaceFrames}
                    activeFrameId="session-view.spotlight"
                    reducedMotion={false}
                />,
            );

            expect(screen.findByTestId('demo-stage-camera-frozen-frame')).not.toBeNull();
            expect(screen.findAllByTestId('mock-stage-device:desktop')).toHaveLength(1);
            expect(stageSurfaceLifecycle.liveMountCount).toBe(1);

            await act(async () => {
                vi.runAllTimers();
            });

            expect(screen.findByTestId('demo-stage-camera-frozen-frame')).not.toBeNull();
            expect(StyleSheet.flatten(screen.findByTestId('demo-stage-camera-frozen-outer')?.props.style)).toMatchObject({
                opacity: 0,
            });
            expect(StyleSheet.flatten(screen.findByTestId('demo-stage-camera-live')?.props.style)).toMatchObject({
                display: 'flex',
            });
            expect(stageSnapshotBoundary.captureRef).toHaveBeenCalledTimes(2);
            expect(stageSnapshotBoundary.releaseCapture).toHaveBeenCalledTimes(1);
            expect(stageSurfaceLifecycle.liveMountCount).toBe(1);
            expect(stageSurfaceLifecycle.listenerCount).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not reuse an aged frozen capture after a throttled rest and refreshes after settlement', async () => {
        vi.useFakeTimers();
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        try {
            vi.stubGlobal('requestAnimationFrame', vi.fn(() => 71));
            vi.stubGlobal('cancelAnimationFrame', vi.fn());
            vi.stubGlobal('window', {
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            });
            const liveNode = { style: { opacity: '1', willChange: '' } };
            const frozenNode = { style: { opacity: '0', transform: '', willChange: '' } };
            const outerNode = { style: { opacity: '1', transform: '', willChange: '' } };
            const innerNode = { style: { opacity: '1', transform: '', willChange: '' } };
            const sameSurfaceFrames = [
                { id: 'session-view.hero', surface: 'session-view', device: 'desktop', zoom: 1, dim: 0 },
                { id: 'session-view.spotlight', surface: 'session-view', device: 'desktop', spotlight: 'stage-target', zoom: 1.8, dim: 0.55 },
            ] as const satisfies readonly StageFrame[];
            const createNodeMock = (element: React.ReactElement) => {
                const testID = (element as { props?: { testID?: string } }).props?.testID;
                if (testID === 'demo-stage-camera-live') return liveNode;
                if (testID === 'demo-stage-camera-frozen-outer') return frozenNode;
                if (testID === 'demo-stage-camera-outer') return outerNode;
                if (testID === 'demo-stage-camera-inner' || testID === 'demo-stage-camera-frozen-inner') return innerNode;
                if (testID?.endsWith('-capture-source')) return {};
                if (testID === 'demo-stage') {
                    return {
                        getBoundingClientRect: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
                    };
                }
                if (testID === 'demo-stage-device-frame') {
                    return {
                        getBoundingClientRect: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
                    };
                }
                if (testID === 'mock-stage-device:desktop') {
                    return {
                        getBoundingClientRect: () => ({ x: 620, y: 480, width: 200, height: 80 }),
                    };
                }
                return {};
            };
            const screen = await renderScreen(
                <DemoStage
                    frames={sameSurfaceFrames}
                    activeFrameId="session-view.hero"
                    reducedMotion={false}
                />,
                { flushOptions: { cycles: 2 }, createNodeMock },
            );

            expect(stageSnapshotBoundary.captureRef).toHaveBeenCalledTimes(1);
            await act(async () => {
                vi.advanceTimersByTime(30_000);
            });
            expect(stageSnapshotBoundary.captureRef).toHaveBeenCalledTimes(1);

            await act(async () => {
                screen.tree.update(
                    <DemoStage
                        frames={sameSurfaceFrames}
                        activeFrameId="session-view.spotlight"
                        reducedMotion={false}
                    />,
                );
            });

            expect(liveNode.style.opacity).toBe('1');
            expect(frozenNode.style.opacity).toBe('0');

            await act(async () => {
                vi.advanceTimersByTime(2_000);
            });
            expect(stageSnapshotBoundary.captureRef).toHaveBeenCalledTimes(2);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
            vi.useRealTimers();
        }
    });

    it('does not mount a duplicate outgoing surface for reduced-motion same-surface frame changes', async () => {
        const sameSurfaceFrames = [
            { id: 'session-view.hero', surface: 'session-view', device: 'desktop', zoom: 1, dim: 0 },
            { id: 'session-view.spotlight', surface: 'session-view', device: 'desktop', spotlight: 'stage-target', zoom: 1.8, dim: 0.55 },
        ] as const satisfies readonly StageFrame[];

        const screen = await renderScreen(
            <DemoStage
                frames={sameSurfaceFrames}
                activeFrameId="session-view.hero"
                reducedMotion
            />,
            { flushOptions: { cycles: 0 } },
        );

        await screen.update(
            <DemoStage
                frames={sameSurfaceFrames}
                activeFrameId="session-view.spotlight"
                reducedMotion
            />,
        );

        expect(screen.findByTestId('demo-stage-crossfade-outgoing-session-view.hero')).toBeNull();
        expect(screen.findAllByTestId('mock-stage-device:desktop')).toHaveLength(1);
        expect(stageSurfaceLifecycle.liveMountCount).toBe(1);
        expect(stageSurfaceLifecycle.listenerCount).toBe(1);
        expect(screen.findByTestId('demo-stage-camera-frozen-frame')).toBeNull();
    });

    it('keeps the outgoing surface mounted in the visible layer during a reduced-motion frame change', async () => {
        const screen = await renderScreen(
            <DemoStage
                frames={demoFrames}
                activeFrameId="sessions-list.spotlight"
                reducedMotion
            />,
            { flushOptions: { cycles: 0 } },
        );

        await screen.update(
            <DemoStage
                frames={demoFrames}
                activeFrameId="session-view.hero"
                reducedMotion
            />,
        );

        const outgoingSlot = screen.findByTestId('demo-stage-crossfade-outgoing-sessions-list.spotlight');
        const incomingSlot = screen.findByTestId('demo-stage-frame-session-view.hero');

        expect(outgoingSlot).not.toBeNull();
        expect(outgoingSlot?.type).toBe('Animated.View');
        expect(incomingSlot).not.toBeNull();
        expect(incomingSlot?.type).toBe('Animated.View');
    });

    it('cuts the settled spotlight over the post-camera target with positive intersection-over-union', async () => {
        const frames = [
            {
                id: 'stage-target.spotlight',
                surface: 'session-view',
                device: 'desktop',
                spotlight: 'stage-target',
                zoom: 1.4,
                dim: 0.55,
            },
        ] as const satisfies readonly StageFrame[];

        const screen = await renderScreen(
            <DemoStage
                frames={frames}
                activeFrameId="stage-target.spotlight"
                reducedMotion={false}
            />,
            {
                createNodeMock: (element) => {
                    const testID = (element as { props?: { testID?: string } }).props?.testID;
                    if (testID === 'demo-stage') {
                        return {
                            getBoundingClientRect: () => ({
                                x: 100,
                                y: 200,
                                width: 1000,
                                height: 500,
                            }),
                            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                                callback(100, 200, 1000, 500);
                            },
                        };
                    }
                    if (testID === 'mock-stage-device:desktop') {
                        return {
                            getBoundingClientRect: () => ({
                                x: 620,
                                y: 480,
                                width: 28,
                                height: 14,
                            }),
                            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                                callback(140, 230, 20, 10);
                            },
                        };
                    }
                    return {};
                },
            },
        );

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('demo-stage'),
                'onLayout',
                { nativeEvent: { layout: { width: 1000, height: 500 } } },
                'demo-stage',
            );
        });

        // The four-rect cutout is superseded by a single lerped halo (D19 / spec §4).
        expect(screen.findByTestId('demo-stage-spotlight-cutout-top')).toBeNull();
        const haloStyle = StyleSheet.flatten(screen.findByTestId('demo-stage-spotlight-halo')?.props.style) as {
            left: number; top: number; width: number; height: number; boxShadow?: string;
        };
        const spotlightHole = {
            x: haloStyle.left,
            y: haloStyle.top,
            width: haloStyle.width,
            height: haloStyle.height,
        };
        const settledTarget = { x: 520, y: 280, width: 28, height: 14 };

        expect(typeof haloStyle.boxShadow).toBe('string');
        expect(intersectionOverUnion(spotlightHole, settledTarget)).toBeGreaterThan(0.5);
    });

    it('ignores duplicate target ids from warm-cache surfaces', async () => {
        const frames = [
            {
                id: 'session-view.active-target',
                surface: 'session-view',
                device: 'desktop',
                spotlight: 'stage-target',
                zoom: 1.35,
                dim: 0.55,
            },
            {
                id: 'sessions-list.warm-target',
                surface: 'sessions-list',
                device: 'phone',
                spotlight: 'stage-target',
                zoom: 1.35,
                dim: 0.55,
            },
        ] as const satisfies readonly StageFrame[];

        const screen = await renderScreen(
            <DemoStage frames={frames} activeFrameId="session-view.active-target" reducedMotion={false} />,
            {
                createNodeMock: (element) => {
                    const testID = (element as { props?: { testID?: string } }).props?.testID;
                    if (testID === 'demo-stage') {
                        return {
                            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                                callback(0, 0, 1000, 500);
                            },
                        };
                    }
                    if (testID === 'mock-stage-device:desktop') {
                        return {
                            getBoundingClientRect: () => ({
                                x: 619.75,
                                y: 373,
                                width: 40.5,
                                height: 54,
                            }),
                            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                                callback(10, 20, 30, 40);
                            },
                        };
                    }
                    if (testID === 'mock-stage-device:phone') {
                        return {
                            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                                callback(300, 320, 30, 40);
                            },
                        };
                    }
                    return {};
                },
            },
        );

        // Only the active desktop target frames the halo; the duplicate warm-cache
        // phone registration is ignored. The halo sits at the settled target origin.
        const haloStyle = StyleSheet.flatten(screen.findByTestId('demo-stage-spotlight-halo')?.props.style) as {
            left: number; top: number;
        };
        expect(haloStyle.left).toBeCloseTo(619.75);
        expect(haloStyle.top).toBeCloseTo(373);
    });
});
