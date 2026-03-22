import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { TransferRouteViabilityRecord } from '@happier-dev/transfers';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const readCachedMachineRpcDirectRouteMock = vi.hoisted(() =>
    vi.fn((_input: unknown): TransferRouteViabilityRecord => ({ status: 'unknown' })),
);
const downloadBulkJsonPayloadMock = vi.hoisted(() => vi.fn());
const uploadBulkJsonPayloadMock = vi.hoisted(() => vi.fn());

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
    uploadBulkJsonPayload: uploadBulkJsonPayloadMock,
}));

describe('machine prompt assets ops (server-scoped routing)', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        readCachedMachineRpcDirectRouteMock.mockReset();
        readCachedMachineRpcDirectRouteMock.mockReturnValue({ status: 'unknown' });
        downloadBulkJsonPayloadMock.mockReset();
        uploadBulkJsonPayloadMock.mockReset();
    });

    it('routes prompt asset type listing through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, types: [] });
        const { machinePromptAssetsListTypes } = await import('./machinePromptAssets');

        const res = await machinePromptAssetsListTypes('machine-1', { serverId: 'server-a' });

        expect(res).toEqual({ ok: true, types: [] });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES,
            payload: undefined,
        }));
    });

    it('routes prompt asset discovery through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, items: [] });
        const { machinePromptAssetsDiscover } = await import('./machinePromptAssets');

        const res = await machinePromptAssetsDiscover(
            'machine-1',
            { assetTypeId: 'agents.skill', scope: 'project', directory: '/tmp/project' },
            { serverId: 'server-a' },
        );

        expect(res).toEqual({ ok: true, items: [] });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER,
            payload: expect.objectContaining({ assetTypeId: 'agents.skill', scope: 'project', directory: '/tmp/project' }),
        }));
    });

    it('downloads prompt asset payloads through the canonical bulk pipeline', async () => {
        readCachedMachineRpcDirectRouteMock.mockReturnValueOnce({
            status: 'unavailable',
            checkedAt: 1,
            expiresAt: 2,
            failureReason: 'unavailable',
        });
        const payload = {
            assetTypeId: 'agents.skill',
            scope: 'user',
            externalRef: { name: 'skill-a' },
            title: 'Skill A',
            libraryKind: 'bundle',
            bundleSchemaId: 'skills.skill_md_v1',
            digest: 'digest-a',
            displayPath: '~/.agents/skills/skill-a',
            bundleBody: {
                v: 1,
                entries: [],
                createdAtMs: 1,
                updatedAtMs: 1,
            },
        };
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                success: true,
                downloadId: 'download-1',
                chunkSizeBytes: 4096,
                sizeBytes: 10,
                name: 'payload.json',
            })
            .mockResolvedValueOnce({
                success: true,
                payloadBase64: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
                encryptedDataKeyEnvelopeBase64: Buffer.from('envelope', 'utf8').toString('base64'),
                isLast: true,
            })
            .mockResolvedValueOnce({
                success: true,
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
        const { machinePromptAssetsDownload } = await import('./machinePromptAssets');

        const res = await machinePromptAssetsDownload(
            'machine-1',
            { assetTypeId: 'agents.skill', scope: 'user', externalRef: { name: 'skill-a' } },
            { serverId: 'server-a' },
        );

        expect(res).toEqual({ ok: true, item: payload });
        expect(downloadBulkJsonPayloadMock).toHaveBeenCalledWith(expect.objectContaining({
            init: expect.any(Function),
            readChunk: expect.any(Function),
            finalize: expect.any(Function),
            parsePayload: expect.any(Function),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
            preferScoped: true,
        }));
    });

    it('uploads prompt asset writes through the canonical bulk pipeline', async () => {
        const bundleBody = {
            v: 1 as const,
            entries: [],
            createdAtMs: 1,
            updatedAtMs: 1,
        };
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                success: true,
                uploadId: 'upload-1',
                chunkSizeBytes: 4096,
                recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            })
            .mockResolvedValueOnce({
                success: true,
            })
            .mockResolvedValueOnce({
                success: true,
                response: {
                    ok: true,
                    externalRef: { skillName: 'writer' },
                    digest: 'digest-a',
                },
            });
        uploadBulkJsonPayloadMock.mockResolvedValueOnce({
            ok: true as const,
            response: {
                ok: true,
                externalRef: { skillName: 'writer' },
                digest: 'digest-a',
            },
        });
        const { machinePromptAssetsWrite } = await import('./machinePromptAssets');

        const res = await machinePromptAssetsWrite(
            'machine-1',
            {
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: null,
                targetName: 'writer',
                title: 'Writer',
                bundleSchemaId: 'skills.skill_md_v1',
                bundleBody,
                previewOnly: false,
                expectedDigest: null,
            },
            { serverId: 'server-a' },
        );

        expect(res).toEqual({
            ok: true,
            externalRef: { skillName: 'writer' },
            digest: 'digest-a',
        });
        expect(uploadBulkJsonPayloadMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: {
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: null,
                targetName: 'writer',
                title: 'Writer',
                bundleSchemaId: 'skills.skill_md_v1',
                bundleBody,
                previewOnly: false,
                expectedDigest: null,
            },
            init: expect.any(Function),
            sendChunk: expect.any(Function),
            finalize: expect.any(Function),
            parseResponse: expect.any(Function),
        }));
    });
});
