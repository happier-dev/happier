import * as React from 'react';
import Color from 'color';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, flattenTestStyle, standardCleanup } from '@/dev/testkit';
import { installExpoGlassEffectRequireStub } from '@/dev/testkit/mocks/expoGlassEffect';
import { GlassSurface } from './GlassSurface';
import { GlassMaterialSettingsProvider } from './useGlassMaterialSettings';
import { glassPresetMaterials } from './glassMaterial';

const liquid = vi.hoisted(() => ({ available: false }));
const restoreGlass = installExpoGlassEffectRequireStub({ isAvailable: () => liquid.available });
afterAll(restoreGlass);
afterEach(() => {
  liquid.available = false;
  standardCleanup();
});

// iOS's platform renderer and the native material SDKs are the system boundary; material policy stays real.
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  const { darkTheme } = await import('@/theme');
  return createUnistylesMock({ theme: darkTheme });
});
vi.mock('expo-blur', () => ({
  BlurView: (props: Record<string, unknown>) =>
    React.createElement('BlurView', props),
}));
vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  return createReanimatedModuleMock();
});
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: (props: Record<string, unknown>) =>
    React.createElement('LinearGradient', props),
}));

describe('iOS material without blur', () => {
  it('uses the app appearance for Liquid Glass even when iOS follows another appearance', async () => {
    liquid.available = true;
    const screen = await renderScreen(
      <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
        <GlassSurface><></></GlassSurface>
      </GlassMaterialSettingsProvider>,
    );
    // The SDK's absent/auto value follows iOS; its explicit value overrides UIKit appearance.
    expect(screen.findByType('GlassView').props.colorScheme).toBe('dark');
  });

  it('grounds native floating glass in the app palette rather than the SDK default tint', async () => {
    liquid.available = true;
    const { darkTheme } = await import('@/theme');
    const screen = await renderScreen(
      <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
        <GlassSurface><></></GlassSurface>
      </GlassMaterialSettingsProvider>,
    );
    // UIKit chooses its own tint when omitted, independently of the app's floating surface paint.
    expect(screen.findByType('GlassView').props.tintColor).toBe(darkTheme.colors.edge.floatingFill);
  });

  it('keeps an authored translucent coat with Blur Off as a tint, while accessibility, an inactive window and Solid stay opaque', async () => {
    const { GlassSurface } = await import('./GlassSurface');
    const { GlassRuntimeEnvironmentProvider } =
      await import('./glassRuntimeEnvironment');
    const { GlassMaterialSettingsProvider } =
      await import('./useGlassMaterialSettings');
    const { glassPresetMaterials } = await import('./glassMaterial');
    const custom = {
      ...glassPresetMaterials('auto'),
      floating: { blur: 'off', opacity: 0.33 },
    } as const;
    for (const [materials, environment, alpha] of [
      [custom, {}, 0.33],
      [custom, { reduceTransparency: true }, 1],
      [custom, { windowActive: false }, 1],
      [glassPresetMaterials('solid'), {}, 1],
    ] as const) {
      const screen = await renderScreen(
        <GlassRuntimeEnvironmentProvider value={environment}>
          <GlassMaterialSettingsProvider
            value={{ glassSurfaceMaterials: materials }}
          >
            <GlassSurface testID="ios-material" solidColor="#204060">
              <></>
            </GlassSurface>
          </GlassMaterialSettingsProvider>
        </GlassRuntimeEnvironmentProvider>,
      );
      const fill = flattenTestStyle(
        screen.findByTestId('ios-material')?.props.style,
      ).backgroundColor;
      expect(Color(String(fill)).alpha()).toBeCloseTo(alpha, 2);
      expect(screen.findAllByType('BlurView')).toHaveLength(0);
      standardCleanup();
    }
  });
});
