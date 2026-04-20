import { describe, expect, it, vi } from 'vitest';

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    isAgentId: (providerId: string) => providerId === 'codex',
}));

vi.mock('@/agents/providers/shared/createCatalogProviderLocalAuthPlugin', () => ({
    createCatalogProviderLocalAuthPlugin: (providerId: string) => ({
        providerId,
        support: 'status_only',
        docsUrl: `https://example.com/${providerId}`,
    }),
}));

describe('provider local auth registry source', () => {
    it('still exposes built-in provider local auth plugins when the shared built-in id array is empty', async () => {
        const { getProviderLocalAuthPlugin } = await import('@/agents/providers/catalog/providerLocalAuthCatalog');

        expect(getProviderLocalAuthPlugin('codex')).toEqual({
            providerId: 'codex',
            support: 'status_only',
            docsUrl: 'https://example.com/codex',
        });
    });
});
