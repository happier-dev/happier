import type {
    LocalServiceActionKindV1,
    LocalServiceManagedRuntimeSnapshotV1,
    LocalServiceManagedRuntimeStateV1,
} from '@happier-dev/protocol';

import type {
    ManagedLocalServiceRegistry,
    ManagedLocalServiceRuntimeState,
} from './registry';

export type LocalServiceManagedRoutes = Readonly<{
    getSnapshot(): Promise<LocalServiceManagedRuntimeSnapshotV1>;
}>;

export type LocalServiceManagedSupportedActionsResolver = (
    service: ManagedLocalServiceRuntimeState,
) => readonly LocalServiceActionKindV1[];

function projectManagedService(
    service: ManagedLocalServiceRuntimeState,
    resolveSupportedActions: LocalServiceManagedSupportedActionsResolver,
): LocalServiceManagedRuntimeStateV1 {
    const row: LocalServiceManagedRuntimeStateV1 = {
        v: 1,
        id: service.id,
        owner: service.owner,
        phase: service.phase,
        launchMode: service.launchMode,
        process: service.process,
        ...(service.inventoryId ? { inventoryId: service.inventoryId } : {}),
        routeName: service.routeName,
        ...(typeof service.port === 'number' ? { port: service.port } : {}),
        supportedActions: [...new Set(resolveSupportedActions(service))],
        diagnostics: [...service.diagnostics],
    };
    return row;
}

export function createLocalServiceManagedRoutes(input: Readonly<{
    machineId: string;
    registry: ManagedLocalServiceRegistry;
    now?: () => number;
    resolveSupportedActions?: LocalServiceManagedSupportedActionsResolver;
}>): LocalServiceManagedRoutes {
    const now = input.now ?? (() => Date.now());
    const resolveSupportedActions = input.resolveSupportedActions ?? (() => []);

    return {
        async getSnapshot() {
            return {
                v: 1,
                machineId: input.machineId,
                generatedAt: now(),
                refreshState: 'idle',
                rows: input.registry.listServices().map((service) => (
                    projectManagedService(service, resolveSupportedActions)
                )),
                diagnostics: [],
            };
        },
    };
}
