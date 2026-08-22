import { describe, expect, it, vi } from 'vitest';

import type { PluginApi } from '@happier-dev/plugin-sdk';

import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { activatePluginRuntimeRegistry } from '@/plugins/runtime/lifecycle/manager';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

import { buildPluginProjectionV2 } from './v2';

/**
 * UI-T28 — configuration reachability.
 *
 * A plugin whose daemon activation fails must still expose the host-rendered
 * surfaces a user needs to REPAIR it: its declared settings fields and its
 * Connected Account setup. Both are projected from the static contribution
 * registry, so this test drives a real activation failure through the lifecycle
 * manager and then asks the real projection producer what the client would see.
 */
const PLUGIN_ID = 'acme.tracker';

function ingestManifest() {
    const ingested = ingestCanonicalPluginManifest({
        schemaVersion: 2,
        id: PLUGIN_ID,
        version: '1.0.0',
        displayName: 'Acme tracker',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        activation: { events: [{ kind: 'startup' }] },
        contributes: {
            actions: [{
                id: 'sync',
                title: 'Sync',
                scopes: ['global'],
                surfaces: ['cli'],
                execution: { target: 'daemon' },
                placementBindings: ['primary'],
                dangerLevel: 'safe',
            }],
        },
    });
    if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
    return ingested.manifest;
}

function createContributes(manifest: ReturnType<typeof ingestManifest>): ResolvedContributionRegistry {
    const origin = {
        provenance: 'external' as const,
        source: { kind: 'installed' as const },
        pluginId: PLUGIN_ID,
        manifestPath: '/plugins/acme-tracker/happier.plugin.json',
    };
    return {
        agents: [],
        actions: [],
        tools: [],
        commands: [],
        resources: [],
        promptAssets: [],
        settings: [{
            ...origin,
            daemonEntryPath: '/plugins/acme-tracker/daemon.mjs',
            definition: {
                id: 'settings',
                version: 1,
                title: 'Acme tracker',
                target: { kind: 'plugin' },
                scope: 'daemon',
                fields: [{
                    id: 'endpoint',
                    title: 'Endpoint',
                    schema: { type: 'string', minLength: 1 },
                }],
                presentation: { sections: [], subagentSections: [] },
            },
        }],
        connectedAccountDescriptors: [{
            ...origin,
            definition: {
                id: 'tracker-account',
                title: 'Tracker account',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{
                            id: 'token',
                            title: 'API token',
                            schema: { type: 'string' },
                            secret: true,
                        }],
                    }],
                },
            },
        }],
        scmHostingProviders: [],
        activationTargets: [{
            provenance: 'external',
            source: { kind: 'installed' },
            pluginId: PLUGIN_ID,
            manifestPath: origin.manifestPath,
            daemonEntryPath: '/plugins/acme-tracker/daemon.mjs',
            sourceSpec: {
                kind: 'path',
                locator: '/plugins/acme-tracker',
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
            },
            activationEvents: ['startup'],
            manifest,
        }],
        catalogEntriesById: Object.freeze({}),
        agentDefinitionsById: new Map(),
        pluginDiagnosticsByPluginId: Object.freeze({}),
    } as unknown as ResolvedContributionRegistry;
}

describe('UI-T28 configuration reachability after a failed activation', () => {
    it('keeps declared settings and Connected Account setup projected when activation throws', async () => {
        const manifest = ingestManifest();
        const contributes = createContributes(manifest);
        const activate = vi.fn((_api: PluginApi) => {
            throw new Error('missing API token');
        });
        const activated = await activatePluginRuntimeRegistry({
            contributes,
            generation: 4,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-acme-tracker/daemon',
                load: async () => ({ activate }),
            }),
        });

        try {
            // The activation really failed — this is not a "plugin was never
            // asked to activate" test.
            expect(activate).toHaveBeenCalledTimes(1);
            expect(activated.failedActivationPluginIds.has(PLUGIN_ID)).toBe(true);
            expect(activated.pluginDiagnosticsByPluginId[PLUGIN_ID]).toEqual([
                expect.objectContaining({ code: 'plugin_activation_failed' }),
            ]);

            const projection = buildPluginProjectionV2({
                registry: contributes,
                generation: 4,
                pluginDiagnosticsByPluginId: activated.pluginDiagnosticsByPluginId,
            });

            // Host-rendered settings: the repair form is still projected, with
            // the field the user must fix.
            expect(projection.settingsById[`${PLUGIN_ID}/settings`]).toEqual(
                expect.objectContaining({
                    pluginId: PLUGIN_ID,
                    fields: [expect.objectContaining({ id: 'endpoint', control: 'text' })],
                }),
            );

            // Connected Account setup: reachable, with the failure disclosed.
            expect(projection.familiesById.connectedAccounts?.entriesById[`${PLUGIN_ID}/tracker-account`])
                .toEqual(expect.objectContaining({
                    availability: { state: 'available', reason: 'resolved' },
                    diagnostics: ['plugin_activation_failed'],
                }));

            // Negative control: the projection is not simply emitting rows for
            // everything — a plugin with no such declaration gets no row.
            expect(projection.settingsById['other.plugin/settings']).toBeUndefined();
            expect(projection.familiesById.connectedAccounts?.entriesById['other.plugin/tracker-account'])
                .toBeUndefined();
        } finally {
            await activated.dispose();
        }
    });
});
