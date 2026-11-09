import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentsListActionInputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { withTempDir } from '@/testkit/fs/tempDir';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from './sources/generatedBundledPluginManifests';
import { resolveMergedContributionRegistry } from './merged';

const { manifestReads } = vi.hoisted(() => ({ manifestReads: [] as string[] }));

// Observe the real filesystem boundary; declaration ingestion and both catalog
// projections execute unchanged against the complete bundled publication.
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const readFileSync = (...args: Parameters<typeof actual.readFileSync>) => {
        const path = String(args[0]).replaceAll('\\', '/');
        if (path.includes('/assets/bundled-plugin-manifests/')) manifestReads.push(path);
        return actual.readFileSync(...args);
    };
    return { ...actual, readFileSync: readFileSync as typeof actual.readFileSync };
});

describe('merged bundled catalog admission cost', () => {
    it('reuses the enabled graph across repeated catalog reads and observes enablement changes', async () => {
        const pluginId = 'happier.inspector';
        let enabled = false;
        const app = fastify();
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async request => {
            const ids = PluginAvailabilityIntentsListActionInputV1Schema.parse(request.body).knownPluginIds ?? [];
            return { availabilityCursor: 1, pluginIds: ids, failedPluginIds: [], intentReads: ids.map(id => ({ pluginId: id,
                response: { availabilityCursor: 1, hostingCapability: { enabled: false }, intent: id === pluginId ? {
                    pluginId, desiredVersion: null, enabled, offlineUiHosting: 'disabled', writableCollections: [], revision: '1',
                } : null, release: null, uiArtifacts: [], packageAssets: [] },
            })) };
        });
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://bundled-admission-cost.test' });
        try {
            await withTempDir('bundled-admission-cost-', async happyHomeDir => {
                const read = () => resolveMergedContributionRegistry({ happyHomeDir, accountStorageDependencies: {
                    readCredentials: async () => ({ token: 'fixture', encryption: null }),
                    resolveBaseUrl: () => 'http://bundled-admission-cost.test',
                } });
                manifestReads.length = 0;
                const cold = await read();
                const coldReads = manifestReads.length;
                expect(cold.pluginDeclarations?.some(plugin => plugin.pluginId === pluginId)).toBe(false);
                expect(coldReads).toBe(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.length - 1);
                const repeated = await read();
                const selected = await resolveMergedContributionRegistry({ happyHomeDir,
                    agentIdentity: { pluginId: 'happier.agent.claude', localId: 'claude' },
                    accountStorageDependencies: {
                        readCredentials: async () => ({ token: 'fixture', encryption: null }),
                        resolveBaseUrl: () => 'http://bundled-admission-cost.test',
                    },
                });
                console.info('bundled admission measurement', { bundled: BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.length,
                    coldReads, repeatedReads: manifestReads.length - coldReads });
                expect(repeated.pluginDeclarations?.some(plugin => plugin.pluginId === pluginId)).toBe(false);
                expect(selected.agents.some(agent => agent.id === 'claude')).toBe(true);
                expect(manifestReads).toHaveLength(coldReads);

                enabled = true;
                const restored = await read();
                expect(restored.pluginDeclarations?.some(plugin => plugin.pluginId === pluginId)).toBe(true);
                const changedReads = manifestReads.length;
                expect(changedReads - coldReads).toBe(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.length);
                await read();
                expect(manifestReads).toHaveLength(changedReads);
            });
        } finally {
            restore();
            await app.close();
        }
    });
});
