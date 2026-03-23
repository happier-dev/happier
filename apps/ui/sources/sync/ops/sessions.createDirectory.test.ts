import { describe, expect, it, vi } from 'vitest';
import type { FeaturesResponse } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRpcCallError } from '../runtime/rpcErrors';

type SessionCreateDirectoryRpcResponse = Readonly<{ success: boolean }> | null;

let enforcePolicyConsultedBeforeMachineRpc = false;
let policyConsulted = false;

const sessionRPCSpy = vi.fn(
    async (_sessionId: string, _method: string, _payload: unknown): Promise<SessionCreateDirectoryRpcResponse> => ({
        success: true,
    }),
);

const machineRPCSpy = vi.fn(
    async (_machineId: string, _method: string, _payload: unknown): Promise<SessionCreateDirectoryRpcResponse> => {
        if (enforcePolicyConsultedBeforeMachineRpc) {
            expect(policyConsulted).toBe(true);
        }
        return { success: true };
    },
);

const machineRpcWithServerScopeSpy = vi.fn(
    async (_params: unknown): Promise<SessionCreateDirectoryRpcResponse> => ({ success: true }),
);

const sessionRpcWithServerScopeSpy = vi.fn(
    async (params: unknown): Promise<SessionCreateDirectoryRpcResponse> => {
        const { sessionId, method, payload } = params as { sessionId: string; method: string; payload: unknown };
        return sessionRPCSpy(sessionId, method, payload);
    },
);

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

const getStateSpy = vi.fn();

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: (sessionId: string, method: string, payload: any) => sessionRPCSpy(sessionId, method, payload),
        machineRPC: (machineId: string, method: string, payload: any) => machineRPCSpy(machineId, method, payload),
    },
}));

vi.mock('../api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (params: unknown) => getReadyServerFeaturesSpy(params),
    getCachedReadyServerFeatures: (_params: unknown) => null,
}));

vi.mock('../runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => sessionRpcWithServerScopeSpy(params),
}));

vi.mock('../runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeSpy(params),
}));

vi.mock('../runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => 'server-1',
}));

vi.mock('../domains/state/storage', () => ({
    storage: {
        getState: () => getStateSpy(),
    },
}));

function resetPolicyFlags() {
    enforcePolicyConsultedBeforeMachineRpc = false;
    policyConsulted = false;
}

describe('sessionCreateDirectory', () => {
    it('calls the createDirectory RPC with the provided path', async () => {
        const { sessionCreateDirectory } = await import('./sessionFileSystem');
        resetPolicyFlags();
        enforcePolicyConsultedBeforeMachineRpc = true;

        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    metadata: {
                        path: '~/repo',
                        machineId: 'm1',
                    },
                },
            },
        });

        sessionRPCSpy.mockClear();
        machineRPCSpy.mockClear();
        getReadyServerFeaturesSpy.mockClear();

        const res = await sessionCreateDirectory('s1', 'tmp/new-folder');
        expect(res.success).toBe(true);
        expect(getReadyServerFeaturesSpy).toHaveBeenCalledTimes(1);
        expect(machineRPCSpy).toHaveBeenCalledWith('m1', RPC_METHODS.CREATE_DIRECTORY, { path: '~/repo/tmp/new-folder' });
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    }, 60_000);

    it('returns a stable errorCode when the RPC method is not found', async () => {
        const { sessionCreateDirectory } = await import('./sessionFileSystem');
        resetPolicyFlags();
        enforcePolicyConsultedBeforeMachineRpc = true;

        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        path: '~/repo',
                        machineId: 'm1',
                    },
                },
            },
        });

        machineRPCSpy.mockRejectedValueOnce(
            createRpcCallError({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );

        const res = await sessionCreateDirectory('s1', 'tmp/new-folder');
        expect(res.success).toBe(false);
        if (res.success) {
            throw new Error('Expected sessionCreateDirectory to fail');
        }
        expect(res.errorCode).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    });

    it('returns a stable failure response when the RPC returns an unsupported shape', async () => {
        const { sessionCreateDirectory } = await import('./sessionFileSystem');
        resetPolicyFlags();
        enforcePolicyConsultedBeforeMachineRpc = true;

        getStateSpy.mockReturnValue({
            sessions: {
                s1: {
                    active: false,
                    metadata: {
                        path: '~/repo',
                        machineId: 'm1',
                    },
                },
            },
        });

        machineRPCSpy.mockResolvedValueOnce(null);

        const res = await sessionCreateDirectory('s1', 'tmp/new-folder');
        expect(res.success).toBe(false);
        if (res.success) {
            throw new Error('Expected sessionCreateDirectory to fail');
        }
        expect(res.errorCode).toBe(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        expect(typeof res.error).toBe('string');
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    });
});
