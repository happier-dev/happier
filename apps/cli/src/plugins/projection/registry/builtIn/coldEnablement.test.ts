import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBundledPluginEnablement } from './enablement';
import { loadEnabledBundledPluginLocatorResult } from './locators';
import { getResolvedContributionRegistry } from './snapshot';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../sources/generatedBundledPluginManifests';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

afterEach(() => vi.restoreAllMocks());

describe('cold bundled enablement', () => {
    it('prunes only a dependent contribution and reacquires the disabled producer once on re-enable', () => {
        const producerId = 'happier.agent.codex';
        const consumerId = 'happier.language.markdown';
        const root = fs.mkdtempSync(join(tmpdir(), 'happier-cold-enablement-'));
        const executable = Object.getOwnPropertyDescriptor(process, 'execPath')!;
        try {
            fs.writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
            for (const pluginId of [producerId, consumerId]) {
                const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(locator => locator.pluginId === pluginId)!;
                if (!('manifestRelativePath' in locator)) throw new Error('Expected a file-backed bundled declaration');
                const path = join(root, locator.manifestRelativePath);
                fs.mkdirSync(dirname(path), { recursive: true });
                fs.writeFileSync(path, JSON.stringify(createPluginManifestV2Fixture({ id: pluginId,
                    entrypoints: locator.daemonEntryPath ? { daemon: './daemon.mjs' } : {},
                    contributes: pluginId === producerId ? { actions: [{ id: 'run', title: 'Run',
                        scopes: ['session'], surfaces: ['agent'], execution: { target: 'daemon' },
                        placementBindings: ['secondary'], dangerLevel: 'safe' }] }
                        : { browserTargets: [{ id: 'page', title: 'Page', url: 'https://example.com' }],
                            browserActions: [{ id: 'runner', title: 'Runner', target: 'page',
                                action: { pluginId: producerId, localId: 'run' } }] },
                })));
            }
            Object.defineProperty(process, 'execPath', { ...executable, value: join(root, 'happier') });
            const reads = vi.spyOn(fs, 'readFileSync');
            const load = (enabled: boolean, pluginIds = [producerId, consumerId]) => loadEnabledBundledPluginLocatorResult({
                pluginIds, pluginEnablementById: resolveBundledPluginEnablement({
                    pluginIds: BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.map(locator => locator.pluginId),
                    machineEnabledById: Object.fromEntries(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.map(locator =>
                        [locator.pluginId, locator.pluginId === producerId ? enabled : locator.pluginId === consumerId])),
                }),
            });
            const disabled = load(false);
            expect(disabled.loadedPlugins.map(plugin => plugin.pluginId)).toEqual([consumerId]);
            expect(disabled.loadedPlugins[0]?.manifest.contributes.browserTargets).toHaveLength(1);
            expect(disabled.loadedPlugins[0]?.manifest.contributes.browserActions).toEqual([]);
            const producerReads = () => reads.mock.calls.filter(([path]) => String(path).endsWith('codex.json')).length;
            expect(producerReads()).toBe(0);
            const restored = load(true);
            expect(restored.pluginFailures).toEqual([]);
            expect(restored.admittedGraph.diagnosticsByPluginId).toEqual({});
            expect(restored.loadedPlugins.find(plugin => plugin.pluginId === consumerId)?.manifest.contributes.browserActions).toHaveLength(1);
            expect(producerReads()).toBe(1);
            const exact = load(true, [consumerId]);
            expect(exact.loadedPlugins.map(plugin => plugin.pluginId)).toEqual([consumerId]);
            expect(exact.loadedPlugins[0]?.manifest.contributes.browserActions).toHaveLength(1);
        } finally {
            Object.defineProperty(process, 'execPath', executable);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    it('loads only an exact enabled selection despite an unrelated withdrawal', async () => {
        const reads = vi.spyOn(fs, 'readFileSync');
        const result = loadEnabledBundledPluginLocatorResult({ pluginIds: ['happier.language.typescript'],
            pluginEnablementById: resolveBundledPluginEnablement({ pluginIds: ['happier.agent.pi'],
                machineEnabledById: { 'happier.agent.pi': false } }),
        });
        expect(result.loadedPlugins.map(plugin => plugin.pluginId)).toEqual(['happier.language.typescript']);
        const manifests = reads.mock.calls.filter(([path]) => String(path).includes('bundled-plugin-manifests'));
        expect(manifests.map(([path]) => String(path).split(/[\\/]/).at(-1))).toEqual(['lang-typescript.json']);
    });

    it('never loads a disabled Agent to build its typed unavailable row, and restores it on re-enable', async () => {
        const reads = vi.spyOn(fs, 'readFileSync');
        const facts = resolveBundledPluginEnablement({ pluginIds: ['happier.agent.pi'],
            accountEnabledById: new Map([['happier.agent.pi', false]]) });
        const disabled = getResolvedContributionRegistry({ pluginEnablementById: facts });
        const piLoads = () => reads.mock.calls.filter(([path]) => /bundled-plugin-manifests[\\/]pi\.json$/.test(String(path))).length;
        expect(piLoads()).toBe(0);
        expect(disabled.agents.some(agent => agent.pluginId === 'happier.agent.pi')).toBe(false);
        expect(disabled.unavailableAgentPluginsByBackendId?.pi).toMatchObject({ pluginId: 'happier.agent.pi', code: 'plugin_disabled' });
        const enabled = getResolvedContributionRegistry({ pluginEnablementById: resolveBundledPluginEnablement({ pluginIds: ['happier.agent.pi'] }) });
        expect(piLoads()).toBe(1);
        expect(enabled.agents.some(agent => agent.pluginId === 'happier.agent.pi')).toBe(true);
    });
});
