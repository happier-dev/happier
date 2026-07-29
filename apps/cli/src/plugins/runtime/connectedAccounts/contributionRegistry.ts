import {
    PluginConnectedAccountDescriptorContributionV2Schema,
    PLUGIN_MANIFEST_INPUT_LIMITS,
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
} from '@happier-dev/protocol';
import type { PluginConnectedAccountRuntime, PluginContributionRef } from '@happier-dev/plugin-sdk/runtime';

import type { ResolvedConnectedAccountDescriptorContribution } from '@/plugins/projection/registry/types';

export type ConnectedAccountRuntimeRegistration = Readonly<{
    pluginId: string;
    generation: string;
    localId: string;
    runtime: PluginConnectedAccountRuntime;
}>;

export type ConnectedAccountContributionRegistryEntry = Readonly<{
    ref: PluginContributionRef;
    descriptor: ResolvedConnectedAccountDescriptorContribution['definition'];
    generation: string;
}>;

export type ConnectedAccountRuntimeLease = Readonly<{
    ref: PluginContributionRef;
    generation: string;
    immutableGenerationId: string;
    descriptor: ResolvedConnectedAccountDescriptorContribution['definition'];
    runtime: PluginConnectedAccountRuntime;
    isCurrent(): boolean;
}>;

export class ConnectedAccountRuntimeInvocationNotStartedError extends Error {
    readonly code = 'connected_account_runtime_generation_changed';

    constructor() {
        super(
            'Connected-account runtime generation is no longer current before provider entry',
        );
        this.name = 'ConnectedAccountRuntimeInvocationNotStartedError';
    }
}

function qualifiedKey(ref: PluginContributionRef): string {
    return buildQualifiedPluginContributionKey(createPluginContributionIdentity(ref));
}

function snapshotQualifiedRef(value: PluginContributionRef): PluginContributionRef {
    try {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new TypeError('reference must be a plain object');
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError('reference must be a plain object');
        }
        const keys = Reflect.ownKeys(value);
        if (keys.length !== 2 || !keys.includes('pluginId') || !keys.includes('localId')) {
            throw new TypeError('reference must contain exactly pluginId and localId');
        }
        const read = (key: 'pluginId' | 'localId'): string => {
            const property = Object.getOwnPropertyDescriptor(value, key);
            if (!property || !property.enumerable || !('value' in property) || typeof property.value !== 'string') {
                throw new TypeError(`reference field '${key}' must be an own enumerable string`);
            }
            return property.value;
        };
        const identity = createPluginContributionIdentity({
            pluginId: read('pluginId'),
            localId: read('localId'),
        });
        return Object.freeze({ pluginId: identity.pluginId, localId: identity.localId });
    } catch {
        throw new TypeError('Invalid qualified connected-account reference');
    }
}

function assertBoundedPlainDataGraph(value: unknown): void {
    const seen = new Set<object>();
    const pending: Array<Readonly<{ value: unknown; depth: number }>> = [{ value, depth: 0 }];
    let nodes = 0;
    while (pending.length > 0) {
        const current = pending.pop()!;
        nodes += 1;
        if (nodes > PLUGIN_MANIFEST_INPUT_LIMITS.nodes || current.depth > PLUGIN_MANIFEST_INPUT_LIMITS.depth) {
            throw new TypeError('Connected-account descriptor exceeds the registry structural budget');
        }
        if (current.value === null || typeof current.value !== 'object') continue;
        if (seen.has(current.value)) throw new TypeError('Connected-account descriptor must not be cyclic');
        seen.add(current.value);
        const prototype = Object.getPrototypeOf(current.value);
        if (Array.isArray(current.value)) {
            if (prototype !== Array.prototype) throw new TypeError('Connected-account descriptor arrays must use the built-in prototype');
        } else if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError('Connected-account descriptor records must be plain objects');
        }
        for (const key of Reflect.ownKeys(current.value)) {
            if (Array.isArray(current.value) && key === 'length') continue;
            if (typeof key !== 'string') throw new TypeError('Connected-account descriptor symbol fields are not allowed');
            const property = Object.getOwnPropertyDescriptor(current.value, key);
            if (!property || !property.enumerable || !('value' in property)) {
                throw new TypeError(`Connected-account descriptor field '${key}' must be an own enumerable data property`);
            }
            pending.push({ value: property.value, depth: current.depth + 1 });
        }
    }
}

function snapshotDescriptor(
    contribution: ResolvedConnectedAccountDescriptorContribution,
): ResolvedConnectedAccountDescriptorContribution['definition'] {
    assertBoundedPlainDataGraph(contribution.definition);
    const parsed = PluginConnectedAccountDescriptorContributionV2Schema.parse(contribution.definition);
    const pending: object[] = [parsed];
    while (pending.length > 0) {
        const current = pending.pop()!;
        for (const value of Object.values(current)) {
            if (value !== null && typeof value === 'object') pending.push(value);
        }
        Object.freeze(current);
    }
    return parsed;
}

function guardRuntime(params: Readonly<{
    runtime: PluginConnectedAccountRuntime;
    assertCurrent(): void;
}>): PluginConnectedAccountRuntime {
    const guardCall = async (
        callback: (...args: readonly unknown[]) => unknown,
        receiver: object,
        args: readonly unknown[],
    ): Promise<unknown> => {
        try {
            params.assertCurrent();
        } catch {
            throw new ConnectedAccountRuntimeInvocationNotStartedError();
        }
        try {
            return await Reflect.apply(callback, receiver, args);
        } finally {
            params.assertCurrent();
        }
    };
    const guardedModes = Object.freeze(Object.fromEntries(
        Object.entries(params.runtime.authentication.modes).map(([modeId, mode]) => [
            modeId,
            Object.freeze(Object.fromEntries(
                Object.entries(mode).map(([key, value]) => [
                    key,
                    typeof value === 'function'
                        ? (...args: readonly unknown[]) => guardCall(value, mode, args)
                        : value,
                ]),
            )),
        ]),
    )) as PluginConnectedAccountRuntime['authentication']['modes'];
    const authentication = Object.freeze({
        ...params.runtime.authentication,
        modes: guardedModes,
    });
    const runtime = Object.freeze(Object.fromEntries(
        Object.entries(params.runtime).map(([key, value]) => {
            if (key === 'authentication') return [key, authentication];
            return [key, typeof value === 'function'
                ? (...args: readonly unknown[]) => guardCall(value, params.runtime, args)
                : value];
        }),
    ));
    return runtime as unknown as PluginConnectedAccountRuntime;
}

export function createConnectedAccountContributionRegistry(params: Readonly<{
    generation: string;
    immutableGenerationIdsByPluginId: ReadonlyMap<string, string>;
    descriptors: readonly ResolvedConnectedAccountDescriptorContribution[];
    activateOnDemand(ref: PluginContributionRef): Promise<void>;
    readRegistrations(): readonly ConnectedAccountRuntimeRegistration[];
    isGenerationCurrent(pluginId: string): boolean;
}>): Readonly<{
    list(): readonly ConnectedAccountContributionRegistryEntry[];
    resolve(ref: PluginContributionRef): Promise<ConnectedAccountRuntimeLease>;
    dispose(): void;
}> {
    const descriptorsByKey = new Map<string, Readonly<{
        ref: PluginContributionRef;
        descriptor: ResolvedConnectedAccountDescriptorContribution['definition'];
        immutableGenerationId: string;
    }>>();
    for (const contribution of params.descriptors) {
        const pluginId = contribution.pluginId?.trim();
        if (!pluginId) throw new TypeError('Connected-account descriptors require a plugin-qualified owner');
        const descriptor = snapshotDescriptor(contribution);
        const immutableGenerationId = params.immutableGenerationIdsByPluginId.get(pluginId)?.trim();
        if (!immutableGenerationId) {
            throw new TypeError('Connected-account descriptors require an immutable plugin generation identity');
        }
        const ref = Object.freeze({ pluginId, localId: descriptor.id });
        const key = qualifiedKey(ref);
        if (descriptorsByKey.has(key)) throw new Error(`Duplicate connected-account descriptor '${key}'`);
        descriptorsByKey.set(key, Object.freeze({ ref, descriptor, immutableGenerationId }));
    }
    let disposed = false;

    function assertCurrent(pluginId: string): void {
        if (disposed || !params.isGenerationCurrent(pluginId)) {
            throw new Error(`Connected-account registry generation '${params.generation}' is no longer current`);
        }
    }

    function readRegistration(ref: PluginContributionRef): ConnectedAccountRuntimeRegistration | null {
        const matches = params.readRegistrations().filter((registration) => (
            registration.pluginId === ref.pluginId
            && registration.localId === ref.localId
            && registration.generation === params.generation
        ));
        if (matches.length > 1) {
            throw new Error(`Duplicate current-generation registration '${qualifiedKey(ref)}'`);
        }
        const registration = matches[0] ?? null;
        if (registration) {
            const declared = descriptorsByKey.get(qualifiedKey(ref));
            if (!declared) {
                throw new Error(`Connected-account runtime '${qualifiedKey(ref)}' has no executable descriptor`);
            }
            const descriptor = declared.descriptor;
            const declaredModesById = new Map(
                descriptor.authentication.modes.map((mode) => [mode.id, mode] as const),
            );
            const registeredModes = Object.entries(registration.runtime.authentication.modes);
            if (
                registeredModes.length !== declaredModesById.size
                || registeredModes.some(([modeId, runtime]) => (
                    declaredModesById.get(modeId)?.kind !== runtime.kind
                ))
            ) {
                throw new Error(`Connected-account runtime '${qualifiedKey(ref)}' authentication modes do not match its descriptor`);
            }
            if (registeredModes.some(([modeId, runtime]) => {
                const declaredMode = declaredModesById.get(modeId);
                const requiresProviderReconciliation =
                    declaredMode?.outcomeReconciliation === 'providerCheck';
                return requiresProviderReconciliation !== (typeof runtime.reconcile === 'function');
            })) {
                throw new Error(`Connected-account runtime '${qualifiedKey(ref)}' reconciliation reachability does not match its descriptor`);
            }
        }
        return registration;
    }

    return Object.freeze({
        list() {
            return Object.freeze([...descriptorsByKey.values()].map(({ ref, descriptor }) =>
                Object.freeze({ ref, descriptor, generation: params.generation })));
        },
        async resolve(ref) {
            const qualifiedRef = snapshotQualifiedRef(ref);
            assertCurrent(qualifiedRef.pluginId);
            const declared = descriptorsByKey.get(qualifiedKey(qualifiedRef));
            if (!declared) throw new Error(`Unknown connected-account service '${qualifiedKey(qualifiedRef)}'`);
            let registration = readRegistration(qualifiedRef);
            if (!registration) {
                await params.activateOnDemand(qualifiedRef);
                assertCurrent(qualifiedRef.pluginId);
                registration = readRegistration(qualifiedRef);
            }
            if (!registration) throw new Error(`Connected-account service '${qualifiedKey(qualifiedRef)}' did not publish its required runtime`);
            const runtime = guardRuntime({
                runtime: registration.runtime,
                assertCurrent: () => assertCurrent(qualifiedRef.pluginId),
            });
            return Object.freeze({
                ref: declared.ref,
                generation: registration.generation,
                immutableGenerationId: declared.immutableGenerationId,
                descriptor: declared.descriptor,
                runtime,
                isCurrent: () => (
                    !disposed
                    && params.isGenerationCurrent(qualifiedRef.pluginId)
                ),
            });
        },
        dispose() { disposed = true; },
    });
}
