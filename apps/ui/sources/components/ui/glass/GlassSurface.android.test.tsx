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
                    standardCleanup();
                }
            }
        } finally { standardCleanup(); act(() => storage.setState(before, true)); }
    });

    it('keeps floating glass translucent as a tint when there is no blur target', async () => {
        const { GlassSurface } = await import('./GlassSurface');
        const screen = await renderScreen(<GlassSurface testID="android-material" solidColor="#ffffff"><></></GlassSurface>);
        expect(flattenTestStyle(screen.findByTestId('android-material')?.props.style).backgroundColor)
            .toBe('rgba(255, 255, 255, 0.9)');
    });
});
