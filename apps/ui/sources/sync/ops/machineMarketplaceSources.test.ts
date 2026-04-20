import { afterEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { MarketplaceSourceRegistryV1 } from '@happier-dev/protocol';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeMock(...args),
}));

describe('machineMarketplaceSources', () => {
    afterEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('prefers enabled curated sources over user sources', async () => {
        const { resolvePreferredMachineMarketplaceSource } = await import('./machineMarketplaceSources');

        const registry: MarketplaceSourceRegistryV1 = {
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [
                {
                    id: 'marketplace:user',
                    title: 'User',
                    sourceUrl: 'https://user.example.test/catalog.json',
                    enabled: true,
                    origin: 'user',
                    addedAtMs: 1,
                    updatedAtMs: 1,
                },
                {
                    id: 'marketplace:curated',
                    title: 'Curated',
                    sourceUrl: 'https://curated.example.test/catalog.json',
                    enabled: true,
                    origin: 'curated',
                    addedAtMs: 1,
                    updatedAtMs: 1,
                },
            ],
        };

        expect(resolvePreferredMachineMarketplaceSource(registry)).toMatchObject({
            id: 'marketplace:curated',
            sourceUrl: 'https://curated.example.test/catalog.json',
        });
    });

    it('routes registry reads through the server scoped machine rpc', async () => {
        const { machineMarketplaceSourceRegistryGet } = await import('./machineMarketplaceSources');

        const registry: MarketplaceSourceRegistryV1 = {
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [],
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce(registry);

        await expect(machineMarketplaceSourceRegistryGet('machine-1', {
            serverId: 'server-a',
            timeoutMs: 2500,
        })).resolves.toEqual(registry);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            timeoutMs: 2500,
            method: RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_GET,
            payload: {},
        }));
    });

    it('routes registry writes through the server scoped machine rpc', async () => {
        const { machineMarketplaceSourceRegistrySet } = await import('./machineMarketplaceSources');

        const registry: MarketplaceSourceRegistryV1 = {
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [],
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce(registry);

        await expect(machineMarketplaceSourceRegistrySet('machine-1', registry, {
            serverId: 'server-a',
            timeoutMs: 2500,
        })).resolves.toEqual(registry);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            timeoutMs: 2500,
            method: RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_SET,
            payload: registry,
        }));
    });
});
