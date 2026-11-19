import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

const viewport = vi.hoisted(() => ({ width: 390, height: 844 }));

// An iPhone-sized native window: the device type and the popover's placement both read it.
installPopoverCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeNativeMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock(
      { platformOS: 'ios' },
      {
        useWindowDimensions: () => viewport,
        Dimensions: { get: () => ({ ...viewport, scale: 1, fontScale: 1 }) },
      },
    );
  },
});

// Safe-area measurements come from the device SDK.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
  initialWindowMetrics: null,
}));

const { View } = await import('react-native');
const { Text } = await import('@/components/ui/text/Text');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { OverlayPortalHost, OverlayPortalProvider } =
  await import('@/components/ui/popover/OverlayPortal');
const { AgentInputChipPickerPopover } =
  await import('./AgentInputChipPickerPopover');
const { AgentInputContentPopover } = await import('./AgentInputContentPopover');

afterEach(() => {
  viewport.width = 390;
  viewport.height = 844;
});

const ENGINE_OPTIONS = [
  {
    id: 'codex',
    label: 'Codex',
    renderDetailContent: () => <Text testID="models:codex">Codex models</Text>,
  },
  {
    id: 'claude',
    label: 'Claude',
    renderDetailContent: () => (
      <Text testID="models:claude">Claude models</Text>
    ),
  },
];

/** Two composer chips, each opening its own picker, as the composer's overlay layer wires them. */
function ComposerChips() {
  const engineChipRef = React.useRef<React.ElementRef<typeof View>>(null);
  const machineChipRef = React.useRef<React.ElementRef<typeof View>>(null);
  const [open, setOpen] = React.useState<'engine' | 'machine' | null>(null);
  const [agent, setAgent] = React.useState('codex');
  return (
    <OverlayPortalProvider>
      <View testID="composer">
        <View ref={engineChipRef} collapsable={false}>
          <RoundButton
            testID="engine-chip"
            title="Codex"
            onPress={() => setOpen('engine')}
          />
        </View>
        <View ref={machineChipRef} collapsable={false}>
          <RoundButton
            testID="machine-chip"
            title="Machine"
            onPress={() => setOpen('machine')}
          />
        </View>
        <AgentInputChipPickerPopover
          open={open === 'engine'}
          anchorRef={engineChipRef}
          title=""
          options={ENGINE_OPTIONS}
          selectedOptionId={agent}
          onSelect={setAgent}
          onRequestClose={() => setOpen(null)}
        />
        <AgentInputContentPopover
          open={open === 'machine'}
          anchorRef={machineChipRef}
          header={{ title: 'Machine' }}
          content={<Text testID="machine-list">Machines</Text>}
          onRequestClose={() => setOpen(null)}
        />
      </View>
      <View testID="screen-overlay-host">
        <OverlayPortalHost />
      </View>
    </OverlayPortalProvider>
  );
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;
const sheets = (screen: Screen) =>
  screen.findAll((node) => node.props.role === 'dialog');

describe('composer chip popovers on a phone (owner R2/R5, 2026-11-09)', () => {
  it("opens a chip's picker anchored to the chip, not as a sheet, and moves to the next chip in one press", async () => {
    const screen = await renderScreen(<ComposerChips />);

    await screen.pressByTestIdAsync('engine-chip');
    expect(sheets(screen)).toHaveLength(0);
    expect(screen.findByTestId('popover-sheet.close')).toBeNull();
    // R5: the Agent strip above the focused Agent's models, switched in place with no drill-in.
    expect(
      screen.findByTestId('agent-input-chip-picker.top-selector'),
    ).toBeTruthy();
    expect(screen.findByTestId('models:codex')).toBeTruthy();
    expect(
      screen.findByTestId('agent-input-chip-picker.sheet-back'),
    ).toBeNull();
    await screen.pressByTestIdAsync(
      'agent-input-chip-picker.top-selector-option:claude',
    );
    expect(screen.findByTestId('models:claude')).toBeTruthy();
    expect(
      screen.findByTestId('agent-input-chip-picker.top-selector'),
    ).toBeTruthy();

    // The chip row stays reachable: the next chip's press moves the popover to that chip.
    await screen.pressByTestIdAsync('machine-chip');
    expect(sheets(screen)).toHaveLength(0);
    expect(
      screen.findByTestId('agent-input-chip-picker.top-selector'),
    ).toBeNull();
    expect(screen.findByTestId('machine-list')).toBeTruthy();
  });

  it('paints a phone panel in the sheet look (the panel coat), so the page under it never reads through (L12 review D1, R2)', async () => {
    const { GlassSurface } = await import('@/components/ui/glass/GlassSurface');
    const screen = await renderScreen(<ComposerChips />);
    await screen.pressByTestIdAsync('machine-chip');
    expect(sheets(screen)).toHaveLength(0);
    const surfaces = screen.findAllByType(GlassSurface)
      .filter((node) => node.props.surfaceGroup === 'floating');
    expect(surfaces.length).toBeGreaterThan(0);
    expect(surfaces.every((node) => node.props.floatingRole === 'panel')).toBe(true);
  });
});
