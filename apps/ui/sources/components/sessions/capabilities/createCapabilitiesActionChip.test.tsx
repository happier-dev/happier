import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(() => standardCleanup());

async function renderChip(label: string) {
  const { createCapabilitiesActionChip } = await import('./createCapabilitiesActionChip');
  const chip = createCapabilitiesActionChip({ label, attention: false, stabilityKey: 'session:one', popoverContent: () => null });
  return renderScreen(
    <>
      {chip.render({
        chipStyle: () => ({}),
        iconColor: '#000',
        showLabel: true,
        textStyle: {},
        countTextStyle: {},
        chipAnchorRef: React.createRef(),
        toggleCollapsedPopover: () => {},
      } as unknown as Parameters<typeof chip.render>[0])}
    </>,
  );
}

const labelWidth = (screen: Awaited<ReturnType<typeof renderChip>>) =>
  ([screen.findByTestId('session-capabilities-chip:label')?.props.style].flat(Infinity) as Array<{ minWidth?: number } | undefined>)
    .map((style) => style?.minWidth)
    .find((width) => width !== undefined);

it('keeps the chip as wide as a counted label while counts load and when they arrive', async () => {
  // The platform measures the hidden reference label (the layout boundary); the chip then holds that width.
  const unknown = await renderChip('Skills · MCP');
  expect(labelWidth(unknown)).toBeUndefined();
  await act(async () => {
    unknown.findByTestId('session-capabilities-chip:reserve')?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 118, height: 16 } } });
  });
  expect(labelWidth(unknown)).toBe(118);

  const counted = await renderChip('14 skills · 12 MCP');
  await act(async () => {
    counted.findByTestId('session-capabilities-chip:reserve')?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 118, height: 16 } } });
  });
  expect(labelWidth(counted)).toBe(labelWidth(unknown));
});

it('warms its popover on the chip shell\'s intent signals and, in a chip rail, never reaches into the line above or below', async () => {
  const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
  const { layoutHitArea } = await import('@/dev/testkit/harness/hitFrameReach');
  const { AgentInputChipRowReach, resolveAgentInputChipRailHitReach } = await import('@/components/sessions/agentInput/definitions/agentInputChipRowReach');
  const { createCapabilitiesActionChip } = await import('./createCapabilitiesActionChip');
  const onIntent = vi.fn();
  const chip = createCapabilitiesActionChip({ label: 'Skills', attention: false, stabilityKey: 'session:one', popoverContent: () => null, onIntent });
  const screen = await renderScreen(
    <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}><AgentInputChipRowReach reach={resolveAgentInputChipRailHitReach(6)}>
      {chip.render({
        chipStyle: () => ({ height: 24 }), iconColor: '#000', showLabel: true, textStyle: {}, countTextStyle: {},
        chipAnchorRef: React.createRef(), toggleCollapsedPopover: () => {},
      } as unknown as Parameters<typeof chip.render>[0])}
    </AgentInputChipRowReach></HappierUiPlatformProvider>,
  );
  const host = () => screen.findHostByTestId('session-capabilities-chip');
  act(() => { host()!.props.onHoverIn(); host()!.props.onPressIn(); host()!.props.onFocus(); });
  expect(onIntent).toHaveBeenCalledTimes(3);
  const area = await layoutHitArea(host, { width: 90, height: 24 });
  // A finger's target reaches only half the rail's line gap toward the chip lines above and below it.
  expect(area.insets.top).toBe(0.5);
  expect(area.insets.bottom).toBe(0.5);
});
