import { mergeModuleMock, type MergeModuleMockOptions } from './_shared';

type SessionMachineReachabilityModule = typeof import('@/components/sessions/model/useSessionMachineReachability');
type SessionMachineReachability = ReturnType<SessionMachineReachabilityModule['useSessionMachineReachability']>;

export type CreateSessionMachineReachabilityModuleMockOptions =
    MergeModuleMockOptions<SessionMachineReachabilityModule>;

export async function createSessionMachineReachabilityModuleMock(
    options: CreateSessionMachineReachabilityModuleMockOptions,
): Promise<SessionMachineReachabilityModule> {
    return mergeModuleMock<SessionMachineReachabilityModule>(options);
}

export function createReachableSessionMachineReachability(): SessionMachineReachability {
    return {
        machineReachable: true,
        machineOnline: true,
        machineRpcTargetAvailable: true,
        machineReachability: 'reachable',
    };
}

export function installSessionMachineReachabilityModuleMock(
    overrides: Partial<SessionMachineReachabilityModule>,
) {
    return async (importOriginal: <T>() => Promise<T>) =>
        createSessionMachineReachabilityModuleMock({
            importOriginal,
            overrides: {
                useSessionReachableMachineTarget: () => null,
                ...overrides,
            },
        });
}
