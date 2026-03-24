import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { FeaturesResponse } from '@happier-dev/protocol';

let policyConsulted = false;

const machineRPCSpy = vi.fn();
const machineRpcWithServerScopeSpy = vi.fn();
const sessionRpcWithServerScopeSpy = vi.fn();
const getReadyServerFeaturesSpy = vi.fn(async (_params: unknown): Promise<FeaturesResponse | null> => {
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
});
const resolvePreferredServerIdForSessionIdSpy = vi.fn((_sessionId: string) => 'server-1');
const readMachineTargetForSessionSpy = vi.fn();
const canUseSessionRpcSpy = vi.fn();
const shouldFallbackToSessionRpcSpy = vi.fn();

vi.mock('@/sync/domains/transfers/runtime/transferRouteCache', () => ({
    // Keep tests deterministic: other suites can mark routes unavailable in the shared in-memory cache.
    // For these ops tests we always want the direct route to be attempted when a machine target exists.
    readCachedMachineRpcDirectRoute: () => ({ status: 'unknown' }),
    recordCachedMachineRpcDirectRouteUnavailable: () => {},
    recordCachedMachineRpcDirectRouteViable: () => {},
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC: (machineId: string, method: string, payload: unknown) =>
            machineRPCSpy(machineId, method, payload),
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => sessionRpcWithServerScopeSpy(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeSpy(params),
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (params: unknown) => getReadyServerFeaturesSpy(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdSpy(sessionId),
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionSpy(sessionId),
    canUseSessionRpc: (sessionId: string) => canUseSessionRpcSpy(sessionId),
    resolveMachinePathFromSessionBase: ({ basePath, requestPath }: { basePath: string; requestPath: string }) =>
        `${basePath}/${requestPath}`,
    shouldFallbackToSessionRpc: (sessionId: string, error: unknown) => shouldFallbackToSessionRpcSpy(sessionId, error),
}));

beforeEach(() => {
    policyConsulted = false;
    delete process.env.EXPO_PUBLIC_HAPPIER_SESSION_FILE_INLINE_MAX_BYTES;

    machineRPCSpy.mockReset();
    machineRpcWithServerScopeSpy.mockReset();
    sessionRpcWithServerScopeSpy.mockReset();
    getReadyServerFeaturesSpy.mockClear();
    resolvePreferredServerIdForSessionIdSpy.mockClear();
    readMachineTargetForSessionSpy.mockReset();
    canUseSessionRpcSpy.mockReset();
    shouldFallbackToSessionRpcSpy.mockReset();

    canUseSessionRpcSpy.mockReturnValue(true);
    shouldFallbackToSessionRpcSpy.mockReturnValue(true);

    machineRpcWithServerScopeSpy.mockImplementation(async (params: any) =>
        machineRPCSpy(params.machineId, params.method, params.payload),
    );
});

describe('sessionReadFile', () => {
    it('consults shared policy before any direct machine RPC attempt and does not call READ_FILE', async () => {
        const { sessionReadFile } = await import('./sessionFileSystem');

        readMachineTargetForSessionSpy.mockReturnValue({ machineId: 'm1', basePath: '/repo' });

        machineRPCSpy.mockImplementation(async (_machineId: string, method: string) => {
            expect(policyConsulted).toBe(true);

            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'download-1',
                    chunkSizeBytes: 4,
                    sizeBytes: 5,
                    name: 'a.ts',
                };
            }
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK) {
                return {
                    success: true,
                    contentBase64: 'aGVsbG8=',
                    isLast: true,
                };
            }
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }

            return { success: false, error: `unexpected method ${method}` };
        });

        const res = await sessionReadFile('s1', 'src/a.ts');
        expect(res).toEqual({ success: true, content: 'aGVsbG8=' });

        expect(machineRPCSpy).not.toHaveBeenCalledWith('m1', RPC_METHODS.READ_FILE, expect.anything());
        expect(sessionRpcWithServerScopeSpy).not.toHaveBeenCalled();
        expect(getReadyServerFeaturesSpy).toHaveBeenCalled();
    });

    it('fails closed when the inline max-bytes guard rejects the download', async () => {
        const { sessionReadFile } = await import('./sessionFileSystem');

        process.env.EXPO_PUBLIC_HAPPIER_SESSION_FILE_INLINE_MAX_BYTES = '4';
        readMachineTargetForSessionSpy.mockReturnValue({ machineId: 'm1', basePath: '/repo' });

        machineRPCSpy.mockImplementation(async (_machineId: string, method: string) => {
            expect(policyConsulted).toBe(true);

            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'download-1',
                    chunkSizeBytes: 4,
                    sizeBytes: 5,
                    name: 'a.ts',
                };
            }
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK) {
                return {
                    success: true,
                    contentBase64: 'aGVsbG8=',
                    isLast: true,
                };
            }

            return { success: false, error: `unexpected method ${method}` };
        });

        const res = await sessionReadFile('s1', 'src/a.ts');
        expect(res.success).toBe(false);
        if (!res.success) {
            expect(typeof res.error).toBe('string');
            expect(res.error.length).toBeGreaterThan(0);
        }
        expect(machineRPCSpy).not.toHaveBeenCalledWith('m1', RPC_METHODS.READ_FILE, expect.anything());
    });

    it('fails closed when the inline max-bytes env is misconfigured to an unsafe value (hard clamp)', async () => {
        const { sessionReadFile } = await import('./sessionFileSystem');

        process.env.EXPO_PUBLIC_HAPPIER_SESSION_FILE_INLINE_MAX_BYTES = '1000000000';
        readMachineTargetForSessionSpy.mockReturnValue({ machineId: 'm1', basePath: '/repo' });

        let readChunkCalled = 0;

        machineRPCSpy.mockImplementation(async (_machineId: string, method: string) => {
            expect(policyConsulted).toBe(true);

            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'download-1',
                    chunkSizeBytes: 4,
                    sizeBytes: 50 * 1024 * 1024,
                    name: 'a.ts',
                };
            }
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK) {
                readChunkCalled += 1;
                throw new Error('chunk should not be requested when the download is rejected by policy');
            }
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT) {
                return { success: true };
            }
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }

            return { success: false, error: `unexpected method ${method}` };
        });

        const res = await sessionReadFile('s1', 'src/a.ts');
        expect(res.success).toBe(false);
        if (!res.success) {
            expect(String(res.error)).toContain('inline');
        }
        expect(readChunkCalled).toBe(0);
        expect(machineRPCSpy).not.toHaveBeenCalledWith('m1', RPC_METHODS.READ_FILE, expect.anything());
    });

    it('fails closed when inactive session has no machine target', async () => {
        const { sessionReadFile } = await import('./sessionFileSystem');

        canUseSessionRpcSpy.mockReturnValue(false);
        readMachineTargetForSessionSpy.mockReturnValue(null);

        const res = await sessionReadFile('s1', 'src/a.ts');
        expect(res.success).toBe(false);
        expect(machineRPCSpy).not.toHaveBeenCalled();
        expect(sessionRpcWithServerScopeSpy).not.toHaveBeenCalled();
        expect(getReadyServerFeaturesSpy).not.toHaveBeenCalled();
    });
});
