import { expect, it } from 'vitest';
import { BurnUpChart, StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';

it('renders an unrelated public author dataset with exact numerical semantics', () => {
  const mount = mountThroughReactNativeWeb(<StackedSeriesChart theme={theme} label="Rainfall" variant="bar" size="tile"
    series={[{ id: 'rainfall', label: 'Millimetres', points: [{ id: 'thu', x: 'Thu', y: 0.00004 }, { id: 'fri', x: 'Fri', y: null }] }]} />);
  try { expect(mount.container.querySelector('[aria-label*="Millimetres 0.00004"]')).not.toBeNull(); }
  finally { mount.unmount(); }
});

it('draws supplied observed, projected and target facts without calculating a forecast', () => {
  const mount = mountThroughReactNativeWeb(<BurnUpChart theme={theme} label="Water budget" width={180} size="tile"
    series={[
      { id: 'observed', label: 'Observed', points: [{ id: 'day1', x: 1, y: 10 }, { id: 'day2', x: 2, y: 16 }] },
      { id: 'projection', label: 'Projected', lineStyle: 'dashed', points: [{ id: 'day2', x: 2, y: 16 }, { id: 'day3', x: 3, y: 25 }] },
      { id: 'target', label: 'Target', lineStyle: 'dotted', points: [{ id: 'day1', x: 1, y: 25 }, { id: 'day2', x: 2, y: 25 }, { id: 'day3', x: 3, y: 25 }] },
    ]} />);
  try {
    expect(mount.container.querySelectorAll('svg path')).toHaveLength(3);
    expect(mount.container.querySelector('path[stroke-dasharray="4,4"]')).not.toBeNull();
    expect(mount.container.querySelector('[aria-label*="Projected 25"]')).not.toBeNull();
    expect(mount.container.querySelector('[aria-label*="Observed —"]')).not.toBeNull();
  } finally { mount.unmount(); }
});
