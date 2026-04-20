import { afterEach, describe, expect, it, vi } from 'vitest';

import { readPluginMarketplaceCatalog } from './readPluginMarketplaceCatalog';

describe('readPluginMarketplaceCatalog', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('maps protocol marketplace entries to manifest ids for plugin actions', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                t: 'happier_plugin_marketplace_catalog_v1',
                schemaVersion: 1,
                sourceUrl: 'https://marketplace.example.test/catalog.json',
                title: 'Protocol catalog',
                description: 'Protocol-backed marketplace entries',
                entries: [
                    {
                        id: 'marketplace.sample-plugin',
                        manifestId: 'sample-plugin',
                        title: 'Sample Plugin',
                        description: 'Protocol marketplace entry',
                        version: '1.2.3',
                        sourceUrl: 'https://marketplace.example.test/entries/sample-plugin.json',
                        packageUrl: 'https://marketplace.example.test/plugins/sample-plugin.tgz',
                        categories: ['plugins'],
                    },
                ],
            }),
        }) as Response));

        await expect(readPluginMarketplaceCatalog('https://marketplace.example.test/catalog.json')).resolves.toEqual({
            sourceUrl: 'https://marketplace.example.test/catalog.json',
            title: 'Protocol catalog',
            description: 'Protocol-backed marketplace entries',
            entries: [
                {
                    id: 'sample-plugin',
                    title: 'Sample Plugin',
                    description: 'Protocol marketplace entry',
                    version: '1.2.3',
                },
            ],
        });
    });

    it('rejects stale manifest-shaped catalog entries that the install pipeline cannot consume', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                t: 'happier_plugin_marketplace_catalog_v1',
                schemaVersion: 1,
                sourceUrl: 'https://marketplace.example.test/catalog.json',
                title: 'Stale catalog',
                entries: [
                    {
                        schemaVersion: 1,
                        id: 'sample-plugin',
                        displayName: 'Sample Plugin',
                        description: 'Old manifest-like entry',
                        version: '1.0.0',
                        source: {
                            kind: 'archive',
                            locator: 'https://marketplace.example.test/plugins/sample-plugin.tgz',
                            trustPolicy: 'local_trusted',
                            installPolicy: 'managed_install',
                        },
                    },
                ],
            }),
        }) as Response));

        await expect(readPluginMarketplaceCatalog('https://marketplace.example.test/catalog.json')).rejects.toThrow(
            'Plugin catalog from https://marketplace.example.test/catalog.json is invalid',
        );
    });
});
