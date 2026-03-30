import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { FeaturesResponse } from '@happier-dev/protocol';
import type { TransferRouteViabilityRecord } from '@happier-dev/transfers';

let policyConsulted = false;

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const getReadyServerFeaturesMock = vi.hoisted(() =>
    vi.fn(async (_params: unknown): Promise<FeaturesResponse | null> => {
        policyConsulted = true;
        return {
            features: {
                machines: {
                    enabled: true,
                    transfer: {
                        enabled: true,
                        serverRouted: {
                            enabled: true,
                        },
                    },
                },
            },
            capabilities: {},
        } as FeaturesResponse;
    }),
);
const readCachedMachineRpcDirectRouteMock = vi.hoisted(() =>
    vi.fn((_input: unknown): TransferRouteViabilityRecord => ({ status: 'unknown' })),
);
const downloadBulkJsonPayloadMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (params: unknown) => getReadyServerFeaturesMock(params),
}));

vi.mock('@/sync/domains/transfers/runtime/transferRouteCache', () => ({
    readCachedMachineRpcDirectRoute: (input: Readonly<{ serverId?: string | null; remoteMachineId: string }>) =>
        readCachedMachineRpcDirectRouteMock(input),
    recordCachedMachineRpcDirectRouteUnavailable: () => {},
    recordCachedMachineRpcDirectRouteViable: () => {},
    readCachedDirectPeerRoute: () => ({ status: 'unknown' }),
    recordCachedDirectPeerRouteUnavailable: () => {},
    recordCachedDirectPeerRouteViable: () => {},
}));

vi.mock('@/sync/domains/transfers/runtime/bulkTransferPipeline/downloadBulkJsonPayload', () => ({
    downloadBulkJsonPayload: downloadBulkJsonPayloadMock,
}));

describe('machine prompt registries ops (server-scoped routing)', () => {
    beforeEach(() => {
        policyConsulted = false;
        machineRpcWithServerScopeMock.mockReset();
        getReadyServerFeaturesMock.mockClear();
        readCachedMachineRpcDirectRouteMock.mockReset();
        readCachedMachineRpcDirectRouteMock.mockReturnValue({ status: 'unknown' });
        downloadBulkJsonPayloadMock.mockReset();
    });

    it('routes prompt registry adapter listing through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, adapters: [] });
        const { machinePromptRegistriesListAdapters } = await import('./machinePromptRegistries');

        const result = await machinePromptRegistriesListAdapters('machine-1', { serverId: 'server-a' });

        expect(result).toEqual({ ok: true, adapters: [] });
        expect(policyConsulted).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS,
            payload: undefined,
            preferScoped: false,
        }));
    });

    it('routes prompt registry source listing through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, sources: [] });
        const { machinePromptRegistriesListSources } = await import('./machinePromptRegistries');

        const result = await machinePromptRegistriesListSources(
            'machine-1',
            { configuredSources: [] },
            { serverId: 'server-a' },
        );

        expect(result).toEqual({ ok: true, sources: [] });
        expect(policyConsulted).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES,
            payload: expect.objectContaining({ configuredSources: [] }),
            preferScoped: false,
        }));
    });

    it('routes prompt registry scan through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, items: [] });
        const { machinePromptRegistriesScanSource } = await import('./machinePromptRegistries');

        const result = await machinePromptRegistriesScanSource(
            'machine-1',
            { sourceId: 'skills_sh:featured', configuredSources: [] },
            { serverId: 'server-a' },
        );

        expect(result).toEqual({ ok: true, items: [] });
        expect(policyConsulted).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE,
            payload: expect.objectContaining({ sourceId: 'skills_sh:featured', configuredSources: [] }),
            preferScoped: false,
        }));
    });

    it('routes prompt registry installation through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true });
        const { machinePromptRegistriesInstall } = await import('./machinePromptRegistries');

        const result = await machinePromptRegistriesInstall(
            'machine-1',
            {
                sourceId: 'skills_sh:featured',
                itemId: 'skills_sh:featured:item-1',
                configuredSources: [],
                installTarget: {
                    assetTypeId: 'agents.skill',
                    scope: 'user',
                    directory: '/tmp/project',
                    targetName: 'frontend-design',
                },
            },
            { serverId: 'server-a' },
        );

        expect(result).toEqual({ ok: true });
        expect(policyConsulted).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL,
            payload: expect.objectContaining({ sourceId: 'skills_sh:featured', itemId: 'skills_sh:featured:item-1' }),
            preferScoped: false,
        }));
    });

    it('fails closed when prompt registry download init returns an unsupported response envelope', async () => {
        readCachedMachineRpcDirectRouteMock.mockReturnValueOnce({
            status: 'unavailable',
            checkedAt: 1,
            expiresAt: 2,
            failureReason: 'unavailable',
        });

        machineRpcWithServerScopeMock.mockResolvedValueOnce({}); // missing `{ success: boolean }`

        const payload = {
            sourceId: 'skills_sh:featured',
            itemId: 'skills_sh:featured:item-1',
            title: 'frontend-design',
            description: 'anthropics/skills',
            bundleSchemaId: 'skills.skill_md_v1',
            bundleBody: {
                v: 1,
                entries: [],
                createdAtMs: 1,
                updatedAtMs: 1,
            },
        };

        downloadBulkJsonPayloadMock.mockImplementationOnce(async (args: Readonly<{
            init: (request: Readonly<{ recipientPublicKeyBase64: string }>) => Promise<unknown>;
            readChunk: (request: Readonly<{ downloadId: string; index: number }>) => Promise<unknown>;
            finalize: (request: Readonly<{ downloadId: string }>) => Promise<unknown>;
            parsePayload: (value: unknown) => unknown | null;
        }>) => {
            await args.init({ recipientPublicKeyBase64: 'recipient-public-key' });
            return {
                ok: true,
                payload: args.parsePayload(payload)!,
            } as const;
        });

        const { machinePromptRegistriesDownloadItem } = await import('./machinePromptRegistries');

        await expect(machinePromptRegistriesDownloadItem(
            'machine-1',
            {
                sourceId: 'skills_sh:featured',
                itemId: 'skills_sh:featured:item-1',
                configuredSources: [],
                },
            { serverId: 'server-a' },
        )).rejects.toThrow('RPC call returned an unsupported response');
    });

    it('downloads fetched registry item payloads through the canonical bulk transfer pipeline', async () => {
        readCachedMachineRpcDirectRouteMock.mockReturnValueOnce({
            status: 'unavailable',
            checkedAt: 1,
            expiresAt: 2,
            failureReason: 'unavailable',
        });
        const payload = {
            sourceId: 'skills_sh:featured',
            itemId: 'skills_sh:featured:item-1',
            title: 'frontend-design',
            description: 'anthropics/skills',
            bundleSchemaId: 'skills.skill_md_v1',
            bundleBody: {
                v: 1,
                entries: [],
                createdAtMs: 1,
                updatedAtMs: 1,
            },
        };
        machineRpcWithServerScopeMock.mockImplementation(async (args: { method?: string }) => {
            switch (args.method) {
                case RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT:
                    return {
                        success: true,
                        downloadId: 'download-1',
                        chunkSizeBytes: 4096,
                        sizeBytes: 1,
                        name: 'prompt-registry-item',
                    };
                case RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_CHUNK:
                    return {
                        success: true,
                        contentBase64: 'e30K',
                        isLast: true,
                    };
                case RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_FINALIZE:
                    return {
                        success: true,
                    };
                default:
                    return { success: false, error: 'unexpected method' };
            }
        });
        downloadBulkJsonPayloadMock.mockImplementationOnce(async (args: Readonly<{
            init: (request: Readonly<{ recipientPublicKeyBase64: string }>) => Promise<unknown>;
            readChunk: (request: Readonly<{ downloadId: string; index: number }>) => Promise<unknown>;
            finalize: (request: Readonly<{ downloadId: string }>) => Promise<unknown>;
            parsePayload: (value: unknown) => unknown | null;
        }>) => {
            await args.init({ recipientPublicKeyBase64: 'recipient-public-key' });
            await args.readChunk({ downloadId: 'download-1', index: 0 });
            await args.finalize({ downloadId: 'download-1' });
            const parsedPayload = args.parsePayload(payload);
            if (parsedPayload === null) {
                return {
                    ok: false,
                    error: 'Downloaded transfer payload returned an unsupported response',
                } as const;
            }
            return {
                ok: true,
                payload: parsedPayload,
            } as const;
        });

        const { machinePromptRegistriesDownloadItem } = await import('./machinePromptRegistries');

        const result = await machinePromptRegistriesDownloadItem(
            'machine-1',
            {
                sourceId: 'skills_sh:featured',
                itemId: 'skills_sh:featured:item-1',
                configuredSources: [],
            },
            { serverId: 'server-a' },
        );

        expect(result).toEqual({
            ok: true,
            item: payload,
        });
        expect(downloadBulkJsonPayloadMock).toHaveBeenCalledTimes(1);
        expect(downloadBulkJsonPayloadMock).toHaveBeenCalledWith(expect.objectContaining({
            init: expect.any(Function),
            readChunk: expect.any(Function),
            finalize: expect.any(Function),
            parsePayload: expect.any(Function),
        }));
        expect(getReadyServerFeaturesMock).toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT,
            preferScoped: true,
            payload: expect.objectContaining({
                sourceId: 'skills_sh:featured',
                itemId: 'skills_sh:featured:item-1',
                configuredSources: [],
                recipientPublicKeyBase64: 'recipient-public-key',
            }),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_CHUNK,
            payload: { downloadId: 'download-1', index: 0 },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_FINALIZE,
            payload: { downloadId: 'download-1' },
        }));
    });
});
