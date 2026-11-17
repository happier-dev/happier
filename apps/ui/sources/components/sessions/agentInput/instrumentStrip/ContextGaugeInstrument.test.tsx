import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';
import { StyleSheet } from 'react-native';

vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

import { ContextGaugeInstrument } from './ContextGaugeInstrument';
import type { InstrumentStripContextModel } from './useInstrumentStripModel';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CONTEXT: InstrumentStripContextModel = {
  usedPct: 25,
  usedTokens: 50_000,
  windowTokens: 200_000,
  baselineTokens: null,
  totalProcessedTokens: null,
  isAutoCompactEnabled: null,
  categories: null,
  source: 'provider_turn',
  stale: false,
};

async function renderGauge(model: InstrumentStripContextModel) {
  return renderScreen(
    <HappierUiPlatformProvider
      platform={{ platform: 'ios', colorScheme: 'light' }}
    >
      <ContextGaugeInstrument
        model={model}
        showPercentText
        isStreaming={false}
        onRefresh={() => {}}
      />
    </HappierUiPlatformProvider>,
  );
}

describe('ContextGaugeInstrument', () => {
  afterEach(async () => {
    await standardCleanup();
  });

  it('names the share of context a session has used', async () => {
    const screen = await renderGauge(CONTEXT);
    expect(screen.getTextContent()).toContain('25%');
  });

  it('keeps the last reported breakdown readable when opening cannot report refresh activity', async () => {
    const screen = await renderGauge({
      ...CONTEXT,
      categories: [{ key: 'messages', label: 'Messages', tokens: 50_000 }],
    });
    await screen.pressByTestIdAsync('session-instrument-context-gauge');
    const popover = screen.findHostByTestId('session-instrument-context-popover');
    expect(popover).not.toBeNull();
    // Dimming is a visible pending claim. A void refresh request supplies no pending lifecycle.
    const dimmedContent = popover!.findAll((node) => {
      if (typeof node.type !== 'string') return false;
      const opacity = StyleSheet.flatten(node.props.style)?.opacity;
      return typeof opacity === 'number' && opacity < 1;
    });
    expect(dimmedContent).toHaveLength(0);
    expect(screen.getTextContent()).toContain('50,000');
  });

  // Beside the quota ring a bare "0%" read as a second "0% left" (FIN-DESIGN-REVIEW M8): with nothing
  // used yet the empty ring says it on its own.
  it('shows no number before the session has used any context', async () => {
    const screen = await renderGauge({
      ...CONTEXT,
      usedPct: 0,
      usedTokens: 0,
      source: 'derived_estimate',
    });
    expect(
      screen.findHostByTestId('session-instrument-context-gauge'),
    ).toBeTruthy();
    expect(screen.getTextContent()).not.toContain('0%');
  });
});
