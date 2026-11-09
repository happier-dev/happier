import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  hitAreaOverlap,
  layoutHitArea,
} from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
// The usage popover body reads the Account's usage stores and has its own suite; the trigger is under test.
vi.mock(
  '@/components/navigation/shell/sidebarFooter/SessionUsagePopoverContent',
  () => ({
    SessionUsagePopoverContent: () => null,
  }),
);

import { ContextGaugeInstrument } from './ContextGaugeInstrument';
import { QuotaRingInstrument } from './QuotaRingInstrument';
import { GitDeltaInstrument } from './GitDeltaInstrument';
import {
  INSTRUMENT_STRIP_LINE_HEIGHT_PX,
  instrumentStripStyles,
} from './instrumentStripStyles';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type QuotaViewModel = React.ComponentProps<
  typeof QuotaRingInstrument
>['viewModel'];

const QUOTA = {
  serviceId: null,
  providerDisplayName: 'Claude',
  activeAccountDisplayLabel: null,
  remainingPct: 60,
  usedPct: 40,
  primaryValueSemantics: 'remaining',
  valueLabel: '60% left',
  ringValueLabel: '60',
  badgeLabel: '60% left',
  scopePrefix: null,
  detailRightLabel: 'Resets in 2h',
  usedLimitLabel: null,
  resetLabel: null,
  tone: 'neutral',
  isStale: false,
  effectiveMeter: {} as QuotaViewModel['effectiveMeter'],
  allMeterRows: [],
  usageRings: [],
  recoveryCreditSummary: null,
} satisfies QuotaViewModel;

const CONTEXT = {
  usedPct: 25,
  usedTokens: 50_000,
  windowTokens: 200_000,
  baselineTokens: null,
  totalProcessedTokens: null,
  isAutoCompactEnabled: null,
  categories: null,
  source: 'provider_turn' as const,
  stale: false,
};

describe('instrument strip hit areas', () => {
  afterEach(async () => {
    await standardCleanup();
  });

  it('meets each neighbour halfway across the cluster gap and stays on the strip line, off the composer', async () => {
    const screen = await renderScreen(
      <HappierUiPlatformProvider
        platform={{ platform: 'ios', colorScheme: 'light' }}
      >
        <ContextGaugeInstrument
          model={CONTEXT}
          showPercentText={false}
          isStreaming={false}
          onRefresh={() => {}}
        />
        <QuotaRingInstrument viewModel={QUOTA} showProviderGlyph={false} />
        <GitDeltaInstrument
          git={{
            branch: 'main',
            upstream: null,
            ahead: 0,
            behind: 0,
            changedFiles: 2,
            linesAdded: 12,
            linesRemoved: 3,
            hasLineChanges: true,
            hasAnyChanges: true,
          }}
          compact={false}
          onPress={() => {}}
        />
      </HappierUiPlatformProvider>,
    );
    const glyph = 16;
    const gauge = await layoutHitArea(
      () => screen.findHostByTestId('session-instrument-context-gauge'),
      { width: glyph, height: glyph },
    );
    const quota = await layoutHitArea(
      () => screen.findHostByTestId('session-instrument-quota-ring'),
      { width: 60, height: glyph },
    );
    const git = await layoutHitArea(
      () => screen.findHostByTestId('session-instrument-git'),
      { width: 48, height: glyph },
    );
    const clusterGap = Number(instrumentStripStyles.cluster.gap);
    expect(clusterGap).toBeGreaterThan(0);
    expect(
      hitAreaOverlap(gauge, quota, { axis: 'horizontal', gap: clusterGap }),
    ).toBe(0);
    expect(
      hitAreaOverlap(quota, git, { axis: 'horizontal', gap: clusterGap }),
    ).toBe(0);
    // The strip's line is the instruments' whole band: a finger above it is on the transcript, below it on the composer.
    for (const area of [gauge, quota, git]) {
      expect(area.height).toBeLessThanOrEqual(INSTRUMENT_STRIP_LINE_HEIGHT_PX);
      expect(area.insets.top).toBe(area.insets.bottom);
    }
  });
});
