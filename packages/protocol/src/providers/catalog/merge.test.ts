import { describe, expect, it } from 'vitest';

import {
  ProviderCatalogLimitError,
  ProviderCatalogTransitionStateV1Schema,
  applyProviderCatalogRefreshV1,
  mergeProviderCatalogV1,
  resolveProviderCatalogReferenceV1,
} from './merge.js';

describe('provider catalog merge', () => {
  it('keeps verified static facts, permits only manual name overrides, and orders sources deterministically', () => {
    const state = applyProviderCatalogRefreshV1({ snapshot: null, staleProbeModels: [] }, {
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
      probeState: state,
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
    const success = applyProviderCatalogRefreshV1({ snapshot: null, staleProbeModels: [] }, {
      status: 'success', observedAt: 20, models: [{ id: 'model-a', name: 'A' }],
    });
    const failed = applyProviderCatalogRefreshV1(success, { status: 'failed', failedAt: 25 });
    expect(failed.snapshot).toEqual({ ...success.snapshot, stale: true, staleAt: 25 });
    expect(failed.staleProbeModels).toEqual([]);
  });

  it('keeps curated static rows when the first probe attempt fails', () => {
    const failed = applyProviderCatalogRefreshV1(
      { snapshot: null, staleProbeModels: [] },
      { status: 'failed', failedAt: 25 },
    );

    expect(mergeProviderCatalogV1({
      staticModels: [{ id: 'static-fallback', name: 'Static fallback' }],
      manualModels: [],
      probeState: failed,
    }).rows).toEqual([expect.objectContaining({
      descriptor: { id: 'static-fallback', name: 'Static fallback' },
      sources: { static: true, manual: false, probe: false },
      confidence: 'verified_static',
    })]);
  });

  it('projects probe capability evidence into the canonical model descriptor', () => {
    const state = applyProviderCatalogRefreshV1({ snapshot: null, staleProbeModels: [] }, {
      status: 'success',
      observedAt: 20,
      models: [{
        id: 'probe-model',
        contextWindowTokens: 1_000_000,
        modelOptions: [{
          id: 'reasoning_effort',
          name: 'Thinking',
          type: 'select',
          currentValue: 'high',
          options: [{ value: 'high', name: 'High' }],
        }],
        capabilities: {
          toolRoundTrips: 'supported',
          reasoningControls: 'unsupported',
        },
      }],
    });

    expect(mergeProviderCatalogV1({
      staticModels: [],
      manualModels: [],
      probeState: state,
    }).rows[0]?.descriptor).toEqual({
      id: 'probe-model',
      name: 'probe-model',
      contextWindowTokens: 1_000_000,
      modelOptions: [{
        id: 'reasoning_effort',
        name: 'Thinking',
        type: 'select',
        currentValue: 'high',
        options: [{ value: 'high', name: 'High' }],
      }],
      capabilities: {
        toolRoundTrips: 'supported',
        reasoningControls: 'unsupported',
      },
    });
  });

  it('keeps complete verified static descriptors authoritative over overlapping probe facts', () => {
    const merged = mergeProviderCatalogV1({
      staticModels: [{
        id: 'static-model',
        name: 'Verified static',
        contextWindowTokens: 200_000,
        modelOptions: [{
          id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'high',
          options: [{ value: 'high', name: 'High' }],
        }],
      }],
      manualModels: [],
      probeState: {
        snapshot: {
          observedAt: 20,
          stale: false,
          models: [{
            id: 'static-model',
            name: 'Unverified probe',
            contextWindowTokens: 1_000_000,
            modelOptions: [{
              id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'max',
              options: [{ value: 'max', name: 'Max' }],
            }],
          }],
        },
        staleProbeModels: [],
      },
    });

    expect(merged.rows[0]).toMatchObject({
      descriptor: {
        id: 'static-model',
        name: 'Verified static',
        contextWindowTokens: 200_000,
        modelOptions: [{ currentValue: 'high' }],
      },
      sources: { static: true, probe: true },
      confidence: 'verified_static',
    });
  });

  it('lets an authoritative probe snapshot own membership while exact static rows enrich presentation', () => {
    const merged = mergeProviderCatalogV1({
      staticModels: [
        {
          id: 'listed-by-probe',
          name: 'Curated name',
          description: 'Curated presentation',
          contextWindowTokens: 200_000,
          extendedContextModelId: 'listed-by-probe[1m]',
          modelOptions: [{
            id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
          }],
          capabilities: {
            toolRoundTrips: 'unsupported',
            reasoningControls: 'unsupported',
          },
        },
        { id: 'static-only', name: 'Cold fallback only' },
      ],
      manualModels: [{ id: 'manual-only', name: 'Manual', addedAt: 1 }],
      probeState: {
        snapshot: {
          observedAt: 20,
          stale: false,
          models: [{
            id: 'listed-by-probe',
            name: 'API name',
            contextWindowTokens: 1_000_000,
            modelOptions: [{
              id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'max',
              options: [{ value: 'max', name: 'Max' }],
            }],
            capabilities: {
              toolRoundTrips: 'supported',
              reasoningControls: 'supported',
            },
          }],
        },
        staleProbeModels: [],
      },
      membershipPolicy: 'probe-authoritative',
    });

    expect(merged.rows.map((row) => row.descriptor.id)).toEqual([
      'manual-only',
      'listed-by-probe',
    ]);
    expect(merged.rows.find((row) => row.descriptor.id === 'listed-by-probe')).toMatchObject({
      descriptor: {
        name: 'Curated name',
        description: 'Curated presentation',
        extendedContextModelId: 'listed-by-probe[1m]',
        contextWindowTokens: 1_000_000,
        modelOptions: [{ currentValue: 'max' }],
        capabilities: {
          toolRoundTrips: 'supported',
          reasoningControls: 'supported',
        },
      },
      sources: { manual: false, static: true, probe: true },
      confidence: 'probe',
    });
  });

  it('treats a successful empty authoritative snapshot as empty instead of static fallback', () => {
    const merged = mergeProviderCatalogV1({
      staticModels: [{ id: 'static-only', name: 'Cold fallback only' }],
      manualModels: [],
      probeState: {
        snapshot: { models: [], observedAt: 20, stale: false },
        staleProbeModels: [],
      },
      membershipPolicy: 'probe-authoritative',
    });

    expect(merged.rows).toEqual([]);
  });

  it('lets authoritative probe facts override static context, options, and capabilities', () => {
    const merged = mergeProviderCatalogV1({
      staticModels: [{
        id: 'same-id',
        name: 'Curated name',
        contextWindowTokens: 200_000,
        modelOptions: [{
          id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'high',
          options: [{ value: 'high', name: 'High' }],
        }],
        capabilities: {
          toolRoundTrips: 'unsupported',
          reasoningControls: 'unsupported',
        },
      }],
      manualModels: [],
      probeState: {
        snapshot: {
          observedAt: 20,
          stale: false,
          models: [{
            id: 'same-id',
            contextWindowTokens: 1_000_000,
            modelOptions: [{
              id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'max',
              options: [{ value: 'max', name: 'Max' }],
            }],
            capabilities: {
              toolRoundTrips: 'supported',
              reasoningControls: 'supported',
            },
          }],
        },
        staleProbeModels: [],
      },
      membershipPolicy: 'probe-authoritative',
    });

    expect(merged.rows[0]).toMatchObject({
      descriptor: {
        name: 'Curated name',
        contextWindowTokens: 1_000_000,
        modelOptions: [{ currentValue: 'max' }],
        capabilities: {
          toolRoundTrips: 'supported',
          reasoningControls: 'supported',
        },
      },
      sources: { manual: false, static: true, probe: true },
      confidence: 'probe',
    });
  });

  it('uses static rows as cold fallback before the first successful authoritative snapshot', () => {
    const failed = applyProviderCatalogRefreshV1(
      { snapshot: null, staleProbeModels: [] },
      { status: 'failed', failedAt: 25 },
    );

    expect(mergeProviderCatalogV1({
      staticModels: [{ id: 'static-fallback', name: 'Static fallback' }],
      manualModels: [],
      probeState: failed,
      membershipPolicy: 'probe-authoritative',
    }).rows).toEqual([expect.objectContaining({
      descriptor: { id: 'static-fallback', name: 'Static fallback' },
      sources: { static: true, manual: false, probe: false },
      confidence: 'verified_static',
    })]);
  });

  it('keeps a retained stale authoritative snapshot in control after a failed refresh', () => {
    const success = applyProviderCatalogRefreshV1(
      { snapshot: null, staleProbeModels: [] },
      { status: 'success', observedAt: 20, models: [{ id: 'probe-only', name: 'Probe only' }] },
    );
    const failed = applyProviderCatalogRefreshV1(success, { status: 'failed', failedAt: 25 });

    expect(mergeProviderCatalogV1({
      staticModels: [{ id: 'static-only', name: 'Cold fallback only' }],
      manualModels: [],
      probeState: failed,
      membershipPolicy: 'probe-authoritative',
    }).rows).toEqual([expect.objectContaining({
      descriptor: { id: 'probe-only', name: 'Probe only' },
      sources: { static: false, manual: false, probe: true },
      confidence: 'probe',
      catalogStale: true,
    })]);
  });

  it('marks wrapper-supported managed rows as account-unverified without changing source precedence', () => {
    const merged = mergeProviderCatalogV1({
      staticModels: [{ id: 'static-model', name: 'Static' }],
      manualModels: [],
      probeState: {
        snapshot: {
          models: [
            { id: 'static-model', name: 'Probe must not override' },
            { id: 'wrapper-model', name: 'Wrapper model' },
          ],
          observedAt: 20,
          stale: false,
        },
        staleProbeModels: [],
      },
      probeConfidence: 'account_unverified',
    });

    expect(merged.rows).toEqual([
      expect.objectContaining({
        descriptor: { id: 'static-model', name: 'Static' },
        confidence: 'verified_static',
      }),
      expect.objectContaining({
        descriptor: { id: 'wrapper-model', name: 'Wrapper model' },
        confidence: 'account_unverified',
      }),
    ]);
  });

  it('removes disappeared probe-only models from normal rows while retaining stale rendering data', () => {
    const previous = applyProviderCatalogRefreshV1({ snapshot: null, staleProbeModels: [] }, {
      status: 'success', observedAt: 20,
      models: [{ id: 'gone', name: 'Gone' }, { id: 'kept', name: 'Kept' }],
    });
    const refreshed = applyProviderCatalogRefreshV1(previous, {
      status: 'success', observedAt: 30, models: [{ id: 'kept', name: 'Kept' }],
    });
    const merged = mergeProviderCatalogV1({
      staticModels: [], manualModels: [], probeState: refreshed,
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
      probeState: { snapshot: null, staleProbeModels: [] },
    })).toThrow(ProviderCatalogLimitError);
  });

  it('preserves reserved-looking vendor model ids because catalog rows are not record keys', () => {
    const merged = mergeProviderCatalogV1({
      staticModels: [], manualModels: [], probeState: {
        snapshot: { models: [], observedAt: 2, stale: false },
        staleProbeModels: [{ id: '__proto__', name: 'Vendor prototype model' }],
      },
    });
    expect(merged.staleRows).toEqual([
      expect.objectContaining({ descriptor: { id: '__proto__', name: 'Vendor prototype model' } }),
    ]);
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
      { staticModels: throwingModels(5_001), manualModels: [], probeState: { snapshot: null, staleProbeModels: [] } },
      { staticModels: [], manualModels: throwingManualModels(501), probeState: { snapshot: null, staleProbeModels: [] } },
      { staticModels: [], manualModels: [], probeState: { snapshot: { models: throwingModels(5_001), observedAt: 1, stale: false }, staleProbeModels: [] } },
      { staticModels: [], manualModels: [], probeState: { snapshot: null, staleProbeModels: throwingModels(5_001) } },
    ];
    for (const input of cases) {
      expect(() => mergeProviderCatalogV1(input)).toThrowError(ProviderCatalogLimitError);
    }
    expect(() => applyProviderCatalogRefreshV1({
      snapshot: { models: throwingModels(5_001), observedAt: 1, stale: false }, staleProbeModels: [],
    }, { status: 'failed', failedAt: 2 })).toThrowError(ProviderCatalogLimitError);
  });

  it('bounds active and immediately-prior stale rows independently', () => {
    const merged = mergeProviderCatalogV1({
      staticModels: Array.from({ length: 5_000 }, (_, index) => ({ id: `active-${index}`, name: `Active ${index}` })),
      manualModels: [], probeState: {
        snapshot: { models: [], observedAt: 2, stale: false },
        staleProbeModels: Array.from({ length: 5_000 }, (_, index) => ({ id: `stale-${index}` })),
      },
    });
    expect(merged.rows).toHaveLength(5_000);
    expect(merged.staleRows).toHaveLength(5_000);
  });

  it('preserves exactly one disappeared set across failure and replaces it on the next success', () => {
    const first = applyProviderCatalogRefreshV1({ snapshot: null, staleProbeModels: [] }, {
      status: 'success', observedAt: 10,
      models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    });
    const omission = applyProviderCatalogRefreshV1(first, {
      status: 'success', observedAt: 20, models: [{ id: 'b', name: 'B' }],
    });
    expect(omission.staleProbeModels.map((model) => model.id)).toEqual(['a']);

    const failure = applyProviderCatalogRefreshV1(omission, { status: 'failed', failedAt: 25 });
    expect(failure.staleProbeModels.map((model) => model.id)).toEqual(['a']);
    expect(failure.snapshot).toMatchObject({ observedAt: 20, stale: true, staleAt: 25 });

    const next = applyProviderCatalogRefreshV1(failure, {
      status: 'success', observedAt: 30, models: [{ id: 'c', name: 'C' }],
    });
    expect(next.staleProbeModels.map((model) => model.id)).toEqual(['b']);
    expect(next.snapshot).toMatchObject({ observedAt: 30, stale: false });
    expect(next.snapshot).not.toHaveProperty('staleAt');
  });

  it('rejects a failed refresh timestamp earlier than the retained observation', () => {
    const previous = applyProviderCatalogRefreshV1({ snapshot: null, staleProbeModels: [] }, {
      status: 'success', observedAt: 20, models: [{ id: 'a' }],
    });
    expect(() => applyProviderCatalogRefreshV1(previous, {
      status: 'failed', failedAt: 19,
    })).toThrowError(/cannot precede/u);
  });

  it('accepts the exact manual bound and rejects an over-bound union', () => {
    const merged = mergeProviderCatalogV1({
      staticModels: [],
      manualModels: Array.from({ length: 500 }, (_, index) => ({ id: `m-${index}`, addedAt: index })),
      probeState: { snapshot: null, staleProbeModels: [] },
    });
    expect(merged.rows).toHaveLength(500);
    expect(() => mergeProviderCatalogV1({
      staticModels: Array.from({ length: 5_000 }, (_, index) => ({
        id: `static-${index}`, name: `Static ${index}`,
      })),
      manualModels: [{ id: 'one-more', addedAt: 1 }],
      probeState: { snapshot: null, staleProbeModels: [] },
    })).toThrowError(ProviderCatalogLimitError);
  });

  it('resolves active, stale, and fully pruned exact refs without any visibility input', () => {
    const merged = mergeProviderCatalogV1({
      staticModels: [{ id: 'listed', name: 'Listed' }],
      manualModels: [],
      probeState: {
        snapshot: { models: [], observedAt: 2, stale: false },
        staleProbeModels: [{ id: 'stale', name: 'Stale name' }],
      },
    });
    expect(resolveProviderCatalogReferenceV1({
      modelId: 'listed', activeRows: merged.rows, staleRows: merged.staleRows,
      manualModelPolicy: 'catalog-only', agentSupportsFreeformModelIds: false,
    })).toMatchObject({ status: 'listed', row: { descriptor: { id: 'listed' } } });
    expect(resolveProviderCatalogReferenceV1({
      modelId: 'stale', activeRows: merged.rows, staleRows: merged.staleRows,
      manualModelPolicy: 'allowed', agentSupportsFreeformModelIds: true,
    })).toEqual({
      status: 'not_currently_listed',
      descriptor: { id: 'stale', name: 'Stale name' },
      provenance: 'stale_catalog',
    });
    expect(resolveProviderCatalogReferenceV1({
      modelId: 'pruned/default', activeRows: merged.rows, staleRows: merged.staleRows,
      manualModelPolicy: 'allowed', agentSupportsFreeformModelIds: true,
      displaySnapshot: { name: 'Previously selected' },
    })).toEqual({
      status: 'not_currently_listed',
      descriptor: { id: 'pruned/default', name: 'Previously selected' },
      provenance: 'display_snapshot',
    });
  });

  it('fails stale and pruned refs unless provider and agent both allow freeform ids', () => {
    const base = {
      modelId: 'default', activeRows: [], staleRows: [], displaySnapshot: { name: 'Literal default' },
    } as const;
    for (const policy of [
      { manualModelPolicy: 'catalog-only' as const, agentSupportsFreeformModelIds: true },
      { manualModelPolicy: 'allowed' as const, agentSupportsFreeformModelIds: false },
    ]) {
      expect(resolveProviderCatalogReferenceV1({ ...base, ...policy })).toEqual({
        status: 'not_found', errorCode: 'provider_model_not_found',
      });
    }
  });

  it('rejects an exact model appearing in both active and stale reference inputs', () => {
    const row = {
      descriptor: { id: 'same', name: 'Same' },
      sources: { manual: false, static: false, probe: true },
      confidence: 'probe' as const,
      catalogStale: false,
    };
    expect(() => resolveProviderCatalogReferenceV1({
      modelId: 'same',
      activeRows: [row],
      staleRows: [{ ...row, catalogStale: true, stale: true }],
      manualModelPolicy: 'allowed',
      agentSupportsFreeformModelIds: true,
    })).toThrowError(/active and stale/u);
  });

  it('rejects catalog rows placed in the wrong active or stale collection', () => {
    const row = {
      descriptor: { id: 'model-a', name: 'A' },
      sources: { manual: false, static: false, probe: true },
      confidence: 'probe' as const,
      catalogStale: true,
    };
    const base = {
      modelId: 'model-a', manualModelPolicy: 'allowed' as const,
      agentSupportsFreeformModelIds: true,
    };
    expect(() => resolveProviderCatalogReferenceV1({
      ...base, activeRows: [], staleRows: [row],
    })).toThrowError(/stale row/u);
    expect(() => resolveProviderCatalogReferenceV1({
      ...base, activeRows: [{ ...row, stale: true }], staleRows: [],
    })).toThrowError(/active row/u);
  });

  it('rejects duplicate active ids at the combined transition schema boundary', () => {
    expect(ProviderCatalogTransitionStateV1Schema.safeParse({
      snapshot: {
        models: [{ id: 'same' }, { id: 'same', name: 'Duplicate' }],
        observedAt: 1,
        stale: false,
      },
      staleProbeModels: [],
    }).success).toBe(false);
  });

  it('rejects malformed freeform-policy values at the public exact-reference boundary', () => {
    const base = {
      modelId: 'model-a', activeRows: [], staleRows: [],
      manualModelPolicy: 'allowed', agentSupportsFreeformModelIds: true,
    };
    expect(() => resolveProviderCatalogReferenceV1({
      ...base, agentSupportsFreeformModelIds: 'yes',
    } as unknown as Parameters<typeof resolveProviderCatalogReferenceV1>[0])).toThrow();
    expect(() => resolveProviderCatalogReferenceV1({
      ...base, manualModelPolicy: 'sometimes',
    } as unknown as Parameters<typeof resolveProviderCatalogReferenceV1>[0])).toThrow();
  });
});
