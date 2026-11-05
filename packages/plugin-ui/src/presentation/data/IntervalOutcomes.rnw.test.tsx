import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { HappierUiPlatformProvider } from '../../environment/context.js';
import { IntervalTimeline, selectIntervalTrackRun, stepIntervalTrackRun } from './IntervalTimeline.js';
import { OutcomeScatter } from './OutcomeScatter.js';
import { ChartInteractionProvider } from './ChartDatum.js';

const query = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('neutral intervals and outcomes', () => {
  it.each(['full', 'tile'] as const)('uses admitted domain precision without changing visible date wording at %s', size => {
    const mount = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={(datum, visual, testID, renderTrigger) =>
      <span data-testid={testID} title={datum.value}>{renderTrigger ? renderTrigger({ onHoverChange() {}, onFocusChange() {}, onPress() {} }) : visual}</span>}>
      <IntervalTimeline theme={SURFACE_CONTEXT_THEME_FIXTURE} testID="dated" label="Resets" size={size} domain={{ start: 0, end: 24 }}
        geometry={{ width: 500, height: 160 }} formatValue={() => 'Tomorrow, 12:00'}
        intervals={[{ id: 'reset', kind: 'point', label: 'Weekly', start: 12, end: 12,
          datum: { label: 'Weekly', value: '2026-11-01T12:00:30.125Z · 69.875%' } }]} />
    </ChartInteractionProvider>);
    try {
      expect(query(mount.container, size === 'full' ? 'dated-datum-reset' : 'dated-values-datum-reset')?.title).toBe('2026-11-01T12:00:30.125Z · 69.875%');
      if (size === 'full') {
        act(() => query(mount.container, 'dated-select-reset')!.click());
        expect(query(mount.container, 'dated-readout')?.textContent).toContain('Tomorrow, 12:00');
      }
      expect(mount.container.textContent).not.toContain('2026-11-01T12:00:30.125Z');
    } finally { mount.unmount(); }
  });
  it('keeps dense scatter marks inspectable by pointer without overlapping native selection controls', () => {
    const mount = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={(datum, visual, testID) =>
      <span data-testid={testID} title={`${datum.label}: ${datum.value}`}>{visual}</span>}>
      <OutcomeScatter theme={SURFACE_CONTEXT_THEME_FIXTURE} testID="dense-scatter" label="Samples" xLabel="Cost" yLabel="Merged"
        geometry={{ width: 390, height: 180 }} points={[{ id: 'a', label: 'Audit', x: 1, y: 0 }, { id: 'b', label: 'Docs', x: 1, y: 0 }]} />
    </ChartInteractionProvider>);
    try {
      expect(query(mount.container, 'dense-scatter-mark-a')?.title).toContain('Audit: Cost: 1');
      expect(query(mount.container, 'dense-scatter-mark-b')?.title).toContain('Docs: Cost: 1');
      expect(query(mount.container, 'dense-scatter-select-a')).toBeNull();
    } finally { mount.unmount(); }
  });
  it('binds scatter marks and timeline controls to the host datum without replacing their selection', () => {
    const mount = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={(datum, visual, testID, renderTrigger) =>
      <span data-testid={testID} title={`${datum.label}: ${datum.value}`}>{renderTrigger ? renderTrigger({
        onHoverChange() {}, onFocusChange() {}, onPress() {},
      }) : visual}</span>}>
      <OutcomeScatter theme={SURFACE_CONTEXT_THEME_FIXTURE} testID="hover-scatter" label="Runs" xLabel="Tokens" yLabel="Merged"
        formatX={value => value > 1000 ? '4.2M' : String(value)}
        geometry={{ width: 500, height: 320 }} points={[{ id: 'a', label: 'Audit', x: 4186010, y: 2 }, { id: 'b', label: 'Docs', x: 1, y: 0 }]} />
      <IntervalTimeline theme={SURFACE_CONTEXT_THEME_FIXTURE} testID="hover-time" label="Resets" domain={{ start: 0, end: 24 }}
        geometry={{ width: 500, height: 160 }} intervals={[{ id: 'reset', kind: 'point', label: 'Weekly', start: 12, end: 12 }]} />
    </ChartInteractionProvider>);
    try {
      expect(query(mount.container, 'hover-scatter-datum-a')?.title).toContain('4,186,010');
      expect(query(mount.container, 'hover-time-datum-reset')?.title).toContain('12');
      act(() => query(mount.container, 'hover-scatter-select-a')!.click());
      act(() => query(mount.container, 'hover-time-select-reset')!.click());
      expect(query(mount.container, 'hover-scatter-readout')?.textContent).toContain('4.2M');
      expect(query(mount.container, 'hover-time-readout')?.textContent).toContain('Weekly');
    } finally { mount.unmount(); }
  });
  it('names a caller-chosen scatter point beside its mark and draws a supplied reference value at its exact position', () => {
    const mount = mountThroughReactNativeWeb(<OutcomeScatter theme={SURFACE_CONTEXT_THEME_FIXTURE} testID="scatter" label="Runs"
      xLabel="Cost" yLabel="Merged" geometry={{ width: 500, height: 320 }}
      xGuides={[{ id: 'median', value: 25, label: 'Median run' }, { id: 'outside', value: 400, label: 'Beyond the plot' }]}
      legend={[{ id: 'own', label: 'Own agent', color: 'black' }, { id: 'other', label: 'Other agents', color: 'gray' }]}
      points={[{ id: 'a', label: 'Cheap run', x: 0, y: 0 }, { id: 'b', label: 'Costly run', x: 100, y: 2, labelled: true }]} />);
    try {
      expect(query(mount.container, 'scatter-label-b')!.textContent).toBe('Costly run');
      expect(query(mount.container, 'scatter-label-a')).toBeNull();
      expect(query(mount.container, 'scatter-guide-median')!.style.left).toBe('25%');
      // A value outside the plotted domain has no position; it is still stated in words.
      expect(query(mount.container, 'scatter-guide-outside')).toBeNull();
      expect(query(mount.container, 'scatter-legend')!.textContent).toBe('Own agentOther agents');
      expect(query(mount.container, 'scatter-guides')!.textContent).toContain('Median run: 25');
      expect(query(mount.container, 'scatter-guides')!.textContent).toContain('Beyond the plot: 400');
    } finally { mount.unmount(); }
  });
  it('exposes point events as one exact moment and retains focus selection at compact sizes', async () => {
    const render = (size: 'full' | 'tile') => <IntervalTimeline theme={SURFACE_CONTEXT_THEME_FIXTURE} testID="events"
      label="Delivery" startLabel="When" domain={{ start: 0, end: 24 }} geometry={{ width: 500, height: 160 }} size={size}
      intervals={[{ id: 'arrives', label: 'Shipment', kind: 'point', start: 12, end: 12, annotation: 'Dock 2' }]} />;
    const mount = mountThroughReactNativeWeb(render('full'));
    try {
      act(() => query(mount.container, 'events-values-toggle')!.click());
      expect(query(mount.container, 'events-values-row-0')!.getAttribute('aria-label')).not.toContain('End');
      expect(query(mount.container, 'events-end-arrives')).toBeNull();
      act(() => query(mount.container, 'events-select-arrives')!.click());
      expect(query(mount.container, 'events-readout')!.textContent).toContain('When: 12');
      await mount.render(render('tile'));
      expect(query(mount.container, 'events-values-row-0')!.textContent).toContain('Dock 2');
      expect(query(mount.container, 'events-readout')!.textContent).toContain('Shipment');
    } finally { mount.unmount(); }
  });
  it('retains exact endpoint facts when a consumer supplies abbreviated visible labels', () => {
    const mount = mountThroughReactNativeWeb(<IntervalTimeline theme={SURFACE_CONTEXT_THEME_FIXTURE} testID="labels"
      label="Laboratory observation" domain={{ start: 0, end: 24 }} geometry={{ width: 390, height: 160 }}
      intervals={[{ id: 'known', label: 'Observation', start: 12.3456789, end: 13.000000001, startLabel: 'Morning', endLabel: 'Noon' },
        { id: 'unknown', label: 'Incomplete', start: 1, end: null, endLabel: 'Not observed' }]} />);
    try {
      act(() => query(mount.container, 'labels-values-toggle')!.click());
      const known = query(mount.container, 'labels-values-row-0')!;
      expect(known.textContent).toContain('Morning');
      expect(known.textContent).toContain('12.3456789');
      expect(known.textContent).toContain('13.000000001');
      expect(known.getAttribute('aria-label')).toContain('12.3456789');
      expect(known.getAttribute('aria-label')).toContain('13.000000001');
      expect(query(mount.container, 'labels-values-row-1')!.getAttribute('aria-label')).toContain('Unknown');
      act(() => query(mount.container, 'labels-select-known')!.click());
      expect(query(mount.container, 'labels-readout')!.textContent).toContain('12.3456789');
      expect(query(mount.container, 'labels-readout')!.textContent).toContain('13.000000001');
    } finally { mount.unmount(); }
  });

  it('states a time domain exactly through the consumer formatter, on the axis, rows and readout', () => {
    const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const mount = mountThroughReactNativeWeb(<IntervalTimeline theme={SURFACE_CONTEXT_THEME_FIXTURE} testID="clock"
      label="Runs today" domain={{ start: 0, end: 1440 }} geometry={{ width: 500, height: 200 }} formatValue={clock}
      intervals={[{ id: 'run', label: 'Nightly audit', start: 120, end: 160 }]} />);
    try {
      // The plot already lists every run; its exact rows wait behind Details instead of repeating it.
      expect(query(mount.container, 'clock-values-row-0')).toBeNull();
      act(() => query(mount.container, 'clock-values-toggle')!.click());
      const row = query(mount.container, 'clock-values-row-0')!;
      expect(row.getAttribute('aria-label')).toContain('Start: 02:00, End: 02:40');
      expect(row.textContent).not.toContain('120');
      expect(query(mount.container, 'clock-plot')!.textContent).toContain('24:00');
      act(() => query(mount.container, 'clock-select-run')!.click());
      expect(query(mount.container, 'clock-readout')!.textContent).toContain('02:40');
    } finally { mount.unmount(); }
  });

  it('packs a lanes timeline into the fewest tracks per lane, keeping one track per run and one shared axis', () => {
    const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:00`;
    const mount = mountThroughReactNativeWeb(<IntervalTimeline theme={SURFACE_CONTEXT_THEME_FIXTURE} testID="lanes"
      label="Runs today" layout="lanes" laneLabel="Machine" domain={{ start: 0, end: 600 }} geometry={{ width: 800, height: 400 }}
      formatValue={clock} ticks={[180, 360]}
      intervals={[
        { id: 'a1', label: 'Audit', lane: 'devbox', track: 'audit', start: 0, end: 100 },
        { id: 'a2', label: 'Audit · waiting', lane: 'devbox', track: 'audit', start: 100, end: 140, pattern: 'hatched' },
        { id: 'b', label: 'Refactor', lane: 'devbox', track: 'refactor', start: 200, end: 300 },
        { id: 'c', label: 'Docs', lane: 'devbox', track: 'docs', start: 250, end: 400 },
        { id: 'd', label: 'Probe', lane: 'laptop', track: 'probe', start: 50, end: 60 },
      ]} />);
    try {
      // Two machines, each named once; ten rows of one-run-per-line would be the failure.
      expect(query(mount.container, 'lanes-lane-0')!.textContent).toContain('devbox');
      expect(query(mount.container, 'lanes-lane-1')!.textContent).toContain('laptop');
      expect(query(mount.container, 'lanes-lane-2')).toBeNull();
      // Audit (and its wait) and Refactor do not overlap and share one track; Docs overlaps Refactor.
      expect(mount.container.querySelectorAll('[data-testid^="lanes-lane-0-track-"]')).toHaveLength(2);
      expect(query(mount.container, 'lanes-lane-0-track-0')!.querySelector('[data-testid="lanes-interval-a2"]')).not.toBeNull();
      expect(query(mount.container, 'lanes-lane-0-track-0')!.querySelector('[data-testid="lanes-interval-b"]')).not.toBeNull();
      expect(query(mount.container, 'lanes-lane-0-track-1')!.querySelector('[data-testid="lanes-interval-c"]')).not.toBeNull();
      expect(mount.container.querySelectorAll('[data-testid^="lanes-lane-1-track-"]')).toHaveLength(1);
      expect(query(mount.container, 'lanes-axis')!.textContent).toBe('00:0003:0006:0010:00');
      act(() => query(mount.container, 'lanes-select-c')!.click());
      expect(query(mount.container, 'lanes-readout')!.textContent).toContain('Docs');
      act(() => query(mount.container, 'lanes-values-toggle')!.click());
      expect(query(mount.container, 'lanes-values-row-4')!.textContent).toContain('laptop');
    } finally { mount.unmount(); }
  });

  it.each(['ios', 'android', 'web'] as const)('%s lanes keep the dense drawing: one track per line on touch, a target per run on web', platform => {
    const intervals = [
      { id: 'a', label: 'Run A', lane: 'devbox', start: 1, end: 7 },
      { id: 'b', label: 'Run B', lane: 'devbox', start: 2, end: 8 },
      { id: 'c', label: 'Run C', lane: 'devbox', start: 7.4, end: 9 },
    ];
    const mount = mountThroughReactNativeWeb(<HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>
      <IntervalTimeline theme={SURFACE_CONTEXT_THEME_FIXTURE} testID="touch" label="Parallel work" layout="lanes"
        domain={{ start: 0, end: 10 }} geometry={{ width: 390, height: 400 }} intervals={intervals} />
    </HappierUiPlatformProvider>);
    try {
      // Packing stays by drawn marks on every platform: A and C share a track, B overlaps A.
      const tracks = [...mount.container.querySelectorAll<HTMLElement>('[data-testid^="touch-lane-0-track-"]')];
      expect(tracks).toHaveLength(2);
      const trackHeight = Number.parseFloat(getComputedStyle(tracks[0]!).height);
      const parent = getComputedStyle(tracks[0]!.parentElement!);
      const gap = Number.parseFloat(parent.rowGap || parent.gap) || 0;
      const bar = query(mount.container, 'touch-interval-a')!;
      const barHeight = Number.parseFloat(getComputedStyle(bar).height);
      const barTop = Number.parseFloat(getComputedStyle(bar).top) || 0;
      if (platform === 'web') {
        // A precise pointer keeps the dense track and a target per run: no touch floor is invented on web.
        const target = query(mount.container, 'touch-select-a')!;
        expect(Number.parseFloat(getComputedStyle(target).minHeight) || 0).toBe(0);
        expect(trackHeight + gap).toBeLessThan(24);
        expect(tracks[0]!.contains(target)).toBe(true);
      } else {
        // The whole track is the one press target (press and drag along it); runs never overlap targets.
        expect(query(mount.container, 'touch-select-a')).toBeNull();
        // A touch target is a hit area: the track keeps the dense bar's height and gap, never the finger's.
        expect(trackHeight).toBe(10);
        expect(trackHeight + gap).toBeLessThan(24);
        expect(tracks[0]!.getAttribute('role')).toBe('slider');
        expect(tracks[0]!.getAttribute('aria-label')).toContain('devbox');
        expect(barHeight).toBe(10);
      }
      expect(barTop + barHeight).toBeLessThanOrEqual(trackHeight);
      expect(Number.parseFloat(bar.style.left)).toBeCloseTo(10);
      expect(Number.parseFloat(bar.style.width)).toBeCloseTo(60);
    } finally { mount.unmount(); }
  });

  it('picks the run nearest the finger along a track and steps through runs for assistive technology', () => {
    const track = [
      { id: 'a', label: 'A', start: 1, end: 3 },
      { id: 'wait', label: 'Wait', start: 3, end: 4, pattern: 'hatched' as const },
      { id: 'c', label: 'C', start: 6, end: 9 },
    ];
    const domain = { start: 0, end: 10 };
    // Inside a run selects it; between runs the nearer edge wins; a wait is part of the line, not a stop.
    expect(selectIntervalTrackRun(track, domain, 0.2)).toBe('a');
    expect(selectIntervalTrackRun(track, domain, 0.52)).toBe('c');
    expect(selectIntervalTrackRun(track, domain, 0.44)).toBe('a');
    expect(stepIntervalTrackRun(track, null, 1)).toBe('a');
    expect(stepIntervalTrackRun(track, 'a', 1)).toBe('c');
    expect(stepIntervalTrackRun(track, 'c', 1)).toBe('c');
    expect(stepIntervalTrackRun(track, 'c', -1)).toBe('a');
  });

  it.each(['rows', 'lanes'] as const)('%s draw the witnessed part of a span crossing either or both domain boundaries', layout => {
    const mount = mountThroughReactNativeWeb(<IntervalTimeline theme={SURFACE_CONTEXT_THEME_FIXTURE} testID="clip" label="Work"
      layout={layout} domain={{ start: 0, end: 10 }} geometry={{ width: 800, height: 600 }}
      intervals={[
        { id: 'overnight', label: 'Night run', lane: 'devbox', start: -2, end: 5 },
        { id: 'late', label: 'Late run', lane: 'devbox', start: 6, end: 14 },
        { id: 'all-day', label: 'All-day run', lane: 'laptop', start: -1, end: 11 },
        { id: 'outside', label: 'Yesterday', lane: 'laptop', start: -5, end: -2 },
        { id: 'open-before', label: 'Open since yesterday', lane: 'laptop', start: -3, end: null },
        { id: 'reverse', label: 'Invalid observation', lane: 'laptop', start: 7, end: 3 },
      ]} />);
    try {
      const span = (id: string) => {
        const bar = query(mount.container, `clip-interval-${id}`);
        return bar ? [Number.parseFloat(bar.style.left || '0'), Number.parseFloat(bar.style.width)] : null;
      };
      expect(span('overnight')).toEqual([0, 50]);
      expect(span('late')![0]).toBeCloseTo(60);
      expect(span('late')![1]).toBeCloseTo(40);
      expect(span('all-day')).toEqual([0, 100]);
      // Nothing witnessed inside the domain: no mark, while the exact rows keep every value.
      expect(query(mount.container, 'clip-interval-outside')).toBeNull();
      expect(query(mount.container, 'clip-interval-open-before')).toBeNull();
      act(() => query(mount.container, 'clip-values-toggle')!.click());
      expect(query(mount.container, 'clip-values-row-0')!.getAttribute('aria-label')).toContain('-2');
      expect(query(mount.container, 'clip-values-row-4')!.getAttribute('aria-label')).toContain('Unknown');
      expect(query(mount.container, 'clip-values-row-5')!.getAttribute('aria-label')).toContain('Start: 7, End: 3');
    } finally { mount.unmount(); }
  });

  it('preserves every interval boundary, draws only witnessed spans and retains selection on resize', async () => {
    const theme = SURFACE_CONTEXT_THEME_FIXTURE;
    const intervals = [
      { id: 'chill', label: 'Chilling', start: -10, end: 0 },
      { id: 'open', label: 'Fermenting', start: 0, end: null, annotation: 'End not observed' },
      { id: 'reverse', label: 'Invalid observation', start: 15, end: 5 },
      { id: 'unknown', label: 'No temperature record', start: null, end: null },
    ];
    const render = (width: number, size: 'full' | 'tile' = 'full') => <IntervalTimeline testID="batches" theme={theme}
      label="Brewing batches" intervals={intervals} domain={{ start: -10, end: 20 }} basis="Hours from inoculation"
      size={size} geometry={{ width, height: 200 }} />;
    const mount = mountThroughReactNativeWeb(render(500));
    try {
      act(() => query(mount.container, 'batches-values-toggle')!.click());
      expect(query(mount.container, 'batches-values-row-0')).not.toBeNull();
      expect(query(mount.container, 'batches-values-row-0')!.getAttribute('aria-label')).toContain('Start: -10, End: 0');
      expect(query(mount.container, 'batches-values-row-1')!.getAttribute('aria-label')).toContain('End: Unknown');
      expect(query(mount.container, 'batches-values-row-2')!.getAttribute('aria-label')).toContain('Start: 15, End: 5');
      expect(query(mount.container, 'batches-interval-chill')).not.toBeNull();
      expect(Number.parseFloat(query(mount.container, 'batches-interval-chill')!.style.width)).toBeCloseTo(100 / 3);
      expect(query(mount.container, 'batches-interval-open')).toBeNull();
      expect(query(mount.container, 'batches-start-open')).not.toBeNull();
      expect(query(mount.container, 'batches-interval-reverse')).toBeNull();
      act(() => query(mount.container, 'batches-select-open')!.click());
      expect(query(mount.container, 'batches-readout')!.textContent).toContain('Fermenting');
      await mount.render(render(320));
      expect(query(mount.container, 'batches-readout')!.textContent).toContain('End: Unknown');
      await mount.render(render(150, 'tile'));
      expect(query(mount.container, 'batches-plot')).toBeNull();
      expect(mount.container.querySelectorAll('[data-testid^="batches-values-row-"]')).toHaveLength(4);
      await mount.render(render(Infinity));
      expect(query(mount.container, 'batches-plot')).toBeNull();
    } finally { mount.unmount(); }
  });

  it('plots signed, zero and extreme finite coordinates and exposes missing coordinates without inventing a point', async () => {
    const theme = SURFACE_CONTEXT_THEME_FIXTURE;
    const points = [
      { id: 'min', label: 'Low', x: -Number.MAX_VALUE, y: -Number.MAX_VALUE },
      { id: 'zero', label: 'Origin', x: 0, y: 0 },
      { id: 'max', label: 'High', x: Number.MAX_VALUE, y: Number.MAX_VALUE },
      { id: 'missing', label: 'Unmeasured', x: null, y: 0 },
    ];
    const render = (width: number, size: 'full' | 'inline' = 'full') => <OutcomeScatter testID="laboratory" theme={theme}
      label="Material samples" points={points} xLabel="Charge" yLabel="Deflection" basis="Observed measurements"
      size={size} geometry={{ width, height: 180 }} />;
    const mount = mountThroughReactNativeWeb(render(500));
    try {
      expect(query(mount.container, 'laboratory-values-row-3')).not.toBeNull();
      expect(query(mount.container, 'laboratory-values-row-3')!.getAttribute('aria-label')).toContain('Charge: Unknown, Deflection: 0');
      expect(query(mount.container, 'laboratory-point-missing')).toBeNull();
      for (const id of ['min', 'zero', 'max']) {
        const point = query(mount.container, `laboratory-point-${id}`)!;
        expect(point).not.toBeNull();
        expect(point.style.left).not.toMatch(/NaN|Infinity/u);
        expect(point.style.top).not.toMatch(/NaN|Infinity/u);
      }
      expect(query(mount.container, 'laboratory-point-min')!.style.left).toBe('0%');
      expect(query(mount.container, 'laboratory-point-zero')!.style.left).toBe('50%');
      expect(query(mount.container, 'laboratory-point-max')!.style.left).toBe('100%');
      const origin = query(mount.container, 'laboratory-select-zero')!;
      act(() => {
        origin.focus();
        origin.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        origin.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      });
      expect(document.activeElement).toBe(origin);
      expect(query(mount.container, 'laboratory-readout')!.textContent).toContain('Charge: 0');
      await mount.render(render(390));
      expect(query(mount.container, 'laboratory-readout')!.textContent).toContain('Origin');
      await mount.render(render(150, 'inline'));
      expect(query(mount.container, 'laboratory-plot')).toBeNull();
      expect(mount.container.querySelectorAll('[data-testid^="laboratory-values-row-"]')).toHaveLength(4);
      await mount.render(render(Infinity));
      expect(query(mount.container, 'laboratory-plot')).toBeNull();
    } finally { mount.unmount(); }
  });

  it('keeps outside-domain and nonfinite observations in the exact list and never gives them a plotted coordinate', () => {
    const theme = SURFACE_CONTEXT_THEME_FIXTURE;
    const mount = mountThroughReactNativeWeb(<OutcomeScatter theme={theme} testID="readings" label="Pressure readings"
      xLabel="Time" yLabel="Pressure" xDomain={[0, 1]} yDomain={[0, 1]}
      points={[{ id: 'outside', label: 'Outside', x: -1, y: 0 }, { id: 'invalid', label: 'Unavailable', x: 0, y: Number.NaN }]}
      geometry={{ width: 500, height: 180 }} />);
    try {
      expect(query(mount.container, 'readings-values-row-0')).not.toBeNull();
      expect(query(mount.container, 'readings-values-row-0')!.getAttribute('aria-label')).toContain('Time: -1');
      expect(query(mount.container, 'readings-values-row-1')!.getAttribute('aria-label')).toContain('Pressure: Unknown');
      expect(query(mount.container, 'readings-point-outside')).toBeNull();
      expect(query(mount.container, 'readings-point-invalid')).toBeNull();
    } finally { mount.unmount(); }
  });

  it('keeps coincident observations exact without overlapping touch controls, and retires a removed selection', async () => {
    const theme = SURFACE_CONTEXT_THEME_FIXTURE;
    const points = [{ id: 'first', label: 'First sample', x: 0, y: 0 }, { id: 'second', label: 'Second sample', x: 0, y: 0 },
      { id: 'isolated', label: 'Third sample', x: 1, y: 1 }];
    const render = (samples: typeof points) => <OutcomeScatter theme={theme} label="Samples" testID="coincident"
      xLabel="Voltage" yLabel="Current" points={samples} geometry={{ width: 390, height: 180 }} />;
    const mount = mountThroughReactNativeWeb(render(points));
    try {
      expect(query(mount.container, 'coincident-point-first')).not.toBeNull();
      expect(query(mount.container, 'coincident-point-second')).not.toBeNull();
      expect(query(mount.container, 'coincident-select-first')).toBeNull();
      expect(query(mount.container, 'coincident-select-second')).toBeNull();
      expect(mount.container.querySelectorAll('[data-testid^="coincident-values-row-"]')).toHaveLength(3);
      act(() => query(mount.container, 'coincident-select-isolated')!.click());
      expect(query(mount.container, 'coincident-readout')!.textContent).toContain('Third sample');
      await mount.render(render(points.slice(0, 2)));
      expect(query(mount.container, 'coincident-readout')).toBeNull();
      expect(query(mount.container, 'coincident-point-first')!.style.left).toBe('50%');
      expect(query(mount.container, 'coincident-point-first')!.style.top).toBe('50%');
      await mount.render(render([]));
      expect(query(mount.container, 'coincident-plot')).toBeNull();
      expect(mount.container.querySelectorAll('[role="listitem"]')).toHaveLength(0);
    } finally { mount.unmount(); }
  });
});
