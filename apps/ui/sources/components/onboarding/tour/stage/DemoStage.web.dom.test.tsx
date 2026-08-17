/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StageFrame } from './stageFrames';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Use react-native-web's actual host mapping: this regression is about the
// browser focus tree, which a React test-renderer prop bag cannot prove.
vi.mock('react-native', async () => await vi.importActual('react-native-web'));

vi.mock('react-native-reanimated', async () => {
    const { View } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return {
        default: { View },
        Easing: { bezier: () => () => 0 },
        useAnimatedStyle: (factory: () => object) => factory(),
        useSharedValue: <T,>(value: T) => ({ value }),
        withTiming: <T,>(value: T) => value,
    };
});

vi.mock('./DeviceFrame', async () => {
    const ReactModule = await import('react');
    const { View } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return {
        DeviceFrame: (props: { children?: React.ReactNode; testID?: string }) => (
            ReactModule.createElement(View, { testID: props.testID }, props.children)
        ),
        resolveDeviceFrameViewportGeometry: () => ({ x: 0, y: 0, width: 100, height: 100, scale: 1 }),
        STAGE_DEVICE_CANVASES: {
            desktop: { width: 100, height: 100 },
            phone: { width: 100, height: 100 },
        },
    };
});

vi.mock('./Spotlight', () => ({ Spotlight: () => null }));

vi.mock('./StageSurfaceFallbacks', () => ({
    StageSurfaceSkeleton: () => null,
    StageSurfaceUnavailable: () => null,
}));

vi.mock('./useSpotlightTarget', () => ({
    SpotlightProvider: (props: { children?: React.ReactNode }) => props.children ?? null,
    SpotlightTargetScope: (props: { children?: React.ReactNode }) => props.children ?? null,
    useRegisteredSpotlightTargetRect: () => ({
        found: false,
        rect: { x: 0, y: 0, width: 100, height: 100 },
    }),
    useReadVisualSpotlightTargetRect: () => () => {},
    useRemeasureSpotlightTarget: () => () => {},
}));

vi.mock('./useStageTransform', () => ({
    useStageTransform: () => ({
        mode: 'static',
        incomingCrossfadeAnimatedStyle: {},
        innerAnimatedStyle: {},
        outerAnimatedStyle: {},
        outgoingCrossfadeAnimatedStyle: {},
        settledTransform: { scale: 1, translateX: 0, translateY: 0 },
    }),
}));

vi.mock('./useStageWebCamera', () => ({ useStageWebCamera: () => {} }));

vi.mock('./stageSurfaces', () => {
    function StaticStageSurface(props: Readonly<{ device: string }>): React.ReactElement {
        return (
            <button data-testid={`stage-control-${props.device}`} type="button">
                Static stage control
            </button>
        );
    }

    return {
        preloadStageSurfaces: async () => undefined,
        resetStageSurfaceComponent: () => {},
        stageSurfaceById: new Map([
            ['session-view', { component: StaticStageSurface }],
            ['sessions-list', { component: StaticStageSurface }],
        ]),
    };
});

import { DemoStage } from './DemoStage';

const frames = [
    { id: 'session-view.active', surface: 'session-view', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'sessions-list.warm', surface: 'sessions-list', device: 'phone', zoom: 1, dim: 0 },
] as const satisfies readonly StageFrame[];

function collectKeyboardReachableControls(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]')]
        .filter((element) => (
            element.getAttribute('tabindex') !== '-1'
            && element.closest('[inert], [aria-hidden="true"]') === null
        ));
}

describe('DemoStage web static-surface isolation', () => {
    let container: HTMLDivElement | null = null;
    let root: Root | null = null;

    afterEach(async () => {
        if (root) {
            await act(async () => {
                root?.unmount();
            });
        }
        container?.remove();
        container = null;
        root = null;
    });

    it('removes active and warm stage controls from browser focus and accessibility traversal without hiding the journey control', async () => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);

        await act(async () => {
            root?.render(
                <>
                    <DemoStage
                        frames={frames}
                        activeFrameId="session-view.active"
                        upcomingFrameIds={['sessions-list.warm']}
                        reducedMotion
                    />
                    <button data-testid="journey-next" type="button">Continue journey</button>
                </>,
            );
        });

        const activeStageControl = container.querySelector<HTMLElement>('[data-testid="stage-control-desktop"]');
        const warmStageControl = container.querySelector<HTMLElement>('[data-testid="stage-control-phone"]');
        const journeyControl = container.querySelector<HTMLElement>('[data-testid="journey-next"]');
        expect(activeStageControl).not.toBeNull();
        expect(warmStageControl).not.toBeNull();
        expect(journeyControl).not.toBeNull();

        for (const staticStageControl of [activeStageControl, warmStageControl]) {
            expect(staticStageControl?.closest('[inert]')).not.toBeNull();
            expect(staticStageControl?.closest('[aria-hidden="true"]')).not.toBeNull();
        }

        expect(journeyControl?.closest('[inert], [aria-hidden="true"]')).toBeNull();
        expect(collectKeyboardReachableControls(container)).toEqual([journeyControl]);
    });
});
