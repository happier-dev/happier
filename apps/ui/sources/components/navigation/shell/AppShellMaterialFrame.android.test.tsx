import * as React from 'react';
import { View } from 'react-native';
import Color from 'color';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen, flattenTestStyle, standardCleanup } from '@/dev/testkit';

// Native renderer and OS material SDKs are the system boundaries.
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

describe('native shell material planes', () => {
    it('renders one sidebar tint and resolves Reduce Transparency to the exact solid color', async () => {
        const { AppShellMaterialFrame } = await import('./AppShellMaterialFrame');
        const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
        const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const { useUnistyles } = await import('react-native-unistyles');
        const { theme } = useUnistyles();
        try {
            for (const reduceTransparency of [false, true]) {
                const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ reduceTransparency }}>
                    <GlassMaterialSettingsProvider value={{ glassBlurEnabled: true, glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
                        <AppShellMaterialFrame showChrome={false} dragEnabled={false} leftOffsetPx={0} sidebarWidth={320}
                            titleStrip={null} rail={null} column={<View />} peek={null}><View /></AppShellMaterialFrame>
                    </GlassMaterialSettingsProvider>
                </GlassRuntimeEnvironmentProvider>);
                const sidebar = screen.findHostByTestId('navigation-sidebar')!;
                const paint = flattenTestStyle(sidebar.props.style).backgroundColor;
                if (typeof paint !== 'string') throw new Error('Expected the Android material tint to be a color string');
                expect(Color(paint).alpha()).toBeCloseTo(reduceTransparency ? 1 : glassPresetMaterials('everywhere').sidebar.opacity, 2);
                if (reduceTransparency) expect(Color(paint).hexa()).toBe(Color(theme.colors.surface.inset).hexa());
                standardCleanup();
            }
        } finally { standardCleanup(); }
    });
});
