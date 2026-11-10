import * as React from 'react';
import Color from 'color';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, flattenTestStyle, standardCleanup } from '@/dev/testkit';
import { installExpoGlassEffectRequireStub } from '@/dev/testkit/mocks/expoGlassEffect';
import { resolveGlassTintValues } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
import { GlassSurface } from './GlassSurface';
import { GlassMaterialSettingsProvider } from './useGlassMaterialSettings';
import { GlassRuntimeEnvironmentProvider } from './glassRuntimeEnvironment';
import { glassPresetMaterials } from './glassMaterial';

const restoreGlass = installExpoGlassEffectRequireStub({
  isAvailable: () => true,
});
afterAll(restoreGlass);
afterEach(standardCleanup);

// iOS's platform renderer and the native material SDK are the system boundary; material policy stays real.
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  const { lightTheme } = await import('@/theme');
  return createUnistylesMock({ theme: lightTheme });
});
vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  return createReanimatedModuleMock();
});
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: (props: Record<string, unknown>) =>
    React.createElement('LinearGradient', props),
}));

/** The strongest fill painted over the native glass inside the surface's material layer. */
async function coatOverGlass(
  role: 'menu' | 'panel',
  materials: ReturnType<typeof glassPresetMaterials> = glassPresetMaterials('auto'),
): Promise<number> {
  const screen = await renderScreen(
    <GlassRuntimeEnvironmentProvider value={{ nativeRenderer: true }}>
      <GlassMaterialSettingsProvider
        value={{ glassSurfaceMaterials: materials }}
      >
        <GlassSurface surfaceGroup="floating" floatingRole={role}>
          <></>
        </GlassSurface>
      </GlassMaterialSettingsProvider>
    </GlassRuntimeEnvironmentProvider>,
  );
  // The material layer is the touch-transparent view holding the glass; any fill painted in it lies over the glass.
  expect(screen.findAllByType('GlassView')).toHaveLength(1);
  const fills = screen
    .findAll((node) => node.props.pointerEvents === 'none')
    .map((node) => flattenTestStyle(node.props.style).backgroundColor)
    .filter(
      (fill): fill is string =>
        typeof fill === 'string' && fill !== 'transparent',
    )
    .map((fill) => Color(fill).alpha());
  return Math.max(0, ...fills);
}

// NATIVE-SWEEP-1110 M3: in light, list rows and the recovery banner read through native popovers. The web
// lays the panel coat over a light floating surface because what lies under it is ink; native glass must too.
describe('iOS floating glass in light', () => {
  it.each(['menu', 'panel'] as const)(
    'carries the panel coat over the glass for a %s',
    async (role) => {
      expect(await coatOverGlass(role)).toBeGreaterThanOrEqual(
        resolveGlassTintValues(undefined).panelCoat,
      );
    },
  );

  it('paints a customized appearance exactly as set, with no coat over its glass', async () => {
    const custom = { ...glassPresetMaterials('auto'), floating: { blur: 'regular', opacity: 0.33 } } as const;
    expect(await coatOverGlass('menu', custom)).toBe(0);
  });
});
