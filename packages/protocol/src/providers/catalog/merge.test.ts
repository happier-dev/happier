import { describe, expect, it } from 'vitest';

import {
  ProviderCatalogLimitError,
  applyProviderCatalogRefreshV1,
  mergeProviderCatalogV1,
} from './merge.js';

describe('provider catalog merge', () => {
  it('keeps verified static facts, permits only manual name overrides, and orders sources deterministically', () => {
    const snapshot = applyProviderCatalogRefreshV1(null, {
      status: 'success', observedAt: 20,
      models: [
        { id: 'probe-z', name: 'Zulu' },
        { id: 'static-a', name: 'Probe must not override' },
        { id: 'probe-a', name: 'alpha' },
        { id: 'Case', name: 'Uppercase exact id' },
        { id: 'case', name: 'Lowercase exact id' },
      ],
    });
    const merged = mergeProviderCatalogV1({
      staticModels: [
        { id: 'static-b', name: 'Static B' },
        { id: 'static-a', name: 'Static A', capabilities: { toolRoundTrips: 'unsupported' } },
      ],
      manualModels: [
        { id: 'manual-late', name: 'Manual Late', addedAt: 9 },
        { id: 'static-a', name: 'My Static A', addedAt: 8 },
        { id: 'manual-early', addedAt: 1 },
      ],
      probeSnapshot: snapshot.snapshot,
      staleProbeModels: snapshot.disappearedModels,
    });
    expect(merged.rows.map((row) => row.descriptor.id)).toEqual([
      'static-b', 'static-a', 'manual-early', 'manual-late', 'probe-a', 'case', 'Case', 'probe-z',
    ]);
    expect(merged.rows.find((row) => row.descriptor.id === 'static-a')?.descriptor).toMatchObject({
      name: 'My Static A', capabilities: { toolRoundTrips: 'unsupported' },
    });
    expect(merged.rows.find((row) => row.descriptor.id === 'static-a')?.sources).toEqual({
      manual: true, static: true, probe: true,
    });
  });

  it('retains the last successful snapshot as stale after a failed refresh', () => {
    const success = applyProviderCatalogRefreshV1(null, {
      status: 'success', observedAt: 20, models: [{ id: 'model-a', name: 'A' }],
    });
    const failed = applyProviderCatalogRefreshV1(success.snapshot, { status: 'failed' });
    expect(failed.snapshot).toEqual({ ...success.snapshot, stale: true });
    expect(failed.disappearedModels).toEqual([]);
  });

  it('removes disappeared probe-only models from normal rows while retaining stale rendering data', () => {
    const previous = applyProviderCatalogRefreshV1(null, {
      status: 'success', observedAt: 20,
      models: [{ id: 'gone', name: 'Gone' }, { id: 'kept', name: 'Kept' }],
    });
    const refreshed = applyProviderCatalogRefreshV1(previous.snapshot, {
      status: 'success', observedAt: 30, models: [{ id: 'kept', name: 'Kept' }],
    });
    const merged = mergeProviderCatalogV1({
      staticModels: [], manualModels: [], probeSnapshot: refreshed.snapshot,
      staleProbeModels: refreshed.disappearedModels,
    });
    expect(merged.rows.map((row) => row.descriptor.id)).toEqual(['kept']);
    expect(merged.staleRows.find((row) => row.descriptor.id === 'gone')).toMatchObject({
      descriptor: { id: 'gone' }, stale: true,
    });
  });

  it('rejects over-limit unions atomically rather than truncating identity', () => {
    expect(() => mergeProviderCatalogV1({
      staticModels: [],
      manualModels: Array.from({ length: 5_001 }, (_, index) => ({ id: `m-${index}`, addedAt: index })),
      probeSnapshot: null,
      staleProbeModels: [],
    })).toThrow(ProviderCatalogLimitError);
  });

  it('retains arbitrary vendor model ids that coincide with object prototype keys', () => {
    const merged = mergeProviderCatalogV1({
      staticModels: [], manualModels: [], probeSnapshot: null,
      staleProbeModels: [{ id: '__proto__', name: 'Vendor prototype model' }],
    });
    expect(merged.staleRows.map((row) => row.descriptor.id)).toEqual(['__proto__']);
  });

  it('rejects every over-bound source before reading any model element', () => {
    const throwingModels = (length: number) => {
      const models = Array.from({ length }, (_, index) => ({ id: `m-${index}` }));
      Object.defineProperty(models, 0, { get: () => { throw new Error('element must not be read'); } });
      return models;
    };
    const throwingManualModels = (length: number) => {
      const models = Array.from({ length }, (_, index) => ({ id: `m-${index}`, addedAt: index }));
      Object.defineProperty(models, 0, { get: () => { throw new Error('element must not be read'); } });
      return models;
    };
    const cases = [
      { staticModels: throwingModels(5_001), manualModels: [], probeSnapshot: null, staleProbeModels: [] },
      { staticModels: [], manualModels: throwingManualModels(501), probeSnapshot: null, staleProbeModels: [] },
      { staticModels: [], manualModels: [], probeSnapshot: { models: throwingModels(5_001), observedAt: 1, stale: false }, staleProbeModels: [] },
      { staticModels: [], manualModels: [], probeSnapshot: null, staleProbeModels: throwingModels(5_001) },
    ];
    for (const input of cases) {
      expect(() => mergeProviderCatalogV1(input)).toThrowError(ProviderCatalogLimitError);
    }
    expect(() => applyProviderCatalogRefreshV1({
      models: throwingModels(5_001), observedAt: 1, stale: false,
    }, { status: 'failed' })).toThrowError(ProviderCatalogLimitError);
  });

  it('bounds active and immediately-prior stale rows independently', () => {
    const merged = mergeProviderCatalogV1({
      staticModels: Array.from({ length: 5_000 }, (_, index) => ({ id: `active-${index}`, name: `Active ${index}` })),
      manualModels: [], probeSnapshot: null,
      staleProbeModels: Array.from({ length: 5_000 }, (_, index) => ({ id: `stale-${index}` })),
    });
    expect(merged.rows).toHaveLength(5_000);
    expect(merged.staleRows).toHaveLength(5_000);
  });
});
