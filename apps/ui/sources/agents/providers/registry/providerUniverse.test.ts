import { describe, expect, it, vi } from 'vitest';

const agentsPackageState = vi.hoisted(() => ({
    AGENT_IDS: ['claude', 'codex', 'gemini'] as const,
    CANONICAL_AGENT_IDS: ['claude', 'codex', 'gemini'] as const,
}));

// Intentionally omit getAllProviderDefinitions to mirror minimal mocks used elsewhere in the UI test suite.
vi.mock('@happier-dev/agents', () => ({
    ...agentsPackageState,
}));

describe('providerUniverse', () => {
    it('falls back to AGENT_IDS when getAllProviderDefinitions is unavailable', async () => {
        vi.resetModules();
        const { listProviderUniverseIds } = await import('./providerUniverse');

        expect(listProviderUniverseIds()).toEqual([...agentsPackageState.AGENT_IDS]);
    });
});
