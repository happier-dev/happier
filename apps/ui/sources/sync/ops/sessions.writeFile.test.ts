import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { FeaturesResponse } from '@happier-dev/protocol';

import { createRpcCallError } from '../runtime/rpcErrors';

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
    readMachineTargetForSessionSpy.mockReturnValue({ machineId: 'm1', basePath: '/repo' });

    machineRpcWithServerScopeSpy.mockImplementation(async (params: any) =>
        machineRPCSpy(params.machineId, params.method, params.payload),
    );
});

describe('sessionWriteFile', () => {
    it('base64-encodes UTF-8 content before calling the writeFile RPC', async () => {
        const { sessionWriteFile } = await import('./sessionFileSystem');

        machineRPCSpy.mockImplementation(async (_machineId: string, method: string, payload: unknown) => {
            expect(policyConsulted).toBe(true);
            expect(method).toBe(RPC_METHODS.WRITE_FILE);
            expect(payload).toEqual({
                path: '/repo/src/a.ts',
                content: 'aGVsbG8=',
                expectedHash: undefined,
            });
            return { success: true, hash: 'h1' };
        });

        const res = await sessionWriteFile('s1', 'src/a.ts', 'hello');

        expect(res).toEqual({ success: true, hash: 'h1' });
        expect(sessionRpcWithServerScopeSpy).not.toHaveBeenCalled();
        expect(getReadyServerFeaturesSpy).toHaveBeenCalled();
    });

    it('returns a stable errorCode when the RPC method is unavailable', async () => {
        const { sessionWriteFile } = await import('./sessionFileSystem');

        machineRPCSpy.mockRejectedValueOnce(
            createRpcCallError({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );
        sessionRpcWithServerScopeSpy.mockResolvedValueOnce({
            success: false,
            error: 'Method not found',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        });

        const res = await sessionWriteFile('s1', 'src/a.ts', 'hello');
        expect(res.success).toBe(false);
        if (res.success) throw new Error('Expected sessionWriteFile to fail');
        expect(res.errorCode).toBe(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        expect(getReadyServerFeaturesSpy).toHaveBeenCalled();
        expect(machineRPCSpy).toHaveBeenCalled();
    });

    it('returns a stable failure response when the RPC returns an unsupported shape', async () => {
        const { sessionWriteFile } = await import('./sessionFileSystem');

        machineRPCSpy.mockResolvedValueOnce(null);

        const res = await sessionWriteFile('s1', 'src/a.ts', 'hello');
        expect(res.success).toBe(false);
        if (res.success) throw new Error('Expected sessionWriteFile to fail');
        expect(res.errorCode).toBe(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        expect(typeof res.error).toBe('string');
    });

    it('fails closed when inactive session has no machine target', async () => {
        const { sessionWriteFile } = await import('./sessionFileSystem');

        canUseSessionRpcSpy.mockReturnValue(false);
        readMachineTargetForSessionSpy.mockReturnValue(null);

        const res = await sessionWriteFile('s1', 'src/a.ts', 'hello');
        expect(res.success).toBe(false);
        if (res.success) throw new Error('Expected sessionWriteFile to fail');
        expect(res.errorCode).toBe(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        expect(machineRPCSpy).not.toHaveBeenCalled();
        expect(sessionRpcWithServerScopeSpy).not.toHaveBeenCalled();
        expect(getReadyServerFeaturesSpy).toHaveBeenCalled();
    });
});
