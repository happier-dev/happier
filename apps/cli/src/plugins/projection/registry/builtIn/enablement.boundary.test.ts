import fastify from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentsListActionInputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resolvePluginContributes } from '../resolvePluginContributions';
import { resolveMergedContributionRegistry } from '../merged';
import { loadCurrentBundledPluginLocatorResult } from './locators';
import { getResolvedContributionRegistry, readCurrentBundledPluginEnablement } from './snapshot';

describe('bundled admission Account boundary', () => {
    it('withdraws an installed development replacement under the same bundled Account identity and restores it', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'bundled-replacement-intent-'));
        const pluginId = 'happier.app-context';
        const bundled = loadCurrentBundledPluginLocatorResult().loadedPlugins.find(plugin => plugin.pluginId === pluginId)!;
        const pluginRoot = join(happyHomeDir, 'replacement');
        const app = fastify();
        let enabled = false;
        let censusReads = 0;
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async request => {
            censusReads++;
            const ids = PluginAvailabilityIntentsListActionInputV1Schema.parse(request.body).knownPluginIds ?? [];
            return { availabilityCursor: 1, pluginIds: ids, failedPluginIds: [], intentReads: ids.map(id => ({ pluginId: id,
                response: { availabilityCursor: 1, hostingCapability: { enabled: false }, intent: id === pluginId ? {
                    pluginId, desiredVersion: null, enabled, offlineUiHosting: 'disabled', writableCollections: [], revision: '1',
                } : null, release: null, uiArtifacts: [], packageAssets: [] },
            })) };
        });
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://bundled-replacement-intent.test' });
        try {
            const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
            await mkdir(dirname(manifestPath), { recursive: true });
            await writeFile(manifestPath, JSON.stringify(bundled.manifest));
            if (bundled.manifest.entrypoints?.daemon) {
                const daemonPath = join(pluginRoot, bundled.manifest.entrypoints.daemon);
                await mkdir(dirname(daemonPath), { recursive: true });
                await writeFile(daemonPath, 'export function activate() {}');
            }
            await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: bundled.manifest.version });
            const admit = () => resolveMergedContributionRegistry({ happyHomeDir, accountStorageDependencies: {
                readCredentials: async () => ({ token: 'fixture', encryption: null }),
                resolveBaseUrl: () => 'http://bundled-replacement-intent.test',
            } });
            const disabled = await admit();
            expect(disabled.pluginDeclarations?.some(plugin => plugin.pluginId === pluginId)).toBe(false);
            expect(disabled.activationTargets.some(target => target.pluginId === pluginId)).toBe(false);
            expect(disabled.pluginEnablementById?.[pluginId]).toMatchObject({ accountEnabled: false, machineEnabled: true, enabled: false });
            enabled = true;
            const restored = await admit();
            expect(restored.pluginDeclarations?.find(plugin => plugin.pluginId === pluginId)?.sourceSpec.kind).toBe('path');
            expect(restored.pluginEnablementById?.[pluginId]).toMatchObject({ accountEnabled: true, machineEnabled: true, enabled: true });
            expect(censusReads).toBe(2);
        } finally {
            restore();
            await app.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('keeps withdrawn bundled references unavailable when exact Agent discovery expands installed peers', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'bundled-reference-withdrawal-'));
        const pluginId = 'acme.account-consumer';
        const pluginRoot = join(happyHomeDir, 'consumer');
        const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
        try {
            await mkdir(dirname(manifestPath), { recursive: true });
            await writeFile(manifestPath, JSON.stringify(createPluginManifestV2Fixture({
                id: pluginId, entrypoints: {},
                hostAccess: { required: [{ id: 'claude-account', capability: 'connectedAccounts', reason: 'Use an account',
                    scope: { serviceRefs: [{ pluginId: 'happier.agent.claude', localId: 'claude-subscription' }], operations: ['use'] },
                }], optional: [] }, contributes: {},
            })));
            await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: '1.0.0' });
            const projected = await resolvePluginContributes({ happyHomeDir,
                agentIdentity: { pluginId, localId: 'agent' },
                referenceGraph: { loadedPlugins: [], diagnosticsByPluginId: {} },
            });
            expect(projected.pluginDiagnosticsByPluginId?.[pluginId]).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: 'plugin_manifest_invalid', stage: 'normalization' }),
            ]));
            expect(projected.activationTargets).toEqual([]);
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('settles unavailable Account intent without enabling contributions or failing the host', async () => {
        const app = fastify();
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async (_request, reply) => (
            reply.code(503).send({ error: 'unavailable' })
        ));
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://bundled-intent-unavailable.test' });
        try {
            const facts = await readCurrentBundledPluginEnablement({ machineEnabledById: {},
                accountStorageDependencies: {
                    readCredentials: async () => ({ token: 'fixture', encryption: null }),
                    resolveBaseUrl: () => 'http://bundled-intent-unavailable.test',
                } });
            expect(facts['happier.agent.pi']).toMatchObject({ enabled: false, machineEnabled: true,
                unavailableCode: 'plugin_account_execution_unavailable' });
            expect(facts['happier.agent.pi']?.accountEnabled).toBeUndefined();
            const registry = getResolvedContributionRegistry({ pluginEnablementById: facts });
            expect(registry.agents).toEqual([]);
            expect(registry.unavailableAgentPluginsByBackendId?.pi?.code).toBe('plugin_account_execution_unavailable');
        } finally {
            restore();
            await app.close();
        }
    });
});
