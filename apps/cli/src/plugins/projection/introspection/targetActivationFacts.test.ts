import { describe, expect, it } from 'vitest';
import type { PluginApi } from '@happier-dev/plugin-sdk';

import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { activateContributionModule } from '@/plugins/runtime/lifecycle/activation/activateContributionModule';
import { projectPluginTargetActivationRegistrationFacts } from '@/plugins/runtime/lifecycle/activation/facts';
import { admitPluginContributionGraph } from '../registry/normalize/admission';
import { buildPluginContributionRegistry } from '../registry/normalize/package';
import { collectNormalizedRegistryIntrospectionCandidates } from './normalizedRegistry';
import type { PluginContributionIntrospectionCandidate } from './types';
import { adaptTargetActivationFacts } from './targetActivationFacts';

const required: PluginContributionIntrospectionCandidate = {
  pluginId: 'acme.runtime', pluginVersion: '1.0.0', source: 'development',
  family: 'actions', identity: { kind: 'localId', localId: 'run' },
  registration: 'required', consumer: 'action-dispatch', platforms: ['cli'],
};
const descriptor: PluginContributionIntrospectionCandidate = {
  ...required, family: 'ui.translations', identity: { kind: 'locale', locale: 'en-US' },
  registration: 'notRequired', consumer: 'ui-i18n-host', platforms: ['web'],
};
const managedProvider: PluginContributionIntrospectionCandidate = {
  ...required, family: 'providers', identity: { kind: 'delegatedDomain', domainId: 'packed-managed-provider' },
  runtimeRegistrationHost: 'daemon', runtimeRegistrationFamily: 'providers',
  consumer: 'providers-first-class',
};
const plugin = { pluginId: 'acme.runtime', pluginVersion: '1.0.0', source: 'development' as const };

function activeFact(occurrenceId = '4') {
  return {
    pluginId: 'acme.runtime', pluginVersion: '1.0.0', source: 'development' as const,
    occurrenceId, host: 'daemon' as const, platform: 'darwin', occurredAtMs: 10,
    status: 'active' as const,
    required: [{ family: 'actions', localId: 'run' }],
    bound: [{ family: 'actions', localId: 'run' }], diagnostics: [],
  };
}

describe('target activation introspection adapter', () => {
  it('projects admitted healthy siblings without traversing registration evidence again', async () => {
    const action = { id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'],
      execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' };
    const admitted = ingestCanonicalPluginManifest({
      schemaVersion: 2, id: plugin.pluginId, version: plugin.pluginVersion, displayName: 'Runtime',
      runtime: { apiVersion: 1 }, entrypoints: { daemon: './plugin.js' },
      contributes: { actions: [action, { ...action, id: 'invalid', unsupported: true }] },
    }, { purpose: 'admission', sourceProvenance: 'registryCustodied' });
    if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
    expect(admitted.diagnostics).toContainEqual(expect.objectContaining({
      code: 'plugin_contribution_skipped', contributionId: 'invalid',
    }));
    const graph = admitPluginContributionGraph({ loadedPlugins: [{
      pluginId: plugin.pluginId, pluginRootPath: '/plugins/runtime', manifestPath: '/plugins/runtime/plugin.json',
      daemonEntryPath: '/plugins/runtime/plugin.js', devDaemonEntryPath: null, manifest: admitted.manifest,
      sourceSpec: { kind: 'path', locator: '/plugins/runtime', trustPolicy: 'local_trusted', installPolicy: 'link' },
    }] });
    const candidates = collectNormalizedRegistryIntrospectionCandidates(buildPluginContributionRegistry({
      loadedPlugins: graph.loadedPlugins, admittedGraph: graph,
    }));
    let activationCount = 0;
    const activation = await activateContributionModule({
      pluginId: plugin.pluginId, occurrenceId: '4', manifest: admitted.manifest, isOccurrenceCurrent: () => true,
      moduleNamespace: { activate(api: PluginApi) { activationCount++; api.actions.register('run', async () => ({ result: true })); } },
    });
    try {
      expect(activation.status).toBe('active');
      const refs = projectPluginTargetActivationRegistrationFacts(activation.registrations);
      let registrationEvidenceReads = 0;
      const fact = { ...activeFact(), source: 'localPath' as const, status: activation.status,
        get required() { registrationEvidenceReads++; return refs; },
        get bound() { registrationEvidenceReads++; return refs; },
      };
      for (const generation of [4, 5, 6]) {
        const snapshot = adaptTargetActivationFacts({ generation, candidates,
          plugins: [{ ...plugin, source: 'localPath' }], targetActivationFacts: [fact], runtimeState: 'current' });
        expect([...snapshot.runtimeFactsByQualifiedId.keys()]).toEqual(['acme.runtime/actions/run']);
        expect(snapshot.runtimeFactsByQualifiedId.get('acme.runtime/actions/run')?.registration.state).toBe('bound');
      }
      expect(registrationEvidenceReads).toBe(0);
      expect(activationCount).toBe(1);
      expect(adaptTargetActivationFacts({ generation: 7, candidates,
        plugins: [{ ...plugin, source: 'localPath' }],
        targetActivationFacts: [{ ...fact, status: 'unavailable' }], runtimeState: 'current',
      }).runtimeFactsByQualifiedId.get('acme.runtime/actions/run')?.registration.state).toBe('unavailable');
    } finally {
      await activation.dispose();
    }
  });
  it('binds a registration-required delegated-domain contribution to the registration identity the runtime derives', () => {
    const registrationRef = { family: 'providers', localId: 'packed-managed-provider' };
    const adapted = adaptTargetActivationFacts({
      generation: 4,
      candidates: [managedProvider],
      plugins: [plugin],
      targetActivationFacts: [{ ...activeFact(), required: [registrationRef], bound: [registrationRef] }],
      runtimeState: 'current',
    });

    expect(adapted.runtimeFactsByQualifiedId.get('acme.runtime/providers/packed-managed-provider')).toEqual({
      registration: { requirement: 'required', state: 'bound', occurrenceId: '4' },
      activation: { state: 'active', occurrenceId: '4' }, projection: { state: 'projected' },
    });
  });

  it('binds and activates only an exact current-occurrence required target', () => {
    const adapted = adaptTargetActivationFacts({
      generation: 4, candidates: [required, descriptor], targetActivationFacts: [activeFact()],
      plugins: [plugin],
      runtimeState: 'current',
    });

    expect(adapted.runtimeFactsByQualifiedId.get('acme.runtime/actions/run')).toEqual({
      registration: { requirement: 'required', state: 'bound', occurrenceId: '4' },
      activation: { state: 'active', occurrenceId: '4' }, projection: { state: 'projected' },
    });
    expect(adapted.runtimeFactsByQualifiedId.has('acme.runtime/ui.translations/en-US')).toBe(false);
  });

  it.each([
    ['unavailable', activeFact(), 'current'],
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
      expect.objectContaining({ stage: 'activation', occurrenceId: fact.occurrenceId, plugin: { id: 'acme.runtime', version: '1.0.0', source: 'development' } }),
    ]);
  });

  it('rejects contradictory metadata merged from current catalog sources', () => {
    expect(() => adaptTargetActivationFacts({
      generation: 4, candidates: [required], plugins: [plugin, { ...plugin, pluginVersion: '2.0.0' }],
      runtimeState: 'current', targetActivationFacts: [activeFact()],
    })).toThrow(/contradictory plugin metadata/);
  });

  it('keeps retained active facts usable when a peer update advances the public projection', () => {
    const second = {
      ...required,
      pluginId: 'acme.second',
      identity: { kind: 'localId' as const, localId: 'run' },
    };
    const adapted = adaptTargetActivationFacts({
      generation: 5, candidates: [required, second], plugins: [plugin, { ...plugin, pluginId: 'acme.second' }], targetActivationFacts: [
        activeFact(),
        { ...activeFact('3'), pluginId: 'acme.second' },
      ],
      runtimeState: 'current',
    });

    expect(adapted.runtimeFactsByQualifiedId.get('acme.runtime/actions/run')).toEqual({
      registration: { requirement: 'required', state: 'bound', occurrenceId: '4' },
      activation: { state: 'active', occurrenceId: '4' }, projection: { state: 'projected' },
    });
    expect(adapted.runtimeFactsByQualifiedId.get('acme.second/actions/run')).toEqual({
      registration: { requirement: 'required', state: 'bound', occurrenceId: '3' },
      activation: { state: 'active', occurrenceId: '3' }, projection: { state: 'projected' },
    });
    expect(adapted.diagnosticRecords).toEqual([]);
  });

  it.each([
    ['version', { pluginVersion: '0.9.0' }],
    ['source', { source: 'localPath' as const }],
  ])('does not bind a current-occurrence fact whose host-owned %s differs from the catalog', (_name, mismatch) => {
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

  it('ignores a retained fact for a plugin absent from the current catalog', () => {
    expect(adaptTargetActivationFacts({
      generation: 4,
      candidates: [],
      plugins: [],
      targetActivationFacts: [{
        ...activeFact(), status: 'unavailable', required: [], bound: [],
        diagnostics: [{ code: 'plugin_activation_failed', message: 'Unknown plugin failed' }],
      }],
      runtimeState: 'current',
    }).runtimeFactsByQualifiedId.size).toBe(0);
  });
});
