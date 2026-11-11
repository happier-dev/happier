import { act } from 'react';
import { expect, it } from 'vitest';
import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import { UsageDailyChart } from './UsageDailyChart.js';
import { View } from 'react-native';

it('reaches every Daily bucket through one exact-values entry at tile and full sizes', () => {
  for (const size of ['tile', 'full'] as const) {
  for (const withScrubLens of [false, true]) {
    const chart = mountThroughReactNativeWeb(<UsageDailyChart theme={theme} gap={12} testID="daily" chart={{
      label: 'Daily tokens', size, width: 390, valuesLabel: 'Daily tokens · Exact values', valuesCollapseLabel: 'Daily tokens · Hide values',
      series: [{ id: 'tokens', label: 'Tokens', points: Array.from({ length: 50 }, (_, index) => ({ id: String(index), x: index, label: `Day ${index}`, y: index + 1 })) }],
      ...(withScrubLens ? { renderPlotOverlay: () => <View testID="scrub-lens" /> } : {}),
    }} />);
    try {
      const stops = [...chart.container.querySelectorAll<HTMLElement>('button,[role="button"]')].filter(node => node.tabIndex === 0);
      expect(stops).toHaveLength(1);
      expect(stops[0]!.getAttribute('aria-label')).toBe('Daily tokens · Exact values');
      expect(chart.container.querySelector('[data-testid="scrub-lens"]') !== null).toBe(withScrubLens);
      act(() => stops[0]!.click());
      const table = chart.container.querySelector('[role="table"]')!;
      expect(table).not.toBeNull();
      expect(table.querySelectorAll('[role="row"]')).toHaveLength(51);
      expect(chart.container.textContent).toContain('Day 49');
      expect(chart.container.textContent).toContain('50');
    } finally { chart.unmount(); }
  }
  }
});
