import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';

import { buildSpotlightHaloShadow, Spotlight } from './Spotlight';
import type { StageTargetRect } from './useStageTransform';
import {
    SpotlightProvider,
    SpotlightTargetScope,
    useRegisteredSpotlightTargetRect,
    useSpotlightTarget,
    type SpotlightTargetRef,
} from './useSpotlightTarget';

const fallbackRect = { x: 0, y: 0, width: 1000, height: 500 };

function rectIoU(a: StageTargetRect, b: StageTargetRect): number {
    const interLeft = Math.max(a.x, b.x);
    const interTop = Math.max(a.y, b.y);
    const interRight = Math.min(a.x + a.width, b.x + b.width);
    const interBottom = Math.min(a.y + a.height, b.y + b.height);
    const interWidth = Math.max(0, interRight - interLeft);
    const interHeight = Math.max(0, interBottom - interTop);
    const intersection = interWidth * interHeight;
    const union = a.width * a.height + b.width * b.height - intersection;
    return union <= 0 ? 0 : intersection / union;
}

function createMeasuredRef(rect: { x: number; y: number; width: number; height: number }): React.RefObject<SpotlightTargetRef> {
    return {
        current: {
            measureInWindow: (callback) => {
                callback(rect.x, rect.y, rect.width, rect.height);
            },
        },
    };
}

function createWrapper(activeTargetId: string | null = null): React.ComponentType<React.PropsWithChildren> {
    function Wrapper({ children }: React.PropsWithChildren): React.ReactElement {
        return (
            <SpotlightProvider activeTargetId={activeTargetId}>
                <SpotlightTargetScope active>
                    {children}
                </SpotlightTargetScope>
            </SpotlightProvider>
        );
    }
    return Wrapper;
}

describe('spotlight target registry', () => {
    afterEach(() => {
        standardCleanup();
        vi.restoreAllMocks();
    });

    it('registers a target rect from live measurement and unregisters cleanly', async () => {
        const targetRef = createMeasuredRef({ x: 24, y: 36, width: 200, height: 80 });
        type RegisteredRectResult = ReturnType<typeof useRegisteredSpotlightTargetRect>;

        const hook = await renderHook<RegisteredRectResult, { targetId: string | null }>((props) => {
            useSpotlightTarget(targetRef, props.targetId);
            return useRegisteredSpotlightTargetRect('cta', fallbackRect);
        }, {
            initialProps: { targetId: 'cta' },
            wrapper: createWrapper('cta'),
        });

        expect(hook.getCurrent()).toEqual({
            found: true,
            rect: { x: 24, y: 36, width: 200, height: 80 },
        });

        await hook.rerender({ targetId: null });

        expect(hook.getCurrent()).toEqual({
            found: false,
            rect: fallbackRect,
        });
    });

    it('returns layout props that remeasure and isolate the active target', async () => {
        const targetRef = createMeasuredRef({ x: 10, y: 20, width: 30, height: 40 });

        const hook = await renderHook(() => useSpotlightTarget(targetRef, 'cta'), {
            wrapper: createWrapper('cta'),
        });

        expect(StyleSheet.flatten(hook.getCurrent().style)).toMatchObject({
            isolation: 'isolate',
            position: 'relative',
            zIndex: 40,
        });
        expect(hook.getCurrent().active).toBe(true);
        expect(typeof hook.getCurrent().onLayout).toBe('function');
    });

    it('keeps normal non-journey surfaces free of target-only layout wrappers', async () => {
        const targetRef = createMeasuredRef({ x: 10, y: 20, width: 30, height: 40 });

        const hook = await renderHook(() => useSpotlightTarget(targetRef, 'cta'));

        expect(hook.getCurrent().active).toBe(false);
        expect(hook.getCurrent().style).toBeUndefined();
    });

    it('pre-registers an inactive target in the active stage surface without elevating its style', async () => {
        const targetRef = createMeasuredRef({ x: 10, y: 20, width: 30, height: 40 });

        const hook = await renderHook(() => {
            const targetProps = useSpotlightTarget(targetRef, 'cta');
            const resolved = useRegisteredSpotlightTargetRect('cta', fallbackRect);
            return { targetProps, resolved };
        }, {
            wrapper: createWrapper(null),
        });

        expect(hook.getCurrent().resolved).toEqual({
            found: true,
            rect: { x: 10, y: 20, width: 30, height: 40 },
        });
        expect(hook.getCurrent().targetProps.active).toBe(false);
        expect(hook.getCurrent().targetProps.style).toBeUndefined();
    });

    it('unions multiple real nodes registered for one semantic target', async () => {
        const headerRef = createMeasuredRef({ x: 10, y: 20, width: 100, height: 30 });
        const rowRef = createMeasuredRef({ x: 18, y: 50, width: 92, height: 70 });

        const hook = await renderHook(() => {
            useSpotlightTarget(headerRef, 'attention-group');
            useSpotlightTarget(rowRef, 'attention-group');
            return useRegisteredSpotlightTargetRect('attention-group', fallbackRect);
        }, {
            wrapper: createWrapper('attention-group'),
        });

        expect(hook.getCurrent()).toEqual({
            found: true,
            rect: { x: 10, y: 20, width: 100, height: 100 },
        });
    });

    it('does not let a stale header-only measurement overwrite the later header-plus-rows union', async () => {
        const pendingHeaderMeasurements: Array<(x: number, y: number, width: number, height: number) => void> = [];
        const headerRef: React.RefObject<SpotlightTargetRef> = {
            current: {
                measureInWindow: (callback) => pendingHeaderMeasurements.push(callback),
            },
        };
        const rowRef = createMeasuredRef({ x: 18, y: 50, width: 92, height: 70 });

        const hook = await renderHook((props: { includeRow: boolean }) => {
            useSpotlightTarget(headerRef, 'attention-group');
            useSpotlightTarget(rowRef, props.includeRow ? 'attention-group' : null);
            return useRegisteredSpotlightTargetRect('attention-group', fallbackRect);
        }, {
            initialProps: { includeRow: false },
            wrapper: createWrapper('attention-group'),
        });

        expect(pendingHeaderMeasurements).toHaveLength(1);
        await hook.rerender({ includeRow: true });
        expect(pendingHeaderMeasurements).toHaveLength(2);

        await act(async () => {
            pendingHeaderMeasurements[1]?.(10, 20, 100, 30);
        });
        expect(hook.getCurrent()).toEqual({
            found: true,
            rect: { x: 10, y: 20, width: 100, height: 100 },
        });

        await act(async () => {
            pendingHeaderMeasurements[0]?.(10, 20, 100, 30);
        });
        expect(hook.getCurrent()).toEqual({
            found: true,
            rect: { x: 10, y: 20, width: 100, height: 100 },
        });
    });
});

describe('Spotlight', () => {
    afterEach(() => {
        standardCleanup();
        vi.restoreAllMocks();
    });

    it('renders a full-stage dim overlay and logs when a target id is missing', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const screen = await renderScreen(
            <SpotlightProvider activeTargetId="missing">
                <View testID="stage-root">
                    <Spotlight
                        targetId="missing"
                        fallbackRect={fallbackRect}
                        dim={0.55}
                        testID="spotlight"
                    />
                </View>
            </SpotlightProvider>,
        );

        const overlay = screen.findByTestId('spotlight-overlay');
        expect(StyleSheet.flatten(overlay?.props.style)).toMatchObject({
            opacity: 0.55,
        });
        expect(screen.findByTestId('spotlight-fallback-frame')).not.toBeNull();
        expect(warnSpy).toHaveBeenCalledWith('[DemoStage] Missing spotlight target "missing"; framing full surface.');
    });

    it('frames a measured target with a single halo element and no four-rect cutout', async () => {
        const targetRef = createMeasuredRef({ x: 10, y: 20, width: 30, height: 40 });

        function Probe(): React.ReactElement {
            useSpotlightTarget(targetRef, 'cta');
            return (
                <Spotlight
                    targetId="cta"
                    fallbackRect={fallbackRect}
                    dim={0.55}
                    testID="spotlight"
                />
            );
        }

        const screen = await renderScreen(
            <SpotlightProvider activeTargetId="cta">
                <Probe />
            </SpotlightProvider>,
        );

        // The four-rect cutout is gone; the giant-spread shadow dims everything around a single hole.
        expect(screen.findByTestId('spotlight-overlay')).toBeNull();
        expect(screen.findByTestId('spotlight-cutout-top')).toBeNull();
        expect(screen.findByTestId('spotlight-cutout-left')).toBeNull();
        expect(screen.findByTestId('spotlight-cutout-right')).toBeNull();
        expect(screen.findByTestId('spotlight-cutout-bottom')).toBeNull();

        const halo = screen.findByTestId('spotlight-halo');
        expect(halo).not.toBeNull();
        expect(StyleSheet.flatten(halo?.props.style)).toMatchObject({
            left: 10,
            top: 20,
            width: 30,
            height: 40,
            boxShadow: buildSpotlightHaloShadow(0.55),
        });
    });

    it('lerp-projects the halo through the settled camera transform so it overlaps the target (IoU > 0.5)', async () => {
        const measuredRect: StageTargetRect = { x: 120, y: 160, width: 240, height: 120 };
        const targetRef = createMeasuredRef(measuredRect);
        const settledCameraTransform = {
            mode: 'camera' as const,
            scale: 1.35,
            translateX: -80,
            translateY: -60,
        };

        function Probe(): React.ReactElement {
            useSpotlightTarget(targetRef, 'cta');
            return (
                <Spotlight
                    targetId="cta"
                    fallbackRect={fallbackRect}
                    dim={0.55}
                    settledCameraTransform={settledCameraTransform}
                    testID="spotlight"
                />
            );
        }

        const screen = await renderScreen(
            <SpotlightProvider activeTargetId="cta">
                <Probe />
            </SpotlightProvider>,
        );

        const haloStyle = StyleSheet.flatten(screen.findByTestId('spotlight-halo')?.props.style) as {
            left: number; top: number; width: number; height: number;
        };
        const haloRect: StageTargetRect = {
            x: haloStyle.left,
            y: haloStyle.top,
            width: haloStyle.width,
            height: haloStyle.height,
        };
        // The projected on-screen target rect (origin = fallback/stage center pivot).
        const originX = fallbackRect.x + fallbackRect.width / 2;
        const originY = fallbackRect.y + fallbackRect.height / 2;
        const projectedTarget: StageTargetRect = {
            x: originX + (measuredRect.x - originX) * 1.35 - 80,
            y: originY + (measuredRect.y - originY) * 1.35 - 60,
            width: measuredRect.width * 1.35,
            height: measuredRect.height * 1.35,
        };
        expect(rectIoU(haloRect, projectedTarget)).toBeGreaterThan(0.5);
    });

    it('builds a dim-parameterized giant-spread halo shadow with a white ring and glow', () => {
        expect(buildSpotlightHaloShadow(0.5)).toBe(
            '0 0 0 9999px rgba(4,4,6,0.5), 0 0 0 1.5px rgba(255,255,255,0.4), 0 0 60px 6px rgba(255,255,255,0.08)',
        );
        expect(buildSpotlightHaloShadow(0)).toBe(
            '0 0 0 9999px rgba(4,4,6,0), 0 0 0 1.5px rgba(255,255,255,0.4), 0 0 60px 6px rgba(255,255,255,0.08)',
        );
    });

    it('remeasures a target when its layout handler runs', async () => {
        const mutableRect = { x: 10, y: 20, width: 30, height: 40 };
        const targetRef: React.RefObject<SpotlightTargetRef> = {
            current: {
                measureInWindow: (callback) => {
                    callback(mutableRect.x, mutableRect.y, mutableRect.width, mutableRect.height);
                },
            },
        };

        let latestRect = fallbackRect;

        function Probe(): React.ReactElement {
            const targetProps = useSpotlightTarget(targetRef, 'cta');
            const resolved = useRegisteredSpotlightTargetRect('cta', fallbackRect);
            latestRect = resolved.rect;
            return (
                <View>
                    <View testID="target" onLayout={targetProps.onLayout} />
                </View>
            );
        }

        const screen = await renderScreen(
            <SpotlightProvider activeTargetId="cta">
                <Probe />
            </SpotlightProvider>,
        );

        mutableRect.x = 44;
        mutableRect.y = 55;
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('target'),
                'onLayout',
                { nativeEvent: { layout: { width: 30, height: 40 } } },
                'target',
            );
        });

        expect(latestRect).toEqual({
            x: 44,
            y: 55,
            width: 30,
            height: 40,
        });
    });
});
