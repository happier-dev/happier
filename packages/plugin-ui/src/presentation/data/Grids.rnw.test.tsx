import { act, createElement, type ComponentType } from 'react';
import { describe, expect, it } from 'vitest';

import * as Presentation from '@happier-dev/plugin-ui/presentation';
import { resolveVisibleAxisLabels } from './Heatmap.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';

const cells = [
  { id: 'red-zero', row: 'red', column: 'one', label: 'Red sample, first trial', value: 0 },
  { id: 'red-unknown', row: 'red', column: 'two', label: 'Red sample, second trial', value: null },
  { id: 'blue-result', row: 'blue', column: 'one', label: 'Blue sample, first trial', value: 37, valueLabel: '37 milligrams' },
];
const props = {
  theme: createSurfaceContext().theme,
  label: 'Lab results',
  rows: [{ id: 'red', label: 'Red' }, { id: 'blue', label: 'Blue' }],
  columns: [{ id: 'one', label: 'First' }, { id: 'two', label: 'Second' }],
  cells,
  unknownLabel: 'Unknown',
  testID: 'samples',
};

describe('neutral public grids', () => {
  for (const name of ['Heatmap', 'DotGrid'] as const) {
    it(`${name} reads every exact value and retains the selected cell across size changes`, async () => {
      const candidate: unknown = Reflect.get(Presentation, name);
      expect(typeof candidate).toBe('function');
      if (typeof candidate !== 'function') throw new Error(`Missing public ${name} renderer`);
      const Grid = candidate as ComponentType<typeof props & { size?: 'inline' | 'tile' | 'full'; order?: 'rows' | 'columns' }>;
      const mount = mountThroughReactNativeWeb(createElement(Grid, props));
      try {
        const query = (id: string) => mount.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
        expect(query('samples-cell-red-zero').getAttribute('aria-label')).toContain('0');
        expect(query('samples-cell-red-unknown').getAttribute('aria-label')).toContain('Unknown');
        const selected = query('samples-cell-blue-result');
        act(() => selected.click());
        expect(query('samples-readout').textContent).toContain('37 milligrams');
        await mount.render(createElement(Grid, { ...props, size: 'tile', cells: [...cells].reverse() }));
        expect(query('samples-readout').textContent).toContain('37 milligrams');
        expect(query('samples-cell-blue-result')).toBe(selected);
        act(() => query('samples-cell-red-zero').focus());
        expect(query('samples-readout').textContent).toContain('0');
        expect(mount.container.querySelectorAll('[role="button"]')).toHaveLength(3);
        await mount.render(createElement(Grid, { ...props, cells: cells.map(cell => cell.id === 'red-zero' ? { ...cell, value: 0.00000000123, valueLabel: 'Trace' } : cell.id === 'red-unknown' ? { ...cell, value: Number.NaN } : cell) }));
        expect(query('samples-cell-red-zero').getAttribute('aria-label')).toContain('0.00000000123');
        expect(query('samples-cell-red-unknown').getAttribute('aria-label')).toContain('Unknown');
        expect(query('samples-readout').textContent).toContain('Trace');
        await mount.render(createElement(Grid, { ...props, order: 'rows' }));
        expect([...mount.container.querySelectorAll('[role="button"]')].map(control => control.getAttribute('data-testid')))
          .toEqual(['samples-cell-red-zero', 'samples-cell-red-unknown', 'samples-cell-blue-result']);
      } finally { mount.unmount(); }
    });
  }

  it('DotGrid sets each hour label in its own column so a tick names the column it sits over', () => {
    const columns = Array.from({ length: 24 }, (_, hour) => ({ id: `h${hour}`, label: hour % 6 === 0 ? `${hour}h` : '' }));
    const mount = mountThroughReactNativeWeb(createElement(Presentation.DotGrid, { ...props, rows: [{ id: 'mon', label: 'Mon' }], columns,
      cells: columns.map((column, hour) => ({ id: column.id, row: 'mon', column: column.id, label: column.id, value: hour })) }));
    try {
      const axis = (hour: number) => mount.container.querySelector<HTMLElement>(`[data-testid="samples-axis-h${hour}"]`)!;
      expect(axis(6).textContent).toBe('6h');
      expect(axis(18).textContent).toBe('18h');
      expect(axis(8).textContent).toBe('');
      expect(axis(6).parentElement!.children).toHaveLength(24);
    } finally { mount.unmount(); }
  });

  it('a strip names its columns on one line each, centred on the column and free to overflow its slot', () => {
    const columns = Array.from({ length: 30 }, (_, day) => ({ id: `d${day}`, label: day % 7 === 0 ? String(day + 10) : '' }));
    const mount = mountThroughReactNativeWeb(createElement(Presentation.Heatmap, { ...props, layout: 'strip', rows: [{ id: 'days', label: '' }], columns,
      cells: columns.map((column, day) => ({ id: column.id, row: 'days', column: column.id, label: column.id, value: day })) }));
    try {
      const axis = (day: number) => mount.container.querySelector<HTMLElement>(`[data-testid="samples-axis-d${day}"]`)!;
      expect(axis(7).textContent).toBe('17');
      expect(axis(8).textContent).toBe('');
      expect(axis(7).parentElement!.children).toHaveLength(30);
      // A two-digit label in a 13 px column must not wrap one digit per line: the label is a nowrap run.
      const label = [...axis(7).querySelectorAll<HTMLElement>('div')].find((element) => element.children.length === 0 && element.textContent === '17')!;
      const style = getComputedStyle(label);
      expect(style.whiteSpace).toBe('nowrap');
      expect(style.textOverflow).toBe('ellipsis');
      expect(style.textAlign).toBe('center');
    } finally { mount.unmount(); }
  });
});

describe('resolveVisibleAxisLabels', () => {
  const labels = (count: number, every: number) => Array.from({ length: count }, (_, index) => (index % every === 0 ? String(index + 10) : ''));
  it('keeps every label that fits beside its neighbour', () => {
    expect([...resolveVisibleAxisLabels({ labels: labels(30, 7), stride: 13, characterWidth: 6.6 })]).toEqual([0, 7, 14, 21, 28]);
  });
  it('thins to every n-th labelled column once slots are narrower than the labels', () => {
    // Labels every column, 8 px apart, ~14 px wide each: only every third label can be read.
    expect([...resolveVisibleAxisLabels({ labels: labels(12, 1), stride: 8, characterWidth: 6.6 })]).toEqual([0, 3, 6, 9]);
  });
  it('keeps everything while the width is unknown', () => {
    expect(resolveVisibleAxisLabels({ labels: labels(12, 1), stride: 0, characterWidth: 6.6 }).size).toBe(12);
  });
});
