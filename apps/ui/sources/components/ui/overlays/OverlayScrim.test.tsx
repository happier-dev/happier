import { readBrowserMaterialVariables, resolveBrowserMaterialPaint } from '@/dev/testkit/glassBackdrop';
import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Color from 'color';
import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

const accessibilityBoundary = vi.hoisted(() => ({ reduceTransparency: false }));

// Platform gradient, mask and animation adapters are renderer/OS boundaries.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ AccessibilityInfo: {
        isReduceMotionEnabled: async () => false,
        isReduceTransparencyEnabled: async () => accessibilityBoundary.reduceTransparency,
        addEventListener: () => ({ remove() {} }),
    } });
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

// The production seam lazily requires expo-blur; Vitest cannot intercept CommonJS require.
// Replace that SDK accessor only, retaining the real platform availability decision.
vi.mock('@/components/ui/glass/blurMaterial', async importOriginal => ({
    ...await importOriginal<typeof import('@/components/ui/glass/blurMaterial')>(),
    getBlurViewComponent: () => (props: Record<string, unknown>) => React.createElement('BlurView', props),
}));

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
    accessibilityBoundary.reduceTransparency = false;
    act(() => storage.setState(previousState, true));
});

describe('native floating composer band', () => {
    it.each(['android', 'ios-blur-off', 'ios-blur'] as const)('hides the page behind the header rows in every tier (%s)', async (tier) => {
        const previousOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: tier === 'android' ? 'android' : 'ios' });
        try {
            const { ScrimBand } = await import('./ScrimBand');
            const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
            act(() => storage.setState({ settings: { ...previousState.settings, glassBlurEnabled: tier !== 'ios-blur-off',
                glassSurfaceMaterials: glassPresetMaterials('everywhere') } }));
            const screen = await renderScreen(<ScrimBand shown progress={makeMutable(1)} rampHeight={128} axes="top" strength="soft"
                reach={{ right: 0, bottom: 48 }} picture={null} />);
            // Frost dissolves the band's top on iOS; it never replaces the ground under the seated rows.
            expect(screen.findAllByType('BlurView')).toHaveLength(tier === 'ios-blur' ? 3 : 0);
            // Blur or not, the band has to hide the text behind the card and the rows seated above it
            // (the status line and the header sit in the lower part of the ramp), not tint it.
            const dim = screen.findAllByType('LinearGradient').find(node => node.props.dither)!;
            const colors = dim.props.colors as string[];
            const locations = dim.props.locations as number[];
            const alphaAt = (t: number) => {
                const next = locations.findIndex(location => location >= t);
                const [a, b] = [Math.max(0, next - 1), next];
                const span = locations[b]! - locations[a]!;
                const mix = span > 0 ? (t - locations[a]!) / span : 0;
                return Color(colors[a]!).alpha() * (1 - mix) + Color(colors[b]!).alpha() * mix;
            };
            for (const t of [0, 0.35, 0.7]) expect(alphaAt(t)).toBeGreaterThanOrEqual(0.9);
            // Still a band, not a sheet: it clears at the far end.
            expect(Color(colors.at(-1)!).alpha()).toBe(0);
            const underlay = screen.findAll(node => typeof node.type === 'string'
                && typeof flattenTestStyle(node.props.style)?.backgroundColor === 'string')[0]!;
            expect(Color(flattenTestStyle(underlay.props.style)!.backgroundColor as string).alpha()).toBeGreaterThanOrEqual(0.9);
        } finally {
            standardCleanup();
            Object.defineProperty(Platform, 'OS', { configurable: true, value: previousOS });
        }
    });
    it.each(['ios', 'android'] as const)('keeps Reduce Transparency opaque without a picture or blur on %s', async platform => {
        const previousOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        accessibilityBoundary.reduceTransparency = true;
        try {
            const { ScrimBand } = await import('./ScrimBand');
            const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
            const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
            act(() => storage.setState({ settings: { ...previousState.settings, glassBlurEnabled: true,
                glassSurfaceMaterials: glassPresetMaterials('everywhere') } }));
            const uri = 'file:///cached-atmosphere.jpg';
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ reduceTransparency: true }}>
                <ScrimBand shown progress={makeMutable(1)} rampHeight={128} axes="top" strength="rich"
                    reach={{ right: 0, bottom: 48 }} picture={{ kind: 'picture', uri }} />
            </GlassRuntimeEnvironmentProvider>);
            expect(screen.findAll(node => typeof node.type === 'string' && node.props.source?.uri === uri)).toHaveLength(0);
            expect(screen.findAllByType('BlurView')).toHaveLength(0);
            const dim = screen.findAllByType('LinearGradient').find(node => node.props.dither)!;
            expect(Color(dim.props.colors[0]).alpha()).toBe(1);
        } finally {
            standardCleanup();
            accessibilityBoundary.reduceTransparency = false;
            Object.defineProperty(Platform, 'OS', { configurable: true, value: previousOS });
        }
    });
    it.each(['ios', 'android'] as const)('carries the supplied picture and changes strength on %s', async (platform) => {
        const previousOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        const { ScrimBand } = await import('./ScrimBand');
        try {
            const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
            act(() => storage.setState({ settings: { ...previousState.settings, glassBlurEnabled: true,
                glassSurfaceMaterials: glassPresetMaterials('everywhere') } }));
            const picture = { kind: 'picture' as const, uri: 'file:///cached-atmosphere.jpg' };
            const props = { shown: true, progress: makeMutable(1), rampHeight: 128, axes: 'top' as const,
                reach: { right: 0, bottom: 48 }, picture };
            const screen = await renderScreen(<ScrimBand {...props} strength="subtle" />);
            const image = () => screen.findAll(node => typeof node.type === 'string' && node.props.source?.uri === picture.uri);
            expect(image()).toHaveLength(1);
            const opacity = () => Math.max(...screen.findAllByType('LinearGradient').filter(node => node.props.dither).flatMap(node =>
                (node.props.colors as string[]).map(color => Color(color).alpha())));
            const pictureOpacity = () => flattenTestStyle(image()[0]!.props.style)!.opacity as number;
            const subtle = { dim: opacity(), picture: pictureOpacity() };
            await screen.update(<ScrimBand {...props} strength="rich" />);
            expect(pictureOpacity()).toBeGreaterThan(subtle.picture);
            // The ground under the seated rows is opaque at every strength; strength moves the frost and picture.
            expect(opacity()).toBe(1);
            expect(image()).toHaveLength(1);
            expect(screen.findAllByType('BlurView')).toHaveLength(platform === 'ios' ? 3 : 0);
        } finally {
            standardCleanup();
            Object.defineProperty(Platform, 'OS', { configurable: true, value: previousOS });
        }
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
            const endpoints = gradients.map(node => (node.props.colors as string[]).map(color =>
                resolveBrowserMaterialPaint(color, readBrowserMaterialVariables(node))));
            expect(Color(endpoints[0]![0]!).alpha()).toBeCloseTo(effectiveOpacity, 2);
            expect(Color(endpoints[0]![1]!).alpha()).toBe(0);
            expect(Color(endpoints[1]![0]!).alpha()).toBe(0);
            expect(Color(endpoints[1]![1]!).alpha()).toBeCloseTo(effectiveOpacity, 2);
        }
    });
});
