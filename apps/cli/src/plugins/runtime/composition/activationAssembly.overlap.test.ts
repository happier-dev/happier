import { describe, expect, it } from 'vitest';
import type { PluginApi } from '@happier-dev/plugin-sdk';

import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPluginRuntimeOccurrenceId } from '../runtimeSlots';
import { assemblePluginRuntimeActivation } from './activationAssembly';

describe('retained plugin activation composition', () => {
    it('activates a changed occurrence independently of a retained predecessor', async () => {
        const admitted = ingestCanonicalPluginManifest(createPluginManifestV2Fixture({
            schemaVersion: 2, id: 'acme.activation-overlap', version: '1.0.0', displayName: 'Overlap',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.js' },
            contributes: { actions: [{ id: 'identity', title: 'Identity', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['commandPalette'], dangerLevel: 'safe' }] },
        }), { manifestAuthority: 'bundled_first_party', sourceProvenance: 'registryCustodied' });
        if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
        const pluginId = admitted.manifest.id;
        let activations = 0;
        const cleanups: number[] = [];
        const module = { activate(api: PluginApi) {
            const identity = ++activations;
            api.actions.register('identity', async () => identity);
            return () => { cleanups.push(identity); };
        } };
        const contributes = createResolvedContributionRegistry({ activationTargets: [{
            provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
            manifestPath: '/virtual/overlap/plugin.json', daemonEntryPath: '/virtual/overlap/daemon.js',
            sourceSpec: { kind: 'package', locator: '@acme/activation-overlap', trustPolicy: 'local_trusted', installPolicy: 'copy' },
            activationEvents: [], manifest: admitted.manifest,
        }] });
        const activationParams = {
            contributes, generation: 2,
            occurrenceIdsByPluginId: new Map([[pluginId, createPluginRuntimeOccurrenceId(pluginId)]]),
            resolveActivationSource: () => ({ kind: 'bundled' as const, moduleId: '@acme/activation-overlap', load: async () => module }),
        };
        const first = await assemblePluginRuntimeActivation({ activationParams, scopedPluginIds: [pluginId], disposeInvocationServices: async () => {} });
        try {
            const component = first.retainedActivationRegistryLeases.find(lease => lease.pluginIds.has(pluginId));
            if (!component) throw new Error('Missing predecessor component');
            const nextOccurrenceId = createPluginRuntimeOccurrenceId(pluginId);
            const successor = await assemblePluginRuntimeActivation({
                activationParams: { ...activationParams, occurrenceIdsByPluginId: new Map([[pluginId, nextOccurrenceId]]) },
                scopedPluginIds: [pluginId], retainedLeases: [component.retain()], disposeInvocationServices: async () => {},
            });
            try {
                expect(activations).toBe(2);
                expect(successor.activatedRegistry.readPluginOccurrenceId(pluginId)).toBe(nextOccurrenceId);
                await first.activationRegistryLease.release();
                expect(cleanups).toEqual([]);
            } finally { await successor.activationRegistryLease.release(); }
            expect(cleanups.sort()).toEqual([1, 2]);
        } finally { await first.activationRegistryLease.release(); }
    });

    it('reuses the retained GitHub occurrence when the same activation is requested again', async () => {
        const github = await import('@happier-dev/plugins-scm-github');
        const admitted = ingestCanonicalPluginManifest(github.PLUGIN_MANIFEST, {
            manifestAuthority: 'bundled_first_party', sourceProvenance: 'registryCustodied',
        });
        if (!admitted.ok) throw new Error('GitHub declaration was not admitted');
        const pluginId = admitted.manifest.id;
        const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
        const contributes = createResolvedContributionRegistry({
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
                manifestPath: '/virtual/github/plugin.json', daemonEntryPath: '/virtual/github/daemon.js',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-scm-github', trustPolicy: 'local_trusted', installPolicy: 'copy' },
                activationEvents: [], manifest: admitted.manifest,
            }],
        });
        const activationParams = {
            contributes, generation: 1,
            occurrenceIdsByPluginId: new Map([[pluginId, occurrenceId]]),
            resolveActivationSource: () => ({ kind: 'bundled' as const, moduleId: '@happier-dev/plugins-scm-github/overlap', load: async () => github }),
        };
        const first = await assemblePluginRuntimeActivation({
            activationParams, scopedPluginIds: [pluginId], disposeInvocationServices: async () => {},
        });
        try {
            expect(first.activatedRegistry.activatedPluginIds.has(pluginId), JSON.stringify(first.activatedRegistry.pluginDiagnosticsByPluginId)).toBe(true);
            const component = first.retainedActivationRegistryLeases.find(lease => lease.pluginIds.has(pluginId));
            if (!component) throw new Error('Missing serving activation component');
            const successor = await assemblePluginRuntimeActivation({
                activationParams, scopedPluginIds: [pluginId], retainedLeases: [component.retain()],
                disposeInvocationServices: async () => {},
            });
            try {
                // This activation-only composition does not start background
                // services. Retention must preserve, rather than add to, its diagnostics.
                expect(successor.activatedRegistry.pluginDiagnosticsByPluginId[pluginId] ?? [])
                    .toEqual(first.activatedRegistry.pluginDiagnosticsByPluginId[pluginId] ?? []);
                expect(successor.activatedRegistry.activatedPluginIds.has(pluginId)).toBe(true);
                expect(successor.activatedRegistry.targetActivationFacts.filter(fact => fact.pluginId === pluginId))
                    .toEqual(first.activatedRegistry.targetActivationFacts.filter(fact => fact.pluginId === pluginId));
                expect(successor.activatedRegistry.targetRegistrations).toEqual(first.activatedRegistry.targetRegistrations);
                await first.activationRegistryLease.release();
                await successor.activatedRegistry.activatePluginsForValidation([pluginId]);
                expect(successor.activatedRegistry.readPluginOccurrenceId(pluginId)).toBe(occurrenceId);
                expect(successor.activatedRegistry.failedActivationPluginIds.has(pluginId)).toBe(false);
            } finally { await successor.activationRegistryLease.release(); }
        } finally { await first.activationRegistryLease.release(); }
        // Both composition leases released: the module can start a fresh occurrence.
        const replacement = await assemblePluginRuntimeActivation({
            activationParams: { ...activationParams, occurrenceIdsByPluginId: new Map([[pluginId, createPluginRuntimeOccurrenceId(pluginId)]]) },
            scopedPluginIds: [pluginId], disposeInvocationServices: async () => {},
        });
        try { expect(replacement.activatedRegistry.activatedPluginIds.has(pluginId)).toBe(true); }
        finally { await replacement.activationRegistryLease.release(); }
    });
});
