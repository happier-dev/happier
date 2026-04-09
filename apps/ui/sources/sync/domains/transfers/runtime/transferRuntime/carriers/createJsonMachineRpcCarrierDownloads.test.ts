import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const directExportDownloadMock = vi.hoisted(() => vi.fn());
const relayJsonDownloadMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('../plumbing/directTransferExportDownload', () => ({
    downloadBulkJsonPayloadViaDirectExport: (...args: unknown[]) => directExportDownloadMock(...args),
}));

vi.mock('../plumbing/downloadBulkJsonPayloadViaServerRelay', () => ({
    downloadBulkJsonPayloadViaServerRelay: (...args: unknown[]) => relayJsonDownloadMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeMock(...args),
}));

describe('downloadJsonPayloadViaMachineTransferCarriers', () => {
    it('falls back to the relay carrier after direct export failure and wires scoped init/finalize rpc calls', async () => {
        directExportDownloadMock.mockResolvedValueOnce({
            ok: false,
            error: 'Direct export unavailable',
        });
        relayJsonDownloadMock.mockImplementationOnce(async (params: {
            init: (request: { recipientPublicKeyBase64: string }) => Promise<unknown>;
            finalize: (request: { downloadId: string }) => Promise<unknown>;
        }) => {
            await params.init({ recipientPublicKeyBase64: 'recipient-public-key' });
            await params.finalize({ downloadId: 'json-download-1' });
            return {
                ok: true,
                payload: { ok: true },
            };
        });
        machineRpcWithServerScopeMock.mockImplementation(async (params: any) => {
            if (params.method === RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'json-download-1',
                    chunkSizeBytes: 1024,
                    sizeBytes: 15,
                    name: 'asset.json',
                };
            }
            if (params.method === RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (params.method === RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected method: ${params.method}`);
        });

        const { downloadJsonPayloadViaMachineTransferCarriers } = await import('./createJsonMachineRpcCarrierDownloads');
        const result = await downloadJsonPayloadViaMachineTransferCarriers({
            machineId: 'machine-1',
            serverId: 'server-a',
            preferScoped: true,
            payloadWithRecipient: (recipientPublicKeyBase64: string) => ({
                t: 'prompt_asset_download_v1',
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { name: 'skill-a' },
                recipientPublicKeyBase64,
            }),
            initMethod: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
            chunkMethod: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
            finalizeMethod: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
            abortMethod: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT,
            directExportRequest: {
                t: 'prompt_asset_download_v1',
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { name: 'skill-a' },
            },
            parsePayload: (value) => {
                const candidate = value as { ok?: boolean };
                return candidate.ok === true ? candidate : null;
            },
        });

        expect(result).toEqual({
            ok: true,
            payload: { ok: true },
        });
        expect(directExportDownloadMock).toHaveBeenCalledTimes(1);
        expect(relayJsonDownloadMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            preferScoped: true,
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
            payload: {
                t: 'prompt_asset_download_v1',
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { name: 'skill-a' },
                recipientPublicKeyBase64: 'recipient-public-key',
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            preferScoped: true,
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
            payload: {
                downloadId: 'json-download-1',
            },
        }));
    });

    it('falls back to chunk rpc after direct export and relay failures', async () => {
        directExportDownloadMock.mockResolvedValueOnce({
            ok: false,
            error: 'Direct export unavailable',
        });
        relayJsonDownloadMock.mockResolvedValueOnce({
            ok: false,
            error: 'Relay unavailable',
        });
        machineRpcWithServerScopeMock.mockImplementation(async (params: any) => {
            if (params.method === RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'json-download-2',
                    chunkSizeBytes: 1024,
                    sizeBytes: 11,
                    name: 'asset.json',
                };
            }
            if (params.method === RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK) {
                return {
                    success: true,
                    isLast: true,
                    contentBase64: Buffer.from(JSON.stringify({ ok: true })).toString('base64'),
                };
            }
            if (params.method === RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (params.method === RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`unexpected method: ${params.method}`);
        });

        const { downloadJsonPayloadViaMachineTransferCarriers } = await import('./createJsonMachineRpcCarrierDownloads');
        const result = await downloadJsonPayloadViaMachineTransferCarriers({
            machineId: 'machine-1',
            serverId: 'server-a',
            preferScoped: true,
            payloadWithRecipient: (recipientPublicKeyBase64: string) => ({
                t: 'prompt_asset_download_v1',
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { name: 'skill-a' },
                recipientPublicKeyBase64,
            }),
            initMethod: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
            chunkMethod: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
            finalizeMethod: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
            abortMethod: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT,
            directExportRequest: {
                t: 'prompt_asset_download_v1',
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { name: 'skill-a' },
            },
            parsePayload: (value) => {
                const candidate = value as { ok?: boolean };
                return candidate.ok === true ? candidate : null;
            },
        });

        expect(result).toEqual({
            ok: true,
            payload: { ok: true },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
            payload: {
                downloadId: 'json-download-2',
                index: 0,
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
            payload: {
                downloadId: 'json-download-2',
            },
        }));
    });
});
