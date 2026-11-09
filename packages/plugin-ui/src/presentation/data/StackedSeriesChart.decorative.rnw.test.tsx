import { describe, expect, it } from 'vitest';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { StackedSeriesChart } from './StackedSeriesChart.js';

/** A five-minute summary line: one point per sample, many more points than the line has pixels. */
function line(count: number) {
  return [{ id: 'line', label: '', points: Array.from({ length: count }, (_, index) => ({ id: String(index), x: index, y: (index % 7) / 7 })) }];
}

function renderedElements(count: number): number {
  const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="" series={line(count)} variant="line" size="inline"
    width={56} viewportHeight={14} minimumMaximum={1} showAxis={false} showLegend={false} showGrid={false} showReadout={false} decorative />);
  try {
    return mount.container.querySelectorAll('*').length;
  } finally { mount.unmount(); }
}

describe('decorative series chart', () => {
  it('draws a summary line without a node per sample', () => {
    // A row's sparkline is a picture: its owner states the values, so the chart adds no per-bucket hit layer.
    expect(renderedElements(150)).toBe(renderedElements(10));
  });

  it('is hidden from assistive technology and offers no control', () => {
    const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="CPU" testID="decorative" series={line(150)} variant="line"
      size="inline" width={56} viewportHeight={14} minimumMaximum={1} showAxis={false} showLegend={false} showGrid={false} showReadout={false} decorative />);
    try {
      const root = mount.container.querySelector<HTMLElement>('[data-testid="decorative"]')!;
      expect(root.getAttribute('aria-hidden')).toBe('true');
      expect(root.getAttribute('aria-label')).toBeNull();
      expect(mount.container.querySelectorAll('[tabindex="0"], button, [role="button"]')).toHaveLength(0);
      expect(mount.container.querySelectorAll('path').length).toBeGreaterThan(0);
    } finally { mount.unmount(); }
  });
});
