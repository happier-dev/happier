import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { TransferRouteViabilityRecord } from '@happier-dev/transfers';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const readCachedMachineRpcDirectRouteMock = vi.hoisted(() =>
    vi.fn((_input: unknown): TransferRouteViabilityRecord => ({ status: 'unknown' })),
);
const downloadBulkJsonPayloadMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
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

vi.mock('@/sync/domains/transfers/runtime/bulkTransferPipeline', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/transfers/runtime/bulkTransferPipeline')>()),
    downloadBulkJsonPayload: downloadBulkJsonPayloadMock,
}));

describe('machine prompt registries ops (server-scoped routing)', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        readCachedMachineRpcDirectRouteMock.mockReset();
        readCachedMachineRpcDirectRouteMock.mockReturnValue({ status: 'unknown' });
        downloadBulkJsonPayloadMock.mockReset();
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
