import { act, createElement, type ComponentType } from 'react';
import { describe, expect, it } from 'vitest';

import * as Presentation from '@happier-dev/plugin-ui/presentation';
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
});
