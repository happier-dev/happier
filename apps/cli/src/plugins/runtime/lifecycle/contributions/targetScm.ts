import type {
    ScmBackendRuntimeRegistration,
} from '@happier-dev/plugin-sdk/experimental/scm/backend';
import type {
    ScmHostingProviderRuntimeRegistration,
} from '@happier-dev/plugin-sdk/experimental/scm/hostingProvider';

import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';

import type { ActivationTarget } from '../activation/targets';

type TargetRegistration = Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}>;

function readPromiseLikeThen(value: unknown): ((...args: readonly unknown[]) => unknown) | null {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
    const then = Reflect.get(value, 'then');
    return typeof then === 'function'
        ? then as (...args: readonly unknown[]) => unknown
        : null;
}

function guardRuntimeValue<T>(params: Readonly<{
    value: T;
    pluginId: string;
    family: 'scmBackends' | 'scmHostingProviders';
    isGenerationActive(): boolean;
}>): T {
    const guardedByValue = new WeakMap<object, object>();
    const guardedFunctionsByOwner = new WeakMap<object, WeakMap<object, object>>();
    const assertActive = (): void => {
        if (!params.isGenerationActive()) {
            throw new Error(`Plugin '${params.pluginId}' ${params.family} runtime is no longer active`);
        }
    };
    const assertOperationNotAborted = (args: readonly unknown[]): void => {
        const input = args[0];
        if (!input || typeof input !== 'object') return;
        let signal: unknown;
        try {
            signal = Reflect.get(input, 'signal');
        } catch {
            throw new Error(`Plugin '${params.pluginId}' ${params.family} operation signal is unreadable`);
        }
        if (signal instanceof AbortSignal && signal.aborted) {
            throw new Error(`Plugin '${params.pluginId}' ${params.family} operation was aborted`);
        }
    };

    const guard = (value: unknown, functionOwner?: object): unknown => {
        if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value;

        if (typeof value === 'function') {
            const ownerCache = functionOwner
                ? (guardedFunctionsByOwner.get(value) ?? new WeakMap<object, object>())
                : null;
            if (functionOwner && !guardedFunctionsByOwner.has(value)) {
                guardedFunctionsByOwner.set(value, ownerCache!);
            }
            const cached = functionOwner
                ? ownerCache?.get(functionOwner)
                : guardedByValue.get(value);
            if (cached) return cached;
            const runtimeFunction = value as (...args: readonly unknown[]) => unknown;
            const guardedFunction = function (this: unknown, ...args: readonly unknown[]): unknown {
                assertActive();
                assertOperationNotAborted(args);
                const receiver = functionOwner ?? this;
                const result = Reflect.apply(runtimeFunction, receiver, args);
                const then = readPromiseLikeThen(result);
                if (then) {
                    const settled = new Promise<unknown>((resolve, reject) => {
                        try {
                            Reflect.apply(then, result, [resolve, reject]);
                        } catch (error) {
                            reject(error);
                        }
                    });
                    return settled.then((resolved) => {
                        assertActive();
                        return resolved;
                    });
                }
                assertActive();
                return result;
            };
            if (functionOwner) {
                ownerCache?.set(functionOwner, guardedFunction);
            } else {
                guardedByValue.set(value, guardedFunction);
            }
            return guardedFunction;
        }

        const cached = guardedByValue.get(value as object);
        if (cached) return cached;

        if (Array.isArray(value)) {
            const guardedArray = value.map((item) => guard(item));
            guardedByValue.set(value, guardedArray);
            return Object.freeze(guardedArray);
        }

        const guardedObject = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
        guardedByValue.set(value, guardedObject);
        const descriptors = new Map<PropertyKey, PropertyDescriptor>();
        let descriptorOwner: object | null = value;
        while (descriptorOwner && descriptorOwner !== Object.prototype) {
            for (const property of Reflect.ownKeys(descriptorOwner)) {
                if (property === 'constructor' || descriptors.has(property)) continue;
                const descriptor = Reflect.getOwnPropertyDescriptor(descriptorOwner, property);
                if (descriptor) descriptors.set(property, descriptor);
            }
            descriptorOwner = Reflect.getPrototypeOf(descriptorOwner) as object | null;
        }
        for (const [property, descriptor] of descriptors) {
            if ('value' in descriptor) {
                Reflect.defineProperty(guardedObject, property, {
                    ...descriptor,
                    value: guard(descriptor.value, value),
                });
            } else {
                Reflect.defineProperty(guardedObject, property, {
                    ...descriptor,
                    ...(descriptor.get ? {
                        get() {
                            assertActive();
                            const result = Reflect.apply(descriptor.get!, value, []);
                            assertActive();
                            return guard(result, value);
                        },
                    } : {}),
                    ...(descriptor.set ? {
                        set(nextValue: unknown) {
                            assertActive();
                            Reflect.apply(descriptor.set!, value, [nextValue]);
                            assertActive();
                        },
                    } : {}),
                });
            }
        }
        return Object.freeze(guardedObject);
    };

    return guard(params.value) as T;
}

export type TargetScmRuntimeEntries = Readonly<{
    backends: readonly Readonly<{ pluginId: string; generation: string; registration: ScmBackendRuntimeRegistration }>[];
    hostingProviders: readonly Readonly<{ pluginId: string; generation: string; registration: ScmHostingProviderRuntimeRegistration }>[];
}>;

export function createTargetScmRuntimeEntries(params: Readonly<{
    generation: number;
    activationTargets: readonly ActivationTarget[];
    targetRegistrations: readonly TargetRegistration[];
    isGenerationActive(): boolean;
}>): TargetScmRuntimeEntries {
    const backends: Array<Readonly<{ pluginId: string; generation: string; registration: ScmBackendRuntimeRegistration }>> = [];
    const hostingProviders: Array<Readonly<{ pluginId: string; generation: string; registration: ScmHostingProviderRuntimeRegistration }>> = [];

    for (const entry of params.targetRegistrations) {
        if (entry.registration.family !== 'scmBackends' && entry.registration.family !== 'scmHostingProviders') continue;
        if (entry.generation !== String(params.generation)) {
            throw new Error(`Target SCM registration '${entry.pluginId}/${entry.registration.localId}' was published for the wrong generation`);
        }
        const target = params.activationTargets.find((candidate) => candidate.pluginId === entry.pluginId);
        if (!target) {
            throw new Error(`Target SCM registration '${entry.pluginId}/${entry.registration.localId}' has no activation target`);
        }
        if (entry.registration.family === 'scmBackends') {
            const declaration = target.manifest.contributes.scmBackends.find(
                (backend) => backend.id === entry.registration.localId,
            );
            if (!declaration) {
                throw new Error(`Target SCM backend registration '${entry.pluginId}/${entry.registration.localId}' has no matching manifest contribution`);
            }
            backends.push(Object.freeze({
                pluginId: target.pluginId,
                generation: entry.generation,
                registration: guardRuntimeValue({
                    value: Object.freeze({ id: declaration.id, ...entry.registration.value }),
                    pluginId: target.pluginId,
                    family: 'scmBackends',
                    isGenerationActive: params.isGenerationActive,
                }),
            }));
            continue;
        }
        const declaration = target.manifest.contributes.scmHostingProviders.find(
            (provider) => provider.id === entry.registration.localId,
        );
        if (!declaration) {
            throw new Error(`Target SCM hosting-provider registration '${entry.pluginId}/${entry.registration.localId}' has no matching manifest contribution`);
        }
        hostingProviders.push(Object.freeze({
            pluginId: target.pluginId,
            generation: entry.generation,
            registration: guardRuntimeValue({
                value: Object.freeze({ id: declaration.id, ...entry.registration.value }),
                pluginId: target.pluginId,
                family: 'scmHostingProviders',
                isGenerationActive: params.isGenerationActive,
            }),
        }));
    }

    return Object.freeze({
        backends: Object.freeze(backends),
        hostingProviders: Object.freeze(hostingProviders),
    });
}
