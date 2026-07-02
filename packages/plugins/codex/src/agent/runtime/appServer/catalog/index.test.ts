import { describe, expect, it } from 'vitest';

import {
    listCodexAppServerSkills,
    listCodexVendorPlugins,
    type CodexAppServerCatalogClient,
} from './index';

function createCatalogClient(response: unknown): Readonly<{
    client: CodexAppServerCatalogClient;
    requests: Array<Readonly<{ method: string; params: unknown }>>;
}> {
    const requests: Array<Readonly<{ method: string; params: unknown }>> = [];
    return {
        requests,
        client: {
            request: async (method, params) => {
                requests.push({ method, params });
                if (response instanceof Error) throw response;
                return response;
            },
        },
    };
}

describe('Codex app-server catalog mapping', () => {
    it('maps marketplace plugin responses into canonical vendor plugin catalog items', async () => {
        const { client, requests } = createCatalogClient({
            marketplaces: [
                {
                    name: 'openai-curated',
                    plugins: [
                        {
                            name: 'gmail',
                            interface: {
                                displayName: 'Gmail',
                                shortDescription: 'Mail access',
                            },
                            installed: true,
                            enabled: true,
                        },
                        {
                            name: 'gmail',
                            vendorPluginRef: 'plugin://gmail@openai-curated',
                            installed: false,
                            enabled: false,
                        },
                    ],
                },
            ],
        });

        const result = await listCodexVendorPlugins({ client, cwd: '/repo' });

        expect(requests).toEqual([{ method: 'plugin/list', params: { cwds: ['/repo'] } }]);
        expect(result.supported).toBe(true);
        expect(result.vendorPlugins).toEqual([
            expect.objectContaining({
                v: 1,
                backendId: 'codex',
                name: 'gmail',
                displayName: 'Gmail',
                description: 'Mail access',
                vendorPluginRef: 'plugin://gmail@openai-curated',
                marketplaceId: 'openai-curated',
                installed: true,
                enabled: true,
                mentionable: true,
            }),
        ]);
        expect(result.catalog?.items).toEqual(result.vendorPlugins);
    });

    it('maps nested skill responses into canonical skill catalog items', async () => {
        const { client, requests } = createCatalogClient({
            data: [
                {
                    skills: [
                        {
                            name: 'review',
                            location: '/skills/review/SKILL.md',
                            interface: {
                                displayName: 'Review',
                                shortDescription: 'Review code',
                            },
                            enabled: false,
                        },
                        {
                            name: 'review',
                            path: '/skills/review/SKILL.md',
                            enabled: true,
                        },
                    ],
                },
            ],
        });

        const result = await listCodexAppServerSkills({ client, cwd: '/repo' });

        expect(requests).toEqual([{ method: 'skills/list', params: { cwds: ['/repo'] } }]);
        expect(result.supported).toBe(true);
        expect(result.skills).toEqual([
            expect.objectContaining({
                v: 1,
                id: 'vendor:codex:review',
                origin: 'vendor',
                name: 'review',
                backendId: 'codex',
                path: '/skills/review/SKILL.md',
                enabled: true,
            }),
        ]);
        expect(result.catalog?.items).toEqual(result.skills);
    });

    it('reports unsupported catalog methods when Codex app-server lacks them', async () => {
        const methodNotFound = new Error('Method not found');
        Object.defineProperty(methodNotFound, 'code', { value: -32601, enumerable: true });
        const { client } = createCatalogClient(methodNotFound);

        await expect(listCodexVendorPlugins({ client, cwd: '/repo' })).resolves.toMatchObject({
            supported: false,
            vendorPlugins: [],
            diagnostic: 'Method not found',
        });
        await expect(listCodexAppServerSkills({ client, cwd: '/repo' })).resolves.toMatchObject({
            supported: false,
            skills: [],
            diagnostic: 'Method not found',
        });
    });
});
