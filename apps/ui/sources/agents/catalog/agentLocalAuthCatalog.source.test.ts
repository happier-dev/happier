import { describe, expect, it, vi } from 'vitest';

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    isAgentId: (agentId: string) => agentId === 'codex',
}));

vi.mock('@/agents/catalog/localAuth/createCatalogAgentLocalAuthPlugin', () => ({
    createCatalogAgentLocalAuthPlugin: (agentId: string) => ({
        agentId,
        support: 'status_only',
        docsUrl: `https://example.com/${agentId}`,
    }),
}));

describe('provider local auth registry source', () => {
    it('still exposes built-in provider local auth plugins when the shared built-in id array is empty', async () => {
        const { getAgentLocalAuthPlugin } = await import('@/agents/catalog/localAuth/agentLocalAuthCatalog');

        expect(getAgentLocalAuthPlugin('codex')).toEqual({
            agentId: 'codex',
            support: 'status_only',
            docsUrl: 'https://example.com/codex',
        });
    });
});
