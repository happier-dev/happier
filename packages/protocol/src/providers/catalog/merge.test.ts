import { describe, expect, it } from 'vitest';
import { ProviderManualModelV1Schema } from '../settings/v1.js';
import type { ProviderCatalogProbeModelV1 } from './merge.js';
import { parseProviderCatalogResponse } from './response.js';
import type { ProviderModelDescriptorV1 } from '../../models/descriptor.js';

import {
  ProviderCatalogTransitionStateV1Schema,
  applyProviderCatalogRefreshV1,
  mergeProviderCatalogV1,
  resolveProviderCatalogReferenceV1,
} from './merge.js';

describe('provider catalog merge', () => {
  it('retains exact gateway upstream identities through the catalog, without inferring from opaque ids', () => {
    const { models } = parseProviderCatalogResponse('openai-models', { data: [
      { id: 'openai/gpt-4', canonical_slug: 'openai/gpt-4', name: 'GPT-4' },
      { id: 'custom/gpt-4', name: 'GPT-4' },
    ] });
    const probeState = applyProviderCatalogRefreshV1({ snapshot: null, staleProbeModels: [] }, {
      status: 'success', observedAt: 1, models,
    });
    const { rows } = mergeProviderCatalogV1({ staticModels: [], manualModels: [], probeState });
    expect(rows.find(row => row.descriptor.id === 'openai/gpt-4')?.descriptor).toMatchObject({
      upstreamRef: { vendor: 'openai', vendorModelId: 'gpt-4' },
    });
    expect(rows.find(row => row.descriptor.id === 'custom/gpt-4')?.descriptor.upstreamRef).toBeUndefined();
  });

  it.each(['augment', 'probe-authoritative'] as const)('uses manual reasoning declarations only without source facts (%s)', (membershipPolicy) => {
    const effort = (value: string) => ({ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: value,
      options: [{ value, name: value }] });
    const cases: ReadonlyArray<Readonly<{
      id: string; declared?: boolean; probe?: Omit<ProviderCatalogProbeModelV1, 'id'>;
      curated?: Omit<ProviderModelDescriptorV1, 'id' | 'name'>; expected?: string[]; support?: string;
    }>> = [
      { id: 'declared-only', declared: true, expected: ['low', 'high'], support: 'supported' },
      { id: 'undeclared' },
      { id: 'listed', declared: true, probe: {}, expected: ['low', 'high'], support: 'supported' },
      { id: 'listed-undeclared', probe: {} },
      { id: 'probe-wins', declared: true, probe: { capabilities: { reasoningControls: 'supported' }, modelOptions: [effort('max')] }, expected: ['max'], support: 'supported' },
      { id: 'probe-unsupported', declared: true, probe: { capabilities: { reasoningControls: 'unsupported' } }, support: 'unsupported' },
      { id: 'probe-option-only', declared: true, probe: { modelOptions: [effort('medium')] }, expected: ['medium'] },
      { id: 'static-unsupported', declared: true, curated: { capabilities: { reasoningControls: 'unsupported' } }, probe: {}, support: 'unsupported' },
      { id: 'static-supported', declared: true, curated: { capabilities: { reasoningControls: 'supported' }, modelOptions: [effort('medium')] }, probe: {}, expected: ['medium'], support: 'supported' },
      { id: 'static-unclassified', declared: true, curated: { capabilities: { toolRoundTrips: 'supported' } }, probe: {}, expected: ['low', 'high'], support: 'supported' },
      { id: 'probe-over-static', declared: true, curated: { capabilities: { reasoningControls: 'unsupported' } }, probe: { capabilities: { reasoningControls: 'supported' }, modelOptions: [effort('max')] }, expected: ['max'], support: 'supported' },
    ];
    const merged = mergeProviderCatalogV1({ membershipPolicy,
      manualModels: cases.map(row => ProviderManualModelV1Schema.parse({ id: row.id, addedAt: 1,
        ...(row.declared ? { reasoningEffortLevels: ['low', 'high'] } : {}) })),
      staticModels: cases.flatMap(row => row.curated ? [{ id: row.id, name: row.id, ...row.curated }] : []),
      probeState: { snapshot: { observedAt: 1, stale: false,
        models: cases.flatMap(row => row.probe ? [{ id: row.id, ...row.probe }] : []) }, staleProbeModels: [] },
    });
    for (const row of cases) {
      const descriptor = merged.rows.find(candidate => candidate.descriptor.id === row.id)!.descriptor;
      expect(descriptor.capabilities?.reasoningControls, row.id).toBe(row.support);
      expect(descriptor.modelOptions?.find(option => option.id === 'reasoning_effort')?.options?.map(option => option.value), row.id).toEqual(row.expected);
    }
    if (membershipPolicy === 'augment') {
      expect(merged.rows.find(row => row.descriptor.id === 'static-unclassified')?.descriptor.capabilities?.toolRoundTrips).toBe('supported');
    }
  });
  it('names returned snapshot ids from contributed catalogs without importing their availability or model controls', () => {
    const merged = mergeProviderCatalogV1({
      staticModels: [], manualModels: [],
      modelNameCatalog: [{ id: 'acme-fast', name: 'Acme Fast', aliases: ['acme-fast-pinned'], contextWindowTokens: 100_000 }],
      probeState: {
        snapshot: { stale: false, observedAt: 1, models: [{ id: 'acme-fast-pinned', name: 'acme-fast-pinned' }, { id: 'unknown-id' }] },
        staleProbeModels: [{ id: 'acme-fast' }],
      },
    });
    expect(merged.rows.map(row => row.descriptor)).toEqual([
      { id: 'acme-fast-pinned', name: 'Acme Fast' }, { id: 'unknown-id', name: 'unknown-id' },
    ]);
    expect(merged.staleRows[0]?.descriptor).toEqual({ id: 'acme-fast', name: 'Acme Fast' });
  });
  it('preserves exact producer slot facts across merge and stale transitions without deriving them from model ids', () => {
    const purpose = { consumer: { pluginId: 'acme.gateway', localId: 'gateway' }, purpose: 'upstream' };
    const refresh = { status: 'success' as const, observedAt: 20,
      models: [{ id: 'opaque-model', connectedAccountPurposes: [purpose] }, { id: 'claude-looking-name' }] };
    const state = applyProviderCatalogRefreshV1({ snapshot: null, staleProbeModels: [] }, refresh);
    const merge = (probeState: typeof state) => mergeProviderCatalogV1({ staticModels: [], manualModels: [], probeState });
    const row = merge(state).rows.find(candidate => candidate.descriptor.id === 'opaque-model')!;
    expect(row).toMatchObject({ connectedAccountPurposes: [purpose] });
    expect(Reflect.get(merge(state).rows.find(candidate => candidate.descriptor.id === 'claude-looking-name')!, 'connectedAccountPurposes')).toBeUndefined();
    const removed = applyProviderCatalogRefreshV1(state, { status: 'success', observedAt: 30, models: [] });
    expect(merge(removed).staleRows).toEqual(expect.arrayContaining([expect.objectContaining({ connectedAccountPurposes: [purpose] })]));
    expect(() => applyProviderCatalogRefreshV1({ snapshot: null, staleProbeModels: [] }, {
      ...refresh, models: [{ id: 'opaque-model', connectedAccountPurposes: [{ ...purpose, secret: 'must-not-cross' }] }],
    })).toThrow();
  });
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

  it('removes omitted authoritative controls while retaining curated presentation', () => {
    const old = { id: 'same', name: 'Curated', description: 'Presentation', contextWindowTokens: 200_000,
      extendedContextModelId: 'same-long', capabilities: { reasoningControls: 'supported' as const },
      modelOptions: [{ id: 'effort', name: 'Effort', type: 'boolean' as const, currentValue: 'true' }] };
    const previous = applyProviderCatalogRefreshV1({ snapshot: null, staleProbeModels: [] },
      { status: 'success', observedAt: 1, models: [{ id: old.id, modelOptions: old.modelOptions, capabilities: old.capabilities }] });
    const next = applyProviderCatalogRefreshV1(previous,
      { status: 'success', observedAt: 2, models: [{ id: 'same' }] });
    expect(mergeProviderCatalogV1({ staticModels: [old], manualModels: [], probeState: next,
      membershipPolicy: 'probe-authoritative' }).rows[0]?.descriptor)
      .toEqual({ id: 'same', name: 'Curated', description: 'Presentation' });
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
