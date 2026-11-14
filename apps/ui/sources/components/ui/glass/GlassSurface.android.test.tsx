import * as React from 'react';
import { act } from 'react-test-renderer';
import Color from 'color';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen, flattenTestStyle, standardCleanup } from '@/dev/testkit';

// Android's platform renderer and theme/native SDKs are the system boundary.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-glass-effect', () => ({ isLiquidGlassAvailable: () => false }));
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('expo-linear-gradient', () => ({
    LinearGradient: (props: Record<string, unknown>) => React.createElement('LinearGradient', props),
}));

// Collect the real owner graph before any case's deadline starts: a cold transform of this graph takes longer
// than a case's 60 s on a loaded host, and inside a case it timed out whichever case ran first (UI refinements 11-13).
const { GlassSurface } = await import('./GlassSurface');
const { CompactSearchField } = await import('@/components/ui/forms/CompactSearchField');
const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
const { glassPresetMaterials } = await import('./glassMaterial');
const { lightTheme } = await import('@/theme');
const { storage } = await import('@/sync/domains/state/storage');
const { FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay');

describe('Android material fallback', () => {
    it('shares translucent field ink with an in-flow card plane but keeps disabled and accessibility-solid fields unchanged', async () => {
        for (const solid of ['glass', 'disabled', 'reduceTransparency'] as const) {
            // A card is translucent only with a picture behind it; over the plain page it is solid.
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ reduceTransparency: solid === 'reduceTransparency', atmosphereBehind: 'wallpaper' }}>
                <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
                    <GlassSurface surfaceGroup="card" enabled={solid !== 'disabled'}>
                        <CompactSearchField testID="native-field" value="keep draft" onChangeText={() => {}} placeholder="Search" />
                    </GlassSurface>
                </GlassMaterialSettingsProvider>
            </GlassRuntimeEnvironmentProvider>);
            const fill = screen.findAll(node => typeof node.type === 'string' && flattenTestStyle(node.props.style)?.backgroundColor === lightTheme.colors.edge.fill);
            expect(fill.length > 0).toBe(solid !== 'glass');
            expect(screen.findByTestId('native-field')?.props.value).toBe('keep draft');
            standardCleanup();
        }
    });
    it('keeps menu edges at the alpha of its Android paint: an unblurred Custom tint as set, an opaque fill where blur was asked for', async () => {
        const before = storage.getState();
        try {
            for (const [blur, opacity] of [['off', 0], ['off', 0.2], ['strong', 0.2]] as const) {
                act(() => storage.setState({ settings: { ...before.settings, glassBlurEnabled: true,
                    glassSurfaceMaterials: { ...glassPresetMaterials('everywhere'), floating: { blur, opacity } },
                } }));
                for (const reduceTransparency of [false, true]) {
                    const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ reduceTransparency }}>
                        <FloatingOverlay edgeFades initialVisibility={{ top: true, bottom: true }}><React.Fragment /></FloatingOverlay>
                    </GlassRuntimeEnvironmentProvider>);
                    const gradients = screen.findAllByType('LinearGradient');
                    expect(gradients).toHaveLength(2);
                    // Android has no blur target: a material that asks for blur paints its opaque fill.
                    const effective = reduceTransparency || blur !== 'off' ? 1 : opacity;
                    expect(Color(gradients[0]!.props.colors[0]).alpha()).toBeCloseTo(effective, 2);
                    expect(Color(gradients[1]!.props.colors[1]).alpha()).toBeCloseTo(effective, 2);
                    // Finish stays one low-alpha ink coat through tint and the
                    // OS solid fallback; edge fades are not finish layers.
                    const finishLayer = screen.findAllByType('Svg').filter(node => node.props.accessibilityElementsHidden === true);
                    expect(finishLayer).toHaveLength(1);
                    expect(finishLayer[0]!.findAllByType('Rect')).toHaveLength(1);
                    const stops = finishLayer[0]!.findAllByType('Stop');
                    expect(stops).toHaveLength(2);
                    // Native SVG separates opacity and quantizes it to an alpha byte.
                    for (const [index, alpha] of [0, 0.024].entries()) {
                        expect(Color(stops[index]!.props.stopColor).alpha() * (stops[index]!.props.stopOpacity ?? 1)).toBeCloseTo(alpha, 2);
                    }
                    standardCleanup();
                }
            }
        } finally { standardCleanup(); act(() => storage.setState(before, true)); }
    });

    it('paints dialogs, sheets and menus opaque when there is no blur target; in-flow cards keep their tint', async () => {
        // Anything can stand behind a floating surface (owner 11-13: the Welcome hero showed through a sheet).
        for (const floatingRole of ['panel', 'menu'] as const) {
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ nativeRenderer: true }}>
                <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
                    <GlassSurface testID="android-material" floatingRole={floatingRole} solidColor="#ffffff"><></></GlassSurface>
                </GlassMaterialSettingsProvider>
            </GlassRuntimeEnvironmentProvider>);
            const materialColor = flattenTestStyle(screen.findByTestId('android-material')?.props.style).backgroundColor;
            if (typeof materialColor !== 'string') throw new Error('Expected an Android material background color');
            expect(Color(materialColor).alpha()).toBe(1);
            standardCleanup();
        }
        const card = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ nativeRenderer: true, atmosphereBehind: 'wallpaper' }}>
            <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
                <GlassSurface testID="android-card" surfaceGroup="card" solidColor="#ffffff"><></></GlassSurface>
            </GlassMaterialSettingsProvider>
        </GlassRuntimeEnvironmentProvider>);
        const cardColor = flattenTestStyle(card.findByTestId('android-card')?.props.style).backgroundColor;
        if (typeof cardColor !== 'string') throw new Error('Expected an Android card background color');
        expect(Color(cardColor).alpha()).toBeLessThan(1);
    });

    it('drops the card elevation under a translucent Android tint, where Android paints the shadow through the coat', async () => {
        const card = (style: Record<string, unknown>, settings: 'everywhere' | 'solid') => renderScreen(
            <GlassRuntimeEnvironmentProvider value={{ nativeRenderer: true, atmosphereBehind: 'wallpaper' }}>
                <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials(settings) }}>
                    <GlassSurface testID="android-card" surfaceGroup="card" solidColor="#ffffff" style={style}><></></GlassSurface>
                </GlassMaterialSettingsProvider>
            </GlassRuntimeEnvironmentProvider>);
        const translucent = await card({ elevation: 4, borderRadius: 16 }, 'everywhere');
        const tinted = flattenTestStyle(translucent.findByTestId('android-card')?.props.style);
        expect(Color(String(tinted.backgroundColor)).alpha()).toBeLessThan(1);
        expect(tinted.elevation ?? 0).toBe(0);
        standardCleanup();
        // An opaque card keeps its lift.
        const opaque = await card({ elevation: 4, borderRadius: 16 }, 'solid');
        const solid = flattenTestStyle(opaque.findByTestId('android-card')?.props.style);
        expect(Color(String(solid.backgroundColor)).alpha()).toBe(1);
        expect(solid.elevation).toBe(4);
    });
});
