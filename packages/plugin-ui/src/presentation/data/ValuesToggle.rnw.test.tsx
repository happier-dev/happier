import { describe, expect, it } from 'vitest';

import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { UsageChartValues } from '../usage/charts/chartKit.js';
import { IntervalTimeline } from './IntervalTimeline.js';
import { StackedSeriesChart } from './StackedSeriesChart.js';

const query = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** The words inside a toggle carry its look; compare what the eye compares: ink and weight. */
function toggleLook(root: HTMLElement, id: string) {
  const words = query(root, id)!.querySelector<HTMLElement>('[dir]') ?? query(root, id)!.firstElementChild as HTMLElement;
  return { color: words.style.color, fontWeight: words.style.fontWeight };
}

describe('one values toggle under every chart', () => {
  it('reads the same quiet meta under a series chart, a timeline and a Usage chart', () => {
    const mount = mountThroughReactNativeWeb(<>
      <StackedSeriesChart theme={theme} label="Requests" width={480} size="full" testID="series"
        series={[{ id: 'used', label: 'Used', points: [{ id: 'a', x: 'A', y: 1 }, { id: 'b', x: 'B', y: 2 }] }]} />
      <IntervalTimeline theme={theme} label="Request timeline" size="full" domain={{ start: 0, end: 10 }} testID="timeline"
        geometry={{ width: 600, height: 200 }} intervals={[{ id: 'root', label: 'POST /checkout', start: 0, end: 10 }]} />
      <UsageChartValues theme={theme} label="Daily · Tokens" labels={{ show: 'Exact values', hide: 'Hide values' }} testID="usage"
        table={{ columns: [{ label: 'Day' }, { label: 'Tokens' }], rows: [['Mon', 1234]] }} />
    </>);
    try {
      const series = toggleLook(mount.container, 'series-values-toggle');
      expect(toggleLook(mount.container, 'timeline-values-toggle')).toEqual(series);
      expect(toggleLook(mount.container, 'usage-values-toggle')).toEqual(series);
      // Quiet: not the strong caption weight a bold word would take.
      expect(series.fontWeight).not.toBe('600');
    } finally { mount.unmount(); }
  });
});
