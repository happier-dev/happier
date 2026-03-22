import { describe, expect, it, vi } from 'vitest';
import { createRpcCallError } from '../runtime/rpcErrors';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { FeaturesResponse } from '@happier-dev/protocol';

type StatFileRpcResponse =
    | Readonly<{ success: true; exists: boolean; kind?: string; sizeBytes?: number; modifiedMs?: number }>
    | Readonly<{ success: false; error: string }>
    | null;

let enforcePolicyConsultedBeforeMachineRpc = false;
let policyConsulted = false;

const sessionRPCSpy = vi.fn(
    async (_sessionId: string, _method: string, _payload: unknown): Promise<StatFileRpcResponse> => ({
        success: true,
        exists: false,
    }),
);

const machineRPCSpy = vi.fn(
    async (_machineId: string, _method: string, _payload: unknown): Promise<StatFileRpcResponse> => {
        if (enforcePolicyConsultedBeforeMachineRpc) {
            expect(policyConsulted).toBe(true);
        }
        return {
            success: true,
            exists: false,
        };
    },
);

const getStateSpy = vi.fn();
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

const sessionRpcWithServerScopeSpy = vi.fn(
    async (params: unknown): Promise<StatFileRpcResponse> => {
        const { sessionId, method, payload } = params as { sessionId: string; method: string; payload: unknown };
        return sessionRPCSpy(sessionId, method, payload);
    },
);

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: (sessionId: string, method: string, payload: any) => sessionRPCSpy(sessionId, method, payload),
        machineRPC: (machineId: string, method: string, payload: any) => machineRPCSpy(machineId, method, payload),
    },
}));

vi.mock('../api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (params: unknown) => getReadyServerFeaturesSpy(params),
}));

vi.mock('../runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => sessionRpcWithServerScopeSpy(params),
}));

vi.mock('../runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => 'server-1',
}));

vi.mock('../domains/state/storage', () => ({
    storage: {
        getState: () => getStateSpy(),
    },
}));

describe('sessionStatFile', () => {
    it('prefers machine RPC and resolves relative paths against the session cwd', async () => {
        const { sessionStatFile } = await import('./sessionFileSystem');

        enforcePolicyConsultedBeforeMachineRpc = true;
        policyConsulted = false;
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

        const res = await sessionStatFile('s1', 'src/a.ts');
        expect(res).toMatchObject({ success: true, exists: false });
        expect(getReadyServerFeaturesSpy).toHaveBeenCalledTimes(1);
        expect(machineRPCSpy).toHaveBeenCalledWith('m1', RPC_METHODS.STAT_FILE, { path: '~/repo/src/a.ts' });
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    });

    it('returns a stable failure response when the RPC returns an unsupported shape', async () => {
        const { sessionStatFile } = await import('./sessionFileSystem');

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

        machineRPCSpy.mockResolvedValueOnce(null);
        sessionRPCSpy.mockResolvedValueOnce(null);

        const res = await sessionStatFile('s1', 'src/a.ts');
        expect(res.success).toBe(false);
        if (res.success) {
            throw new Error('Expected sessionStatFile to fail');
        }
        expect(typeof res.error).toBe('string');
    });

    it('does not fall back to session RPC for inactive sessions', async () => {
        const { sessionStatFile } = await import('./sessionFileSystem');

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
        sessionRPCSpy.mockClear();
        sessionRPCSpy.mockResolvedValueOnce({ success: true, exists: true, kind: 'file', sizeBytes: 1, modifiedMs: 0 });

        const res = await sessionStatFile('s1', 'src/a.ts');
        expect(res.success).toBe(false);
        expect(sessionRPCSpy).not.toHaveBeenCalled();
    });
});
