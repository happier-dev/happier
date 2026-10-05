import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Color from 'color';
import { renderScreen, standardCleanup } from '@/dev/testkit';

// Platform gradient, mask and animation adapters are renderer/OS boundaries.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-linear-gradient', () => ({
    LinearGradient: (props: Record<string, unknown>) => React.createElement('LinearGradient', props),
}));
vi.mock('@react-native-masked-view/masked-view', () => ({ default: 'MaskedView' }));
vi.mock('expo-glass-effect', () => ({ isLiquidGlassAvailable: () => false }));

let OverlayScrim: typeof import('./OverlayScrim')['OverlayScrim'];
let storage: typeof import('@/sync/domains/state/storage')['storage'];
let previousState: ReturnType<typeof storage.getState>;
let makeMutable: typeof import('react-native-reanimated')['makeMutable'];

beforeAll(async () => {
    ({ storage } = await import('@/sync/domains/state/storage'));
    ({ OverlayScrim } = await import('./OverlayScrim'));
    ({ makeMutable } = await import('react-native-reanimated'));
    previousState = storage.getState();
});
afterEach(() => {
    standardCleanup();
    act(() => storage.setState(previousState, true));
});

describe('floating composer scrim material', () => {
    it.each([0, 0.2])('keeps the gradient and underlay at the exact requested opacity %s', async (opacity) => {
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const materials = glassPresetMaterials('everywhere');
        act(() => storage.setState({ settings: {
            ...previousState.settings,
            glassBlurEnabled: true,
            glassSurfaceMaterials: { ...materials, floating: { blur: 'strong', opacity } },
        } }));
        const screen = await renderScreen(<OverlayScrim progress={makeMutable(1)} />);
        const colors = screen.findByType('LinearGradient').props.colors as string[];
        expect(Color(colors[0]!).alpha()).toBeCloseTo(opacity, 6);
        expect(colors.every(color => Color(color).alpha() <= opacity)).toBe(true);
        expect(Color(colors.at(-1)!).alpha()).toBe(0);
    });
});

describe('floating menu edge material', () => {
    it.each([0, 0.2, 1])('keeps both gradient endpoints within floating opacity %s', async (opacity) => {
        const { FloatingOverlay } = await import('./FloatingOverlay');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        act(() => storage.setState({ settings: { ...previousState.settings, glassBlurEnabled: true,
            glassSurfaceMaterials: { ...glassPresetMaterials('everywhere'), floating: { blur: 'strong', opacity } },
        } }));
        for (const reduceTransparency of [false, true]) {
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ reduceTransparency }}>
                <FloatingOverlay edgeFades><React.Fragment /></FloatingOverlay>
            </GlassRuntimeEnvironmentProvider>);
            const scroll = screen.tree.root.find(node => typeof node.props.onScroll === 'function' && typeof node.props.onContentSizeChange === 'function');
            await act(async () => {
                scroll.props.onScroll({ nativeEvent: {
                    contentOffset: { x: 0, y: 100 },
                    layoutMeasurement: { width: 200, height: 100 },
                    contentSize: { width: 200, height: 500 },
                } });
            });
            const gradients = screen.findAllByType('LinearGradient');
            expect(gradients).toHaveLength(2);
            const effectiveOpacity = reduceTransparency ? 1 : opacity;
            const endpoints = gradients.map(node => node.props.colors as string[]);
            expect(Color(endpoints[0]![0]!).alpha()).toBeCloseTo(effectiveOpacity, 2);
            expect(Color(endpoints[0]![1]!).alpha()).toBe(0);
            expect(Color(endpoints[1]![0]!).alpha()).toBe(0);
            expect(Color(endpoints[1]![1]!).alpha()).toBeCloseTo(effectiveOpacity, 2);
        }
    });
});
