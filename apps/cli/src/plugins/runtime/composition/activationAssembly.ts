import type { StablePluginDaemonDatabaseHost } from '../context/daemonDatabase';
import {
    activatePluginRuntimeRegistry,
    type ActivatedPluginRuntimeRegistry,
} from '../lifecycle/manager';
import {
    createRefCountedLeaseOwner,
    type RefCountedLease,
} from './refCountedLeaseOwner';

type ActivationRegistryLeasePayload = Readonly<{
    registry: ActivatedPluginRuntimeRegistry;
    pluginIds: ReadonlySet<string>;
    daemonDatabase?: Pick<StablePluginDaemonDatabaseHost, 'bind' | 'readCapability'>;
}>;

export type PluginRuntimeActivationRegistryLease = RefCountedLease<
    ActivationRegistryLeasePayload,
    Parameters<ActivatedPluginRuntimeRegistry['dispose']>[0]
>;

type ActivationRegistryLeaseOwner = Readonly<{
    pluginIds: ReadonlySet<string>;
    retain(): PluginRuntimeActivationRegistryLease;
}>;

function createActivationRegistryLeaseOwner(
    registry: ActivatedPluginRuntimeRegistry,
    pluginIds: ReadonlySet<string> = registry.activatedPluginIds,
    dispose: (options?: Parameters<ActivatedPluginRuntimeRegistry['dispose']>[0]) => Promise<void> = async (options) => {
        await registry.dispose(options);
    },
    daemonDatabase?: ActivationRegistryLeasePayload['daemonDatabase'],
): ActivationRegistryLeaseOwner {
    const owner = createRefCountedLeaseOwner({
        payload: Object.freeze({ registry, pluginIds, daemonDatabase }),
        disposedError: 'Plugin runtime activation registry lease is already disposed',
        dispose,
    });
    return Object.freeze({ pluginIds, retain: () => owner.retain() });
}

export async function settlePluginRuntimeCompositionCleanup(
    operations: readonly Promise<unknown>[],
    message: string,
    primaryFailure?: unknown,
): Promise<void> {
    const results = await Promise.allSettled(operations);
    const failures = results.flatMap((result) => (
        result.status === 'rejected' ? [result.reason] : []
    ));
    if (primaryFailure !== undefined) {
        if (failures.length === 0) throw primaryFailure;
        throw new AggregateError([primaryFailure, ...failures], message);
    }
    if (failures.length === 0) return;
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, message);
}

type ActivationParams = Omit<
    Parameters<typeof activatePluginRuntimeRegistry>[0],
    'pluginIds' | 'retainedRegistries' | 'adoptActivationComponent'
>;

export async function assemblePluginRuntimeActivation(input: Readonly<{
    activationParams: ActivationParams;
    scopedPluginIds?: readonly string[];
    retainedLeases?: readonly PluginRuntimeActivationRegistryLease[];
    preparedLeases?: readonly PluginRuntimeActivationRegistryLease[];
    daemonDatabase?: ActivationRegistryLeasePayload['daemonDatabase'];
    disposeInvocationServices(): Promise<void>;
}>): Promise<Readonly<{
    activatedRegistry: ActivatedPluginRuntimeRegistry;
    activationRegistryLease: PluginRuntimeActivationRegistryLease;
    retainedActivationRegistryLeases: PluginRuntimeActivationRegistryLease[];
    preparedActivationRegistryLeaseOwners: ActivationRegistryLeaseOwner[];
}>> {
    const retainedActivationRegistryLeases = [...(input.retainedLeases ?? [])];
    const preparedActivationRegistryLeaseOwners: ActivationRegistryLeaseOwner[] =
        (input.preparedLeases ?? []).map((lease) => Object.freeze({
            pluginIds: lease.pluginIds,
            retain: () => lease.retain(),
        }));
    const invocationServicesOwner = createRefCountedLeaseOwner({
        payload: Object.freeze({}),
        disposedError: 'Plugin runtime invocation-services lease is already disposed',
        dispose: async () => await input.disposeInvocationServices(),
    });
    const createActivationComponentOwner = (
        registry: ActivatedPluginRuntimeRegistry,
        pluginIds: ReadonlySet<string>,
    ): ActivationRegistryLeaseOwner => {
        const invocationServicesLease = invocationServicesOwner.retain();
        return createActivationRegistryLeaseOwner(
            registry,
            pluginIds,
            async (options) => await settlePluginRuntimeCompositionCleanup([
                registry.dispose(options),
                invocationServicesLease.release(),
            ], 'Failed to dispose plugin activation component'),
            input.daemonDatabase,
        );
    };
    let preparingActivationComponents = (input.scopedPluginIds?.length ?? 0) > 0;
    const adoptActivationComponent = (component: Readonly<{
        pluginId: string;
        registry: ActivatedPluginRuntimeRegistry;
    }>): void => {
        const componentOwner = createActivationComponentOwner(
            component.registry,
            new Set([component.pluginId]),
        );
        retainedActivationRegistryLeases.push(componentOwner.retain());
        if (preparingActivationComponents) {
            preparedActivationRegistryLeaseOwners.push(componentOwner);
        }
    };
    const composedInvocationServicesLease = invocationServicesOwner.retain();
    let activatedRegistry: ActivatedPluginRuntimeRegistry;
    try {
        activatedRegistry = await activatePluginRuntimeRegistry({
            ...input.activationParams,
            adoptActivationComponent,
            ...(input.scopedPluginIds === undefined
                ? {}
                : { pluginIds: input.scopedPluginIds }),
            retainedRegistries: retainedActivationRegistryLeases.map((lease) => lease.registry),
        });
    } catch (error) {
        await settlePluginRuntimeCompositionCleanup([
            ...retainedActivationRegistryLeases.map((lease) => lease.release()),
            composedInvocationServicesLease.release(),
        ], 'Plugin activation component preparation and cleanup failed', error);
        throw error;
    } finally {
        preparingActivationComponents = false;
    }
    const composedOwner = createActivationRegistryLeaseOwner(
        activatedRegistry,
        new Set(retainedActivationRegistryLeases.flatMap((lease) => [...lease.pluginIds])),
        async (options) => await settlePluginRuntimeCompositionCleanup([
            activatedRegistry.dispose(options),
            ...retainedActivationRegistryLeases.map((lease) => lease.release(options)),
            composedInvocationServicesLease.release(),
        ], 'Failed to dispose composed plugin activation registry'),
    );
    return Object.freeze({
        activatedRegistry,
        activationRegistryLease: composedOwner.retain(),
        retainedActivationRegistryLeases,
        preparedActivationRegistryLeaseOwners,
    });
}
