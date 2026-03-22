import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { FeaturesResponse } from '@happier-dev/protocol';

type GetDirectoryTreeRpcResponse =
    | Readonly<{ success: true; tree: unknown }>
    | Readonly<{ success: false; error: string; errorCode?: string }>
    | null;

let enforcePolicyConsultedBeforeMachineRpc = false;
let policyConsulted = false;

const machineRPCSpy = vi.fn(
    async (_machineId: string, _method: string, _payload: unknown) => {
        if (enforcePolicyConsultedBeforeMachineRpc) {
            expect(policyConsulted).toBe(true);
        }
        return { success: true } as const;
    },
);

const sessionRpcWithServerScopeSpy = vi.fn(
    async (_params: unknown) => ({ success: true } as const),
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
        machineRPC: (machineId: string, method: string, payload: unknown) =>
            machineRPCSpy(machineId, method, payload),
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

function resetPolicyFlags() {
    enforcePolicyConsultedBeforeMachineRpc = false;
    policyConsulted = false;
}

describe('sessionFileSystem policy choke point', () => {
    it('sessionRenamePath consults shared transfer policy before direct machine rpc', async () => {
        const { sessionRenamePath } = await import('./sessionFileSystem');

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

        machineRPCSpy.mockClear();
        sessionRpcWithServerScopeSpy.mockClear();
        getReadyServerFeaturesSpy.mockClear();

        const res = await sessionRenamePath('s1', { from: 'README.md', to: 'README2.md' });
        expect(res).toEqual({ success: true });
        expect(getReadyServerFeaturesSpy).toHaveBeenCalledTimes(1);
        expect(machineRPCSpy).toHaveBeenCalledWith('m1', RPC_METHODS.RENAME_PATH, {
            from: '~/repo/README.md',
            to: '~/repo/README2.md',
            overwrite: undefined,
        });
        expect(sessionRpcWithServerScopeSpy).not.toHaveBeenCalled();
    });

    it('sessionDeletePath consults shared transfer policy before direct machine rpc', async () => {
        const { sessionDeletePath } = await import('./sessionFileSystem');

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

        machineRPCSpy.mockClear();
        sessionRpcWithServerScopeSpy.mockClear();
        getReadyServerFeaturesSpy.mockClear();

        const res = await sessionDeletePath('s1', { path: 'tmp/a.txt', recursive: true });
        expect(res).toEqual({ success: true });
        expect(getReadyServerFeaturesSpy).toHaveBeenCalledTimes(1);
        expect(machineRPCSpy).toHaveBeenCalledWith('m1', RPC_METHODS.DELETE_PATH, {
            path: '~/repo/tmp/a.txt',
            recursive: true,
        });
        expect(sessionRpcWithServerScopeSpy).not.toHaveBeenCalled();
    });

    it('sessionGetDirectoryTree consults shared transfer policy before direct machine rpc', async () => {
        const { sessionGetDirectoryTree } = await import('./sessionFileSystem');

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

        machineRPCSpy.mockClear();
        sessionRpcWithServerScopeSpy.mockClear();
        getReadyServerFeaturesSpy.mockClear();

        const response: GetDirectoryTreeRpcResponse = {
            success: true,
            tree: { name: 'repo', children: [] },
        };
        machineRPCSpy.mockResolvedValueOnce(response);

        const res = await sessionGetDirectoryTree('s1', 'src', 3);
        expect(res).toEqual(response);
        expect(getReadyServerFeaturesSpy).toHaveBeenCalledTimes(1);
        expect(machineRPCSpy).toHaveBeenCalledWith('m1', RPC_METHODS.GET_DIRECTORY_TREE, {
            path: '~/repo/src',
            maxDepth: 3,
        });
        expect(sessionRpcWithServerScopeSpy).not.toHaveBeenCalled();
    });
});
