import { describe, expect, it } from 'vitest';

import { computeProviderBaselineV1, stableStringifyBaselineShapeEntry } from '../../src/testkit/providers/baselines';

describe('providers baselines', () => {
  it('prefers fixtures whose shapes include nested array contents', () => {
    const baseline = computeProviderBaselineV1({
      providerId: 'p1',
      scenarioId: 's1',
      fixtureKeys: ['k1'],
      fixturesExamples: {
        k1: [
          { payload: { a: 'x' } },
          { payload: { a: [{ x: 1 }] } },
        ],
      },
      nowIso: '2026-02-04T00:00:00.000Z',
    });

    expect(stableStringifyBaselineShapeEntry(baseline.shapesByKey.k1) ?? '').toContain('"t":"array"');
  });
});
