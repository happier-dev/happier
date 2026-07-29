import { describe, expect, it } from 'vitest';

import type { PluginContributionIntrospectionCandidate } from './types';
import { adaptTargetActivationFacts } from './targetActivationFacts';

const required: PluginContributionIntrospectionCandidate = {
  pluginId: 'acme.runtime', pluginVersion: '1.0.0', source: 'development',
  family: 'actions', identity: { kind: 'localId', localId: 'run' },
  stability: 'stable', registration: 'required', consumer: 'action-dispatch', platforms: ['cli'],
};
const descriptor: PluginContributionIntrospectionCandidate = {
  ...required, family: 'ui.translations', identity: { kind: 'locale', locale: 'en-US' },
  registration: 'notRequired', consumer: 'ui-i18n-host', platforms: ['web'],
};
const plugin = { pluginId: 'acme.runtime', pluginVersion: '1.0.0', source: 'development' as const };

function activeFact(generation = '4') {
  return {
    pluginId: 'acme.runtime', pluginVersion: '1.0.0', source: 'development' as const,
    generation, host: 'daemon' as const, platform: 'darwin', occurredAtMs: 10,
    status: 'active' as const,
    required: [{ family: 'actions', localId: 'run' }],
    bound: [{ family: 'actions', localId: 'run' }], diagnostics: [],
  };
}

describe('target activation introspection adapter', () => {
  it('binds and activates only an exact current-generation required target', () => {
    const adapted = adaptTargetActivationFacts({
      generation: 4, candidates: [required, descriptor], targetActivationFacts: [activeFact()],
      plugins: [plugin],
      runtimeState: 'current',
    });

    expect(adapted.runtimeFactsByQualifiedId.get('acme.runtime/actions/run')).toEqual({
      registration: { requirement: 'required', state: 'bound', generation: '4' },
      activation: { state: 'active', generation: '4' }, projection: { state: 'projected' },
    });
    expect(adapted.runtimeFactsByQualifiedId.has('acme.runtime/ui.translations/en-US')).toBe(false);
  });

  it.each([
    ['unavailable', activeFact(), 'current'],
    ['stale', activeFact('3'), 'current'],
    ['disposed', activeFact(), 'disposed'],
  ] as const)('keeps %s target facts unavailable and dormant with a canonical diagnostic', (_name, fact, runtimeState) => {
    const targetActivationFacts = fact.status === 'active' && _name === 'unavailable'
      ? [{ ...fact, status: 'unavailable' as const, bound: [], diagnostics: [{ code: 'plugin_activation_failed' as const, message: 'Failed' }] }]
      : [fact];
    const adapted = adaptTargetActivationFacts({
      generation: 4, candidates: [required], targetActivationFacts,
      plugins: [plugin],
      runtimeState,
    });

    expect(adapted.runtimeFactsByQualifiedId.get('acme.runtime/actions/run')).toMatchObject({
      registration: { requirement: 'required', state: 'unavailable' },
      activation: { state: 'dormant' },
    });
    expect(adapted.diagnosticRecords).toEqual([
      expect.objectContaining({ stage: 'activation', generation: fact.generation, plugin: { id: 'acme.runtime', version: '1.0.0', source: 'development' } }),
    ]);
  });

  it('rejects unknown, duplicate, and contradictory target facts', () => {
    const base = {
      generation: 4, candidates: [required], plugins: [plugin], runtimeState: 'current' as const,
    };
    expect(() => adaptTargetActivationFacts({ ...base, targetActivationFacts: [{ ...activeFact(), required: [{ family: 'actions', localId: 'missing' }] }] }))
      .toThrow(/unknown required contribution/);
    expect(() => adaptTargetActivationFacts({ ...base, targetActivationFacts: [activeFact(), activeFact()] }))
      .toThrow(/Duplicate target activation fact/);
    expect(() => adaptTargetActivationFacts({ ...base, targetActivationFacts: [{ ...activeFact(), bound: [] }] }))
      .toThrow(/exactly match/);
  });

  it('rejects facts from two generations instead of merging them', () => {
    const second = {
      ...required,
      pluginId: 'acme.second',
      identity: { kind: 'localId' as const, localId: 'run' },
    };
    expect(() => adaptTargetActivationFacts({
      generation: 4, candidates: [required, second], plugins: [plugin, { ...plugin, pluginId: 'acme.second' }], targetActivationFacts: [
        activeFact(),
        { ...activeFact('3'), pluginId: 'acme.second' },
      ],
      runtimeState: 'current',
    })).toThrow(/multiple generations/);
  });

  it.each([
    ['version', { pluginVersion: '0.9.0' }],
    ['source', { source: 'localPath' as const }],
  ])('does not bind a current-generation fact whose host-owned %s differs from the catalog', (_name, mismatch) => {
    const fact = { ...activeFact(), ...mismatch };
    const adapted = adaptTargetActivationFacts({
      generation: 4,
      candidates: [required],
      plugins: [plugin],
      targetActivationFacts: [fact],
      runtimeState: 'current',
    });

    expect(adapted.runtimeFactsByQualifiedId.get('acme.runtime/actions/run')).toMatchObject({
      registration: { requirement: 'required', state: 'unavailable' },
      activation: { state: 'dormant' },
    });
    expect(adapted.diagnosticRecords).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ code: 'plugin_activation_metadata_stale' }),
        plugin: {
          id: 'acme.runtime',
          version: fact.pluginVersion,
          source: fact.source,
        },
        host: 'daemon',
        platform: 'darwin',
        occurredAtMs: 10,
      }),
    ]);
  });

  it('preserves a registration-free startup failure as a plugin diagnostic', () => {
    const adapted = adaptTargetActivationFacts({
      generation: 4,
      candidates: [descriptor],
      plugins: [plugin],
      targetActivationFacts: [{
        ...activeFact(),
        status: 'unavailable',
        required: [],
        bound: [],
        diagnostics: [{ code: 'plugin_activation_failed', message: 'Startup failed' }],
      }],
      runtimeState: 'current',
    });

    expect(adapted.runtimeFactsByQualifiedId.size).toBe(0);
    expect(adapted.diagnosticRecords).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ code: 'plugin_activation_failed', message: 'Startup failed' }),
        plugin: { id: 'acme.runtime', version: '1.0.0', source: 'development' },
      }),
    ]);
  });

  it('rejects a registration-free fact for a plugin absent from the current catalog', () => {
    expect(() => adaptTargetActivationFacts({
      generation: 4,
      candidates: [],
      plugins: [],
      targetActivationFacts: [{
        ...activeFact(), status: 'unavailable', required: [], bound: [],
        diagnostics: [{ code: 'plugin_activation_failed', message: 'Unknown plugin failed' }],
      }],
      runtimeState: 'current',
    })).toThrow(/unknown plugin/);
  });
});
