import { expect, it } from 'vitest';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { ChartInteractionProvider, ChartPathMark, type HappierChartDatumRenderer } from './ChartDatum.js';

const renderDatum: HappierChartDatumRenderer = (_datum, visual, _testID, renderTrigger) => renderTrigger?.({
  describedBy: 'datum-tooltip', onHoverChange: () => {}, onFocusChange: () => {}, onPress: () => {},
}) ?? visual;

it('hides repeated SVG marks from assistive technology while retaining the selected series path and tooltip association', () => {
  const view = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={renderDatum}>
    <ChartPathMark testID="series" datum={{ label: 'Rainfall', value: '12 mm' }} d="M0 0 L10 10" strokeWidth={2} bounds={{ x: 0, y: 0, width: 10, height: 10 }} />
    <ChartPathMark testID="repeat" datum={{ label: 'Rainfall', value: '12 mm', keyboard: false }} d="M0 0 L10 10" strokeWidth={2} bounds={{ x: 0, y: 0, width: 10, height: 10 }} />
  </ChartInteractionProvider>);
  try {
    const series = view.container.querySelector('[data-testid="series"]')!;
    const repeat = view.container.querySelector('[data-testid="repeat"]')!;
    expect(series.getAttribute('aria-describedby')).toBe('datum-tooltip');
    expect(series.closest('svg')?.getAttribute('aria-label')).toBe('Rainfall: 12 mm');
    expect(repeat.closest('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(repeat.getAttribute('tabindex')).toBe('-1');
  } finally { view.unmount(); }
});
