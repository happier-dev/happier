import { describe, expect, it, vi } from 'vitest';

const agentsPackageState = vi.hoisted(() => ({
    AGENT_IDS: ['claude', 'codex', 'gemini'] as const,
    CANONICAL_AGENT_IDS: ['claude', 'codex', 'gemini'] as const,
    getAgentCatalogDefinition: vi.fn(),
}));

// Intentionally omit getAllAgentCatalogDefinitions to mirror minimal mocks used elsewhere in the UI test suite.
vi.mock('@happier-dev/agents', () => ({
    ...agentsPackageState,
}));

describe('agentUniverse', () => {
    it('keeps the provider backend target key canonical when a provider declares a settings backend id', async () => {
        agentsPackageState.getAgentCatalogDefinition.mockReturnValue({
            id: 'antigravity',
            settingsBackendId: 'antigravity-localharness',
        });

        vi.resetModules();
        const { buildAgentUniverseBackendTargetKey } = await import('./agentUniverse');

        expect(buildAgentUniverseBackendTargetKey('antigravity')).toBe('backend:antigravity');
    });

    it('falls back to AGENT_IDS when getAllAgentCatalogDefinitions is unavailable', async () => {
        vi.resetModules();
        const { listAgentUniverseIds } = await import('./agentUniverse');

        expect(listAgentUniverseIds()).toEqual([...agentsPackageState.AGENT_IDS]);
    });
});
