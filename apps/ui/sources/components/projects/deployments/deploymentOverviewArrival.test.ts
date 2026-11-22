import { describe, expect, it } from 'vitest';

import { deploymentOverviewArrival } from './deploymentOverviewArrival';

type Read = 'loading' | 'ready' | 'unavailable';
const READS: readonly Read[] = ['loading', 'ready', 'unavailable'];

// PAGE-ACCEPT-176 R12-D3: the deployed Overview moved on arrival (CLS 0.40 desktop, 0.61 phone) because agent actions
// jumped slots when deploy availability settled, and the latest Receipt and history reads inserted sections above
// content already painted. Nothing may move on arrival: slots are fixed, later reads only append below.
describe('deploymentOverviewArrival', () => {
  it('keeps agent actions in one slot across every read state: primary before anything serves, secondary after', () => {
    for (const receipt of READS) for (const history of READS) {
      expect(deploymentOverviewArrival({ deployed: false, receipt, history }).agentActions).toBe('primary');
      expect(deploymentOverviewArrival({ deployed: true, receipt, history }).agentActions).toBe('secondary');
    }
  });

  it('paints nothing below the definition until the latest Receipt settles, so the deployed definition never inserts', () => {
    expect(deploymentOverviewArrival({ deployed: true, receipt: 'loading', history: 'ready' })).toMatchObject({ body: 'held', tail: 'held' });
    for (const receipt of ['ready', 'unavailable'] as const) {
      expect(deploymentOverviewArrival({ deployed: true, receipt, history: 'ready' })).toMatchObject({ body: 'shown', tail: 'shown' });
    }
    // Never deployed: no Receipt to wait for.
    expect(deploymentOverviewArrival({ deployed: false, receipt: 'loading', history: 'ready' }).body).toBe('shown');
  });

  it('holds Recent activity and what follows it until history settles, then appends them', () => {
    for (const deployed of [false, true]) {
      expect(deploymentOverviewArrival({ deployed, receipt: 'ready', history: 'loading' })).toMatchObject({ body: 'shown', tail: 'held' });
      for (const history of ['ready', 'unavailable'] as const) {
        expect(deploymentOverviewArrival({ deployed, receipt: 'ready', history }).tail).toBe('shown');
      }
    }
  });
});
