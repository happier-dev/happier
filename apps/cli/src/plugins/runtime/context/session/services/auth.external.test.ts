import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceProviderRuntimeAuthAdapter } from '@/daemon/connectedServices/runtimeAuth/types';

const { readAgentCatalogSnapshot } = vi.hoisted(() => ({
    readAgentCatalogSnapshot: vi.fn(),
}));

vi.mock('@/agent/catalog/snapshot', () => ({
    readAgentCatalogSnapshot,
}));

import { createSessionHandleAuthService } from './auth';

function createRuntimeAuthAdapter(
    refreshActiveProfile: ConnectedServiceProviderRuntimeAuthAdapter['refreshActiveProfile'],
): ConnectedServiceProviderRuntimeAuthAdapter {
    return {
        classifyRuntimeAuthFailure: () => null,
        materializeActiveProfile: async () => ({}),
        canHotApply: () => ({}),
        hotApply: async () => ({}),
        recoverAfterRuntimeAuthSwitch: async () => ({}),
        probeQuota: async () => ({}),
        refreshActiveProfile,
    };
}

describe('session runtime auth for an external Agent', () => {
    beforeEach(() => {
        readAgentCatalogSnapshot.mockReturnValue({
            agentDefinitionsById: new Map([
                ['acme.agent', {
                    id: 'acme.agent',
                    identity: { pluginId: 'acme.plugin', localId: 'acme.agent' },
                }],
            ]),
            catalogEntriesById: {
                'acme.agent': {
                    id: 'acme.agent',
                    cliSubcommand: 'acme-agent',
                },
            },
        });
    });

    it('uses the current installed catalog Agent instead of the bundled census', async () => {
        const refreshActiveProfile = vi.fn(async () => ({
            status: 'refreshed' as const,
            result: { accessToken: 'fresh' },
        }));
        const resolveAdapter = vi.fn(async () => createRuntimeAuthAdapter(refreshActiveProfile));
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'acme.agent',
            resolveAdapter,
        });

        await expect(auth.services.refreshRuntimeAuth({
            serviceId: 'acme-service',
            selection: { kind: 'profile', profileId: 'work' },
        })).resolves.toEqual({
            status: 'refreshed',
            result: { accessToken: 'fresh' },
        });

        expect(resolveAdapter).toHaveBeenCalledWith('acme.agent');
        expect(refreshActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
            target: { agentId: 'acme.agent' },
        }));
    });
});
