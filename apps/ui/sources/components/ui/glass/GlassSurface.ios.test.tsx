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

  // Owner 2026-11-10: an opaque tint (dafbb56ffd) turned the tab bar and popovers into flat discs; even a hair of tint
  // switches Liquid Glass to its tinted mode, darker than 0.2's clear glass (owner ~20:00). The glass is untinted, as
  // in 0.2; the app appearance still decides its scheme, and panels carry their coat over it.
  it('draws Liquid Glass untinted, as 0.2 did', async () => {
    liquid.available = true;
    const screen = await renderScreen(
      <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
        <GlassSurface><></></GlassSurface>
      </GlassMaterialSettingsProvider>,
    );
    expect(screen.findByType('GlassView').props.tintColor).toBeUndefined();
  });

  // Owner 2026-11-10: the tab bar's and the View popover's edges looked cut and doubled. Liquid Glass draws its own
  // rim along its own shape, so the glass takes the surface's corners and fills its border box: one edge.
  it('draws Liquid Glass in the surface shape, under its border, so the glass edge and the border are one', async () => {
    liquid.available = true;
    const screen = await renderScreen(
      <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
        <GlassSurface style={{ borderRadius: 24, borderWidth: 1.5 }}><></></GlassSurface>
      </GlassMaterialSettingsProvider>,
    );
    const glass = screen.findByType('GlassView');
    expect(flattenTestStyle(glass.props.style).borderRadius).toBe(24);
    // The material layer is the outermost touch-transparent view; the glass lies inside it.
    const layer = flattenTestStyle(screen.findAll((node) => node.props.pointerEvents === 'none')[0]?.props.style);
    expect([layer.top, layer.left, layer.right, layer.bottom]).toEqual([-1.5, -1.5, -1.5, -1.5]);
    expect(layer.borderRadius).toBe(24);
  });

  // Owner 2026-11-10 18:35: the dark tab bar and menus wore a light grey sheet over the blur. The web's fixed-point
  // coat stands on a backdrop tone native glass doesn't have: a dark menu's glass stays clear, as in 0.2.
  it('lays no coat over a dark native menu or bar: the glass stays clear', async () => {
    liquid.available = true;
    const screen = await renderScreen(
      <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
        <GlassSurface surfaceGroup="floating"><></></GlassSurface>
      </GlassMaterialSettingsProvider>,
    );
    expect(screen.findAllByType('GlassView')).toHaveLength(1);
    const fills = screen.findAll((node) => node.props.pointerEvents === 'none')
      .map((node) => flattenTestStyle(node.props.style).backgroundColor)
      .filter((fill) => typeof fill === 'string' && fill !== 'transparent');
    expect(fills).toEqual([]);
  });

  // NATIVE-STABILITY-1110 M1 (16:43): a dark sheet's coat came out rgba(239,239,239,.586), the ink hair, so white
  // text stood on near-white. A panel's coat is its role's own surface; only its alpha comes from the tint.
  it('coats a dark native panel with its own surface at the panel coat, never with the ink', async () => {
    liquid.available = true;
    const { darkTheme } = await import('@/theme');
    const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
    const { resolveGlassTintValues } = await import('@happier-dev/protocol/actions/settings/glassPreferenceMutations');
    const screen = await renderScreen(
      <GlassRuntimeEnvironmentProvider value={{ nativeRenderer: true }}>
        <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
          <GlassSurface surfaceGroup="floating" floatingRole="panel"><></></GlassSurface>
        </GlassMaterialSettingsProvider>
      </GlassRuntimeEnvironmentProvider>,
    );
    expect(screen.findAllByType('GlassView')).toHaveLength(1);
    const coats = screen.findAll((node) => node.props.pointerEvents === 'none')
      .map((node) => flattenTestStyle(node.props.style).backgroundColor)
      .filter((fill): fill is string => typeof fill === 'string' && fill !== 'transparent')
      .map((fill) => Color(fill));
    expect(coats).toHaveLength(1);
    expect(coats[0]!.rgb().round().array().slice(0, 3)).toEqual(Color(darkTheme.colors.edge.floatingFill).rgb().round().array().slice(0, 3));
    expect(coats[0]!.alpha()).toBeCloseTo(resolveGlassTintValues(undefined).panelCoat, 2);
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
