import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred } from '@/dev/testkit';

const createWorkspaceFileTransferRpcCallerMock = vi.hoisted(() => vi.fn());
const directExportDownloadMock = vi.hoisted(() => vi.fn());
const relayDownloadMock = vi.hoisted(() => vi.fn());
const bulkDownloadMock = vi.hoisted(() => vi.fn());
const createBufferedTransferDestinationMock = vi.hoisted(() => vi.fn());

vi.mock('../plumbing/directTransferExportDownload', () => ({
    downloadBulkPayloadViaDirectExportToDestination: (...args: unknown[]) => directExportDownloadMock(...args),
}));

vi.mock('../plumbing/downloadBulkPayloadViaServerRelayToDestination', () => ({
    downloadBulkPayloadViaServerRelayToDestination: (...args: unknown[]) => relayDownloadMock(...args),
}));

vi.mock('../carriers/downloadBulkPayloadViaMachineRpcToDestination', () => ({
    downloadBulkPayloadViaMachineRpcToDestination: (...args: unknown[]) => bulkDownloadMock(...args),
}));

vi.mock('./workspaceFileTransferRpcCaller', () => ({
    createWorkspaceFileTransferRpcCaller: (...args: unknown[]) => createWorkspaceFileTransferRpcCallerMock(...args),
}));

vi.mock('../carriers/createBufferedTransferDestination', () => ({
    createBufferedTransferDestination: (...args: unknown[]) => createBufferedTransferDestinationMock(...args),
}));

describe('workspaceFileTransfers', () => {
    beforeEach(() => {
        createWorkspaceFileTransferRpcCallerMock.mockReset();
        directExportDownloadMock.mockReset();
        relayDownloadMock.mockReset();
        bulkDownloadMock.mockReset();
        createBufferedTransferDestinationMock.mockReset();

        createWorkspaceFileTransferRpcCallerMock.mockImplementation((params: unknown) => ({
            call: vi.fn(async (callParams: any) => {
                if (callParams.machineMethod === RPC_METHODS.STAT_FILE) {
                    return { success: true, exists: true, kind: 'file', sizeBytes: 3 };
                }
                throw new Error(`unexpected call: ${callParams.machineMethod}`);
            }),
        }));

        createBufferedTransferDestinationMock.mockImplementation(() => ({
            destination: {
                writeBytes: async () => {},
                close: async () => {},
                cleanup: async () => {},
            },
            toBase64: vi.fn(() => 'YWJj'),
            reset: vi.fn(),
        }));

        directExportDownloadMock.mockResolvedValue({
            ok: false,
            error: 'Direct export unavailable',
        });
        relayDownloadMock.mockResolvedValue({
            ok: false,
            error: 'Relay unavailable',
        });
        bulkDownloadMock.mockResolvedValue({
            ok: false,
            error: 'Bulk download unavailable',
            errorCode: 'BULK_DOWNLOAD_UNAVAILABLE',
        });
    });

    it('preserves the bulk fallback errorCode when inline file download falls through all carriers', async () => {
        const { downloadDaemonWorkspaceFileToBase64 } = await import('./workspaceFileTransfers');
        const result = await downloadDaemonWorkspaceFileToBase64({
            machineId: 'machine-1',
            rootPath: '/repo',
            path: 'a.txt',
            maxBytes: 128,
        });

        expect(result).toEqual({
            ok: false,
            error: 'Bulk download unavailable',
            errorCode: 'BULK_DOWNLOAD_UNAVAILABLE',
        });
        expect(directExportDownloadMock).toHaveBeenCalledTimes(1);
        expect(relayDownloadMock).toHaveBeenCalledTimes(1);
        expect(bulkDownloadMock).toHaveBeenCalledTimes(1);
        expect(createBufferedTransferDestinationMock).toHaveBeenCalledTimes(3);
        expect(directExportDownloadMock.mock.calls[0]?.[0]?.destination).not.toBe(relayDownloadMock.mock.calls[0]?.[0]?.destination);
        expect(relayDownloadMock.mock.calls[0]?.[0]?.destination).not.toBe(bulkDownloadMock.mock.calls[0]?.[0]?.destination);
        expect(createBufferedTransferDestinationMock.mock.results[0]?.value.toBase64).not.toHaveBeenCalled();
        expect(createBufferedTransferDestinationMock.mock.results[1]?.value.toBase64).not.toHaveBeenCalled();
        expect(createBufferedTransferDestinationMock.mock.results[2]?.value.toBase64).not.toHaveBeenCalled();
    });

    it('cleans up a timed-out relay attempt before reaching the retained machine-RPC fallback', async () => {
        relayDownloadMock.mockResolvedValue({
            ok: false,
            error: 'Server relay transfer timed out',
        });
        bulkDownloadMock.mockResolvedValue({
            ok: true,
            name: 'a.txt',
            sizeBytes: 3,
        });
        const cleanup = vi.fn(async () => {});

        const { downloadDaemonWorkspaceFileToDestination } = await import('./workspaceFileTransfers');
        const result = await downloadDaemonWorkspaceFileToDestination({
            machineId: 'machine-1',
            rootPath: '/repo',
            request: {
                path: 'a.txt',
                asZip: false,
            },
            destination: {
                writeBytes: async () => {},
                close: async () => {},
                cleanup,
            },
        });

        expect(result).toEqual({
            ok: true,
            name: 'a.txt',
            sizeBytes: 3,
        });
        expect(directExportDownloadMock).toHaveBeenCalledTimes(1);
        expect(relayDownloadMock).toHaveBeenCalledTimes(1);
        expect(bulkDownloadMock).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(2);
        expect(directExportDownloadMock.mock.invocationCallOrder[0]).toBeLessThan(
            relayDownloadMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(relayDownloadMock.mock.invocationCallOrder[0]).toBeLessThan(
            bulkDownloadMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
    });

    it('rejects file-download destinations that cannot be cleaned up between carrier retries', async () => {
        const { downloadDaemonWorkspaceFileToDestination } = await import('./workspaceFileTransfers');
        const result = await downloadDaemonWorkspaceFileToDestination({
            machineId: 'machine-1',
            rootPath: '/repo',
            request: {
                path: 'a.txt',
                asZip: false,
            },
            destination: {
                writeBytes: async () => {},
                close: async () => {},
            },
        });

        expect(result).toEqual({
            ok: false,
            error: 'Workspace file download destination cleanup is required for retry-safe transfers',
        });
        expect(directExportDownloadMock).not.toHaveBeenCalled();
        expect(relayDownloadMock).not.toHaveBeenCalled();
        expect(bulkDownloadMock).not.toHaveBeenCalled();
    });

    it('aborts a held non-zip stat preflight before any download carrier starts', async () => {
        const statStarted = createDeferred<void>();
        const statResult = createDeferred<Readonly<{ success: true; exists: true; kind: 'file'; sizeBytes: number }>>();
        let observedSignal: AbortSignal | null = null;
        let statSawAbort = false;
        createWorkspaceFileTransferRpcCallerMock.mockImplementation(() => ({
            call: vi.fn((callParams: Readonly<{ machineMethod: string; signal?: AbortSignal | null }>) => {
                if (callParams.machineMethod !== RPC_METHODS.STAT_FILE) {
                    throw new Error(`unexpected call: ${callParams.machineMethod}`);
                }

                observedSignal = callParams.signal ?? null;
                statStarted.resolve();
                return new Promise((resolve) => {
                    callParams.signal?.addEventListener('abort', () => {
                        statSawAbort = true;
                        resolve({ success: false, error: 'Download canceled' });
                    }, { once: true });
                    void statResult.promise.then(resolve);
                });
            }),
        }));

        const controller = new AbortController();
        const { downloadDaemonWorkspaceFileToDestination } = await import('./workspaceFileTransfers');
        const download = downloadDaemonWorkspaceFileToDestination({
            machineId: 'machine-1',
            rootPath: '/repo',
            request: {
                path: 'a.txt',
                asZip: false,
            },
            destination: {
                writeBytes: async () => {},
                close: async () => {},
                cleanup: async () => {},
            },
            signal: controller.signal,
        });

        await statStarted.promise;
        controller.abort();
        statResult.resolve({ success: true, exists: true, kind: 'file', sizeBytes: 3 });

        await expect(download).resolves.toEqual({ ok: false, error: 'Download canceled' });
        expect(observedSignal).toBe(controller.signal);
        expect(statSawAbort).toBe(true);
        expect(directExportDownloadMock).not.toHaveBeenCalled();
        expect(relayDownloadMock).not.toHaveBeenCalled();
        expect(bulkDownloadMock).not.toHaveBeenCalled();
    });
});
