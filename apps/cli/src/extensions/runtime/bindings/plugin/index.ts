import type {
    BackendExecutionSurfaces,
    CliBindingsFactory,
    CliBindingsParams,
    CliRuntimeBindings,
} from '@/agent/runtime/registry/engineRegistryTypes';
import type { HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';
import type { ResolvedBackendContribution, ResolvedProviderContribution } from '@/extensions/registry/types';

import { createPluginExecutionRunBackend } from './executionRun';
import { createPluginSessionRuntimePlan } from './session';
import {
    buildPluginSessionBindingInput,
    type PluginSessionLaunchHandler,
} from './sessionLaunch';
import type { PluginSessionLaunchResultCandidate } from './sessionMetadata';

function createPluginBindingRuntime(params: Readonly<{
    backend: ResolvedBackendContribution;
    provider: ResolvedProviderContribution;
    executionSurfaces: BackendExecutionSurfaces;
}>): CliRuntimeBindings {
    const launch = params.executionSurfaces.terminalRuntime?.launch ?? null;

    return Object.freeze({
        async createSessionRuntime(sessionParams: unknown): Promise<HostSessionRuntimePlan> {
            if (typeof launch !== 'function') {
                throw new Error(`Backend '${params.backend.id}' is missing terminal runtime launch support`);
            }

            const sessionInput = buildPluginSessionBindingInput(sessionParams);
            const launchPluginSession: PluginSessionLaunchHandler = async (launchParams) =>
                await launch(launchParams) as PluginSessionLaunchResultCandidate;
            return await createPluginSessionRuntimePlan({
                backend: params.backend,
                provider: params.provider,
                launch: launchPluginSession,
                sessionInput,
            });
        },
        createExecutionRunBackend(opts) {
            if (typeof launch !== 'function') {
                throw new Error(`Backend '${params.backend.id}' is missing terminal runtime launch support`);
            }

            return createPluginExecutionRunBackend({
                backend: params.backend,
                launch,
                opts,
            });
        },
    });
}

export function createPluginBindings(params: Readonly<{
    backend: ResolvedBackendContribution;
    provider: ResolvedProviderContribution;
}>): CliBindingsFactory {
    return (bindingParams: CliBindingsParams) => Object.freeze({
        bindings: createPluginBindingRuntime({
            backend: params.backend,
            provider: params.provider,
            executionSurfaces: bindingParams.executionSurfaces,
        }),
    });
}
