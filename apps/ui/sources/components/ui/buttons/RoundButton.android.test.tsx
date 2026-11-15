import * as React from 'react';
import Color from 'color';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen, flattenTestStyle } from '@/dev/testkit';

// Android's platform renderer and the theme/native SDKs are the system boundary.
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

// Collect the real owner graph before a case's deadline starts (a cold transform outlasts one case under load).
const { RoundButton } = await import('./RoundButton');
const { GlassSurface } = await import('@/components/ui/glass/GlassSurface');
const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');

describe('RoundButton on Android', () => {
    it('stands a bordered button on a tinted card without the elevation Android paints through its translucent fill', async () => {
        const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ nativeRenderer: true, atmosphereBehind: 'wallpaper' }}>
            <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
                <GlassSurface surfaceGroup="card" solidColor="#ffffff">
                    <RoundButton testID="voice" display="secondary" title="Set up Voice" onPress={() => {}} />
                </GlassSurface>
            </GlassMaterialSettingsProvider>
        </GlassRuntimeEnvironmentProvider>);
        const pill = screen.findAll(node => 'borderColor' in flattenTestStyle(node.props.style) && 'minHeight' in flattenTestStyle(node.props.style))
            .map(node => flattenTestStyle(node.props.style))
            .find(style => typeof style.backgroundColor === 'string');
        if (!pill) throw new Error('Expected the bordered pill');
        expect(Color(String(pill.backgroundColor)).alpha()).toBeLessThan(1);
        expect(pill.elevation ?? 0).toBe(0);
    });
});
