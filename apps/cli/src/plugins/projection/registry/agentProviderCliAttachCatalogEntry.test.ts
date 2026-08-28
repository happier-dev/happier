import { describe, expect, it, vi } from 'vitest';

import { projectAgentProviderCliAttachCatalogEntry } from './agentCatalogEntryHooks';

describe('Agent provider CLI attach catalog projection', () => {
    it('binds the host fallback reader to the exact plugin contribution and Session', async () => {
        const resolveManagedServiceSessionBaseUrl = vi.fn(async () => (
            'http://127.0.0.1:49197'
        ));
        const hooks = projectAgentProviderCliAttachCatalogEntry({
            agentId: 'opencode',
            pluginId: 'happier.agent.opencode',
            localAgentId: 'opencode',
            resolveManagedServiceSessionBaseUrl,
            providerCliAttach: {
                resolveTarget: ({ fallbackServerBaseUrl }) => {
                    const baseUrl = fallbackServerBaseUrl;
                    return baseUrl
                        ? { ok: true, value: { baseUrl } }
                        : { ok: false, reason: 'missing server URL' };
                },
                createArgs: (target) => ['attach', target.baseUrl],
                buildHealthUrl: () => null,
            },
        });
        const attach = (await hooks.resolveHostAgentRuntimeSurfaces?.())?.attach;

        await expect(attach?.evaluateAvailability?.({
            operation: 'attach',
            sessionId: 'happier-session',
            metadata: {},
            depth: 'metadata',
            hasLocalAttachmentInfo: true,
        })).resolves.toEqual({ available: true });
        expect(resolveManagedServiceSessionBaseUrl).toHaveBeenCalledWith({
            pluginId: 'happier.agent.opencode',
            sessionId: 'happier-session',
            contributionId: 'happier.agent.opencode/agents/opencode',
        });
    });
});
