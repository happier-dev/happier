import { expect, it } from 'vitest';
import { act } from 'react';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { ChartInteractionProvider, ChartPathMark, type HappierChartDatumRenderer } from './ChartDatum.js';
import { IntervalTimeline } from './IntervalTimeline.js';
import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { HappierUiPlatformProvider } from '../../environment/context.js';

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

it('retains native track scrubbing while exact values owns the repeated intervals’ accessible reading', () => {
  const view = mountThroughReactNativeWeb(<HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
    <IntervalTimeline theme={theme} label="Rainfall" layout="lanes" testID="native-intervals" domain={{ start: 0, end: 10 }}
      intervals={[{ id: 'one', label: 'North', start: 1, end: 2, lane: 'North', datum: { label: 'North', value: '1–2', keyboard: false } }]} />
  </HappierUiPlatformProvider>);
  try {
    const track = view.container.querySelector<HTMLElement>('[data-testid="native-intervals-lane-0-track-0"]')!;
    expect(track.getAttribute('aria-hidden')).toBe('true');
    expect(view.container.querySelector('[data-testid="native-intervals-interval-one"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="native-intervals-values-toggle"]')).not.toBeNull();
  } finally { view.unmount(); }
});

it.each(['rows', 'lanes'] as const)('keeps repeated %s intervals pointer-inspectable while exact values owns keyboard access', layout => {
  const view = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={renderDatum}>
    <IntervalTimeline theme={theme} label="Rainfall" layout={layout} testID="intervals" domain={{ start: 0, end: 10 }}
      intervals={[{ id: 'one', label: 'North', start: 1, end: 2, lane: 'North', datum: { label: 'North', value: '1–2', keyboard: false } }]} />
  </ChartInteractionProvider>);
  try {
    const trigger = view.container.querySelector<HTMLElement>('[data-testid="intervals-select-one"]')!;
    expect(trigger).not.toBeNull();
    expect(trigger.tabIndex).toBe(-1);
    expect(trigger.getAttribute('aria-hidden')).toBe('true');
    expect(trigger.getAttribute('aria-describedby')).toBe('datum-tooltip');
    act(() => trigger.click());
    expect(trigger.getAttribute('aria-pressed')).toBe('true');
    expect(view.container.querySelector('[data-testid="intervals-values-toggle"]')).not.toBeNull();
  } finally { view.unmount(); }
});
