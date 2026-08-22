import type {
    BackendRuntimeRegistration as ScmBackendRuntimeRegistration,
} from '@happier-dev/plugin-sdk/scm/backend';
import type {
    HostingProviderRuntimeRegistration as ScmHostingProviderRuntimeRegistration,
} from '@happier-dev/plugin-sdk/scm/hosting';

import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';
import { createGuardedRuntimeView } from '@/plugins/runtime/guardedRuntimeView';

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

/**
 * Registration already owns method identity and static-data capture. This
 * target adapter only fences the committed generation's values at invocation;
 * it deliberately does not clone descriptors, walk prototypes, bind
 * receivers, or recapture author-owned structure. The guarded view mirrors the
 * captured object's structure instead, so enumeration and property access
 * report the same members.
 */
function guardCapturedRuntimeValue<T>(params: Readonly<{
    value: T;
    pluginId: string;
    family: 'scmBackends' | 'scmHostingProviders';
    isGenerationActive(): boolean;
}>): T {
    const guardedByValue = new WeakMap<object, object>();
    const assertActive = (): void => {
        if (!params.isGenerationActive()) {
            throw new Error(`Plugin '${params.pluginId}' ${params.family} runtime is no longer active`);
        }
    };
    const assertOperationNotAborted = (args: readonly unknown[]): void => {
        const input = args[0];
        if (!input || typeof input !== 'object') return;
        const operationInput = input as Readonly<{
            signal?: unknown;
            context?: Readonly<{ signal?: unknown }>;
        }>;
        const operationSignals = [operationInput.signal, operationInput.context?.signal];
        if (operationSignals.some((signal) => signal instanceof AbortSignal && signal.aborted)) {
            throw new Error(`Plugin '${params.pluginId}' ${params.family} operation was aborted`);
        }
    };

    const guard = (value: unknown): unknown => {
        if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value;

        if (typeof value === 'function') {
            const cached = guardedByValue.get(value);
            if (cached) return cached;
            const runtimeFunction = value as (...args: readonly unknown[]) => unknown;
            const guardedFunction = function (this: unknown, ...args: readonly unknown[]): unknown {
                assertActive();
                assertOperationNotAborted(args);
                const result = Reflect.apply(runtimeFunction, this, args);
                const then = readPromiseLikeThen(result);
                if (then) {
                    const settled = new Promise<unknown>((resolve, reject) => {
                        try {
                            Reflect.apply(then, result, [resolve, reject]);
                        } catch (error) {
                            reject(error);
                        }
                    });
                    return settled.then(
                        (resolved) => {
                            assertActive();
                            return resolved;
                        },
                        (error: unknown) => {
                            assertActive();
                            throw error;
                        },
                    );
                }
                assertActive();
                return result;
            };
            const frozenGuardedFunction = Object.freeze(guardedFunction);
            guardedByValue.set(value, frozenGuardedFunction);
            return frozenGuardedFunction;
        }

        const cached = guardedByValue.get(value as object);
        if (cached) return cached;
        const guardedObject = createGuardedRuntimeView({ owner: value as object, guard });
        guardedByValue.set(value as object, guardedObject);
        return guardedObject;
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
                registration: Object.freeze({
                    id: declaration.id,
                    ...(entry.registration.value.runtime === undefined
                        ? {}
                        : { runtime: entry.registration.value.runtime }),
                    handlers: guardCapturedRuntimeValue({
                        value: entry.registration.value.handlers,
                        pluginId: target.pluginId,
                        family: 'scmBackends',
                        isGenerationActive: params.isGenerationActive,
                    }),
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
            registration: Object.freeze({
                id: declaration.id,
                adapter: guardCapturedRuntimeValue({
                    value: entry.registration.value.adapter,
                    pluginId: target.pluginId,
                    family: 'scmHostingProviders',
                    isGenerationActive: params.isGenerationActive,
                }),
            }),
        }));
    }

    return Object.freeze({
        backends: Object.freeze(backends),
        hostingProviders: Object.freeze(hostingProviders),
    });
}
