import { describe, expect, it } from 'vitest';

import { resolveAgentCatalogProjection } from './agentCatalogProjection';

describe('bundled Agent declarations without a machine projection', () => {
    it('exposes admitted identity and qualified account purposes without asserting a runtime generation', () => {
        const entry = resolveAgentCatalogProjection('claude', { enabledAgentIds: [] });

        expect(entry.identity).toEqual({ pluginId: 'happier.agent.claude', localId: 'claude' });
        expect(entry.connectedAccounts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
            }),
        ]));
        expect(entry.cli?.executable.binaryName).toBe('claude');
        expect(entry.projectionGeneration).toBeNull();
        expect(entry.installedPackage).toBeNull();
    });

    it('does not lend bundled declarations to a colliding external Agent or a missing dynamic contribution', () => {
        const external = resolveAgentCatalogProjection('claude', {
            enabledAgentIds: [],
            mergedProviderProjectionById: {
                claude: { agentId: 'claude', isBuiltIn: false, identity: { pluginId: 'acme.agent', localId: 'claude' } },
            },
        });
        expect(external.connectedAccounts).toEqual([]);
        expect(external.cli).toBeNull();
        const missing = resolveAgentCatalogProjection('acme.agent/claude', { enabledAgentIds: [] });
        expect(missing.identity).toBeNull();
        expect(missing.connectedAccounts).toEqual([]);
        expect(missing.cli).toBeNull();
    });

    it('keeps a current daemon row authoritative when it removes bundled declarative facts', () => {
        const entry = resolveAgentCatalogProjection('claude', {
            enabledAgentIds: [],
            mergedProviderProjectionById: {
                claude: {
                    agentId: 'claude',
                    isBuiltIn: true,
                    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
                    projectionGeneration: 7,
                    cli: null,
                    connectedAccounts: [],
                },
            },
        });
        expect(entry.connectedAccounts).toEqual([]);
        expect(entry.cli).toBeNull();
        expect(entry.projectionGeneration).toBe(7);
    });
});
