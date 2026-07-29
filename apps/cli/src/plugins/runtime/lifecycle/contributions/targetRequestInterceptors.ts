import type {
    PluginRequestInterceptorContributionV1,
} from '@happier-dev/protocol';
import type { PluginRequestInterceptor } from '@happier-dev/plugin-sdk/runtime';

import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';

import type { ActivationTarget } from '../activation/targets';

type TargetRegistration = Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}>;

export type TargetRequestInterceptorBinding = Readonly<{
    pluginId: string;
    pluginVersion: string;
    generation: string;
    contribution: PluginRequestInterceptorContributionV1;
    handler: PluginRequestInterceptor;
}>;

export function createTargetRequestInterceptorBindings(params: Readonly<{
    generation: number;
    activationTargets: readonly ActivationTarget[];
    targetRegistrations: readonly TargetRegistration[];
    isGenerationActive(): boolean;
}>): readonly TargetRequestInterceptorBinding[] {
    const bindings: TargetRequestInterceptorBinding[] = [];
    const identities = new Set<string>();

    for (const entry of params.targetRegistrations) {
        if (entry.registration.family !== 'requestInterceptors') continue;
        if (entry.generation !== String(params.generation)) {
            throw new Error(`Target request interceptor '${entry.pluginId}/${entry.registration.localId}' was published for the wrong generation`);
        }
        const target = params.activationTargets.find((candidate) => candidate.pluginId === entry.pluginId);
        const contribution = target?.manifest.contributes.requestInterceptors.find(
            (candidate) => candidate.id === entry.registration.localId,
        );
        if (!target || !contribution) {
            throw new Error(`Target request interceptor '${entry.pluginId}/${entry.registration.localId}' has no matching manifest contribution`);
        }
        const identity = `${entry.pluginId}\u0000requestInterceptors\u0000${entry.registration.localId}`;
        if (identities.has(identity)) {
            throw new Error(`Duplicate target request interceptor '${entry.pluginId}/${entry.registration.localId}'`);
        }
        identities.add(identity);
        const handler = entry.registration.value;
        const fencedHandler: PluginRequestInterceptor = function (this: unknown, request, context) {
            if (!params.isGenerationActive()) {
                throw new Error(`Plugin '${entry.pluginId}' request interceptor '${entry.registration.localId}' is no longer active`);
            }
            const result = Reflect.apply(handler, this, [request, context]);
            return Promise.resolve(result).then(
                (resolved) => {
                    if (!params.isGenerationActive()) {
                        throw new Error(`Plugin '${entry.pluginId}' request interceptor '${entry.registration.localId}' retired during invocation`);
                    }
                    return resolved;
                },
                (error: unknown) => {
                    if (!params.isGenerationActive()) {
                        throw new Error(`Plugin '${entry.pluginId}' request interceptor '${entry.registration.localId}' retired during invocation`);
                    }
                    throw error;
                },
            );
        };
        bindings.push(Object.freeze({
            pluginId: entry.pluginId,
            pluginVersion: target.manifest.version,
            generation: entry.generation,
            contribution,
            handler: fencedHandler,
        }));
    }

    return Object.freeze(bindings);
}
