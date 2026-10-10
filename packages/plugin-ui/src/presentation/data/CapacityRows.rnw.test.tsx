import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { CapacityBar } from './CapacityBar.js';
import { RankedRows } from './RankedRows.js';
import { CompositionStrip } from './CompositionStrip.js';
import { HappierDataRows } from './DataRows.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';

const presentation = { CapacityBar, RankedRows, CompositionStrip };
const createSurfaceContext = () => ({ theme: SURFACE_CONTEXT_THEME_FIXTURE });

describe('neutral capacity and ranked data through public presentation', () => {
  it('projects a remaining-axis meter without extending the solid remainder beyond current capacity', () => {
    const mount = mountThroughReactNativeWeb(<CapacityBar theme={createSurfaceContext().theme} label="Inventory left"
      value={40} capacity={100} evenPace={120} projected={60} projection="remaining" showCaption={false} testID="left" />);
    try {
      expect(mount.container.querySelector('[data-testid="left-projected-fill"]')).not.toBeNull();
      expect(mount.container.querySelector('[data-testid="left-projected-fill"]')?.getAttribute('style')).toContain('width: 40%');
      expect(mount.container.querySelector('[data-testid="left-even-pace"]')?.getAttribute('style')).toContain('left: 100%');
      expect(mount.container.querySelector('[data-testid="left"]')?.getAttribute('aria-label')).toContain('Projected: 60');
      expect(mount.container.textContent).toBe('');
    } finally { mount.unmount(); }
  });
  it('keeps a declared composition denominator instead of summing overlapping categories', () => {
    expect(presentation).toHaveProperty('CompositionStrip', expect.any(Function));
    const mount = mountThroughReactNativeWeb(<presentation.CompositionStrip theme={createSurfaceContext().theme}
      label="Materials" basis="kg" total={10} testID="composition"
      segments={[{ id: 'all', label: 'All metal', value: 10 }, { id: 'subset', label: 'Copper', value: 4 }]} />);
    try {
      expect(mount.container.querySelector('[data-testid="composition"]')?.getAttribute('aria-label')).toContain('10 kg');
      expect(mount.container.textContent).toContain('Copper');
      expect(mount.container.textContent).toContain('40%');
      expect(mount.container.textContent).not.toContain('29%');
    } finally { mount.unmount(); }
  });

  it('distinguishes unknown capacity from zero and keeps supplied pace and exact basis', () => {
    expect(presentation).toHaveProperty('CapacityBar', expect.any(Function));
    const theme = createSurfaceContext().theme;
    const known = mountThroughReactNativeWeb(<presentation.CapacityBar theme={theme} label="Warehouse"
      value={0} capacity={100} basis="pallets" evenPace={25} projected={12.3456789} testID="capacity" />);
    const unknown = mountThroughReactNativeWeb(<presentation.CapacityBar theme={theme} label="Warehouse"
      value={null} capacity={null} basis="pallets" unknownLabel="Unmeasured" testID="unknown" />);
    try {
      expect(known.container.textContent).toContain('0');
      expect(known.container.querySelector('[data-testid="capacity"]')?.getAttribute('aria-label')).toContain('12.3456789');
      expect(known.container.querySelector('[data-testid="capacity"]')?.getAttribute('aria-label')).toContain('25');
      expect(unknown.container.textContent).toContain('Unmeasured');
      expect(unknown.container.querySelector('[role="progressbar"]')).toBeNull();
    } finally { known.unmount(); unknown.unmount(); }
  });

  it('keeps every ranked row and exact decimal at compact sizes without inventing an unknown amount', () => {
    expect(presentation).toHaveProperty('RankedRows', expect.any(Function));
    const mount = mountThroughReactNativeWeb(<presentation.RankedRows theme={createSurfaceContext().theme}
      label="Water samples" basis="litres" unknownLabel="Unmeasured" size="inline" testID="ranked"
      rows={[{ id: 'a', label: 'Reservoir', value: 0.00000017 }, { id: 'b', label: 'Tank', value: 0 },
        { id: 'c', label: 'Well', value: null, annotation: 'Awaiting measurement' }]} />);
    try {
      expect(mount.container.querySelectorAll('[role="listitem"]')).toHaveLength(3);
      expect(mount.container.querySelector('[data-testid="ranked-row-0"]')?.getAttribute('aria-label')).toContain('0.00000017');
      expect(mount.container.querySelector('[data-testid="ranked-row-2"]')?.getAttribute('aria-label')).toContain('Unmeasured');
      expect(mount.container.querySelector('[data-testid="ranked-row-2"]')?.getAttribute('aria-label')).not.toContain('0%');
      expect(mount.container.querySelector('[data-testid="ranked-bar-2"]')).toBeNull();
    } finally { mount.unmount(); }
  });

  it('adapts a disjoint composition to a decorative waffle without losing exact category values', () => {
    const mount = mountThroughReactNativeWeb(<presentation.CompositionStrip theme={createSurfaceContext().theme}
      label="Minerals" total={10} variant="waffle" size="tile" testID="waffle"
      segments={[{ id: 'copper', label: 'Copper', value: 4 }, { id: 'tin', label: 'Tin', value: 6 }]} />);
    try {
      expect(mount.container.querySelector('[data-testid="waffle-grid"]')).not.toBeNull();
      expect(mount.container.querySelectorAll('[role="listitem"]')).toHaveLength(2);
      expect(mount.container.textContent).toContain('40%');
      expect(mount.container.querySelectorAll('[role="button"]')).toHaveLength(0);
    } finally { mount.unmount(); }
  });

  it('does not display a zero share for an unmeasured proportion in the canonical rows owner', () => {
    const mount = mountThroughReactNativeWeb(<HappierDataRows theme={createSurfaceContext().theme}
      label="Samples" testID="samples" columns={[{ label: 'Sample' }, { label: 'Amount', proportion: true }]}
      rows={[["Well", "Unmeasured"], ["Tank", 0]]} />);
    try {
      expect(mount.container.querySelector('[data-testid="samples-row-0"]')?.textContent).not.toContain('0%');
      expect(mount.container.querySelector('[data-testid="samples-row-1"]')?.textContent).toContain('0%');
    } finally { mount.unmount(); }
  });

  it('keeps exact accessible composition amounts when a host abbreviates its visible ink', () => {
    const mount = mountThroughReactNativeWeb(<CompositionStrip theme={createSurfaceContext().theme}
      label="Minerals" total={1} segments={[{ id: 'trace', label: 'Copper', value: 0.00000017 }]}
      valueFormatter={() => '0.17µ'} shareFormatter={share => share > 0 && share < 0.01 ? '<1%' : `${share * 100}%`} />);
    try {
      expect(mount.container.textContent).toContain('0.17µ');
      expect(mount.container.textContent).toContain('<1%');
      expect(mount.container.querySelector('[role="listitem"]')?.getAttribute('aria-label')).toContain('0.00000017');
    } finally { mount.unmount(); }
  });

  it('shares an exact legend without mounting plot controls when another chart owns the picture', () => {
    const input = { theme: createSurfaceContext().theme, label: 'Minerals', total: 10,
      segments: [{ id: 'copper', label: 'Copper', value: 4 }, { id: 'tin', label: 'Tin', value: 6 }],
      renderBarSegment: (segment: { label: string }, visual: ReactNode) => <button aria-label={`${segment.label} plot`}>{visual}</button>,
    };
    const strip = mountThroughReactNativeWeb(<CompositionStrip {...input} />);
    const legend = mountThroughReactNativeWeb(<CompositionStrip {...input} variant="legend" />);
    try {
      expect(strip.container.querySelectorAll('[role="button"], button')).toHaveLength(2);
      expect(legend.container.querySelectorAll('[role="button"], button')).toHaveLength(0);
      expect(legend.container.querySelectorAll('[role="listitem"]')).toHaveLength(2);
      expect(legend.container.querySelector('[role="listitem"]')?.getAttribute('aria-label')).toContain('40%');
      expect(legend.container.textContent).toContain('Copper');
      expect(legend.container.textContent).toContain('60%');
    } finally { strip.unmount(); legend.unmount(); }
  });
});
