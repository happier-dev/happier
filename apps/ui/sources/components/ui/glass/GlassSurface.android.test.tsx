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

describe('Android material fallback', () => {
    it('shares translucent field ink with the native containing plane but keeps disabled and accessibility-solid fields unchanged', async () => {
        const { GlassSurface } = await import('./GlassSurface');
        const { CompactSearchField } = await import('@/components/ui/forms/CompactSearchField');
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { lightTheme } = await import('@/theme');
        for (const solid of ['glass', 'disabled', 'reduceTransparency'] as const) {
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ reduceTransparency: solid === 'reduceTransparency' }}>
                <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
                    <GlassSurface surfaceGroup="floating" enabled={solid !== 'disabled'}>
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
    it('keeps menu edges at the same alpha as its Android tint, including synced transparency and OS recovery', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay');
        const before = storage.getState();
        try {
            for (const opacity of [0, 0.2]) {
                act(() => storage.setState({ settings: { ...before.settings, glassBlurEnabled: true,
                    glassSurfaceMaterials: { ...glassPresetMaterials('everywhere'), floating: { blur: 'strong', opacity } },
                } }));
                for (const reduceTransparency of [false, true]) {
                    const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ reduceTransparency }}>
                        <FloatingOverlay edgeFades initialVisibility={{ top: true, bottom: true }}><React.Fragment /></FloatingOverlay>
                    </GlassRuntimeEnvironmentProvider>);
                    const gradients = screen.findAllByType('LinearGradient');
                    expect(gradients).toHaveLength(2);
                    const effective = reduceTransparency ? 1 : opacity;
                    expect(Color(gradients[0]!.props.colors[0]).alpha()).toBeCloseTo(effective, 2);
                    expect(Color(gradients[1]!.props.colors[1]).alpha()).toBeCloseTo(effective, 2);
                    // Finish stays one low-alpha ink coat through tint and the
                    // OS solid fallback; edge fades are not finish layers.
                    const finishLayer = screen.findAllByType('Svg').filter(node => node.props.accessibilityElementsHidden === true);
                    expect(finishLayer).toHaveLength(1);
                    expect(finishLayer[0]!.findAllByType('Rect')).toHaveLength(1);
                    expect(finishLayer[0]!.findAllByType('Stop').map(node => Color(node.props.stopColor).alpha())).toEqual([0, 0.024]);
                    standardCleanup();
                }
            }
        } finally { standardCleanup(); act(() => storage.setState(before, true)); }
    });

    it('keeps floating glass translucent as a tint when there is no blur target', async () => {
        const { GlassSurface } = await import('./GlassSurface');
        const screen = await renderScreen(<GlassSurface testID="android-material" solidColor="#ffffff"><></></GlassSurface>);
        expect(flattenTestStyle(screen.findByTestId('android-material')?.props.style).backgroundColor)
            .toBe('rgba(255, 255, 255, 0.02)');
    });
});
