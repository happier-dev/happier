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

    it('binds, rebinds, and unbinds the host-owned registry profile on the existing source record', async () => {
        const { upsertMachineMarketplaceSourceRegistrySource } = await import('./machineMarketplaceSources');
        const registry: MarketplaceSourceRegistryV1 = {
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [{
                id: 'marketplace:curated', title: 'Curated', sourceUrl: 'https://curated.example.test/catalog.json',
                enabled: true, origin: 'curated', addedAtMs: 1, updatedAtMs: 1,
            }],
        };
        const bound = upsertMachineMarketplaceSourceRegistrySource(registry, {
            sourceUrl: registry.sources[0]!.sourceUrl,
            registryProfileId: 'registry_one',
        }).registry;
        expect(bound.sources[0]).toMatchObject({ registryProfileId: 'registry_one' });
        const rebound = upsertMachineMarketplaceSourceRegistrySource(bound, {
            sourceUrl: registry.sources[0]!.sourceUrl,
            registryProfileId: 'registry_two',
        }).registry;
        expect(rebound.sources[0]).toMatchObject({ registryProfileId: 'registry_two' });
        const unbound = upsertMachineMarketplaceSourceRegistrySource(rebound, {
            sourceUrl: registry.sources[0]!.sourceUrl,
            registryProfileId: null,
        }).registry;
        expect(unbound.sources[0]).not.toHaveProperty('registryProfileId');
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

    it('validates marketplace query responses and follows the daemon cursor to completion', async () => {
        const { machineMarketplaceIndexQuery } = await import('./machineMarketplaceSources');
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ revision: 7, items: [], nextCursor: 'cursor-2', sources: [], diagnostics: [] })
            .mockResolvedValueOnce({ revision: 7, items: [], nextCursor: null, sources: [], diagnostics: [] });

        await expect(machineMarketplaceIndexQuery('machine-1', {
            text: '', cursor: null, limit: 100, filters: {},
        })).resolves.toEqual({ revision: 7, items: [], nextCursor: null, sources: [], diagnostics: [] });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            payload: expect.objectContaining({ cursor: 'cursor-2' }),
        }));

        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: false, errorCode: 'invalid_request' });
        await expect(machineMarketplaceIndexQuery('machine-1', {
            text: '', cursor: null, limit: 100, filters: {},
        })).rejects.toThrow(/marketplace index/i);
    });
});
