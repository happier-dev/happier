import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { IntervalTimeline } from './IntervalTimeline.js';
import { OutcomeScatter } from './OutcomeScatter.js';

const query = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('neutral intervals and outcomes', () => {
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
      const row = query(mount.container, 'clock-values-row-0')!;
      expect(row.getAttribute('aria-label')).toContain('Start: 02:00, End: 02:40');
      expect(row.textContent).not.toContain('120');
      expect(query(mount.container, 'clock-plot')!.textContent).toContain('24:00');
      act(() => query(mount.container, 'clock-select-run')!.click());
      expect(query(mount.container, 'clock-readout')!.textContent).toContain('02:40');
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
