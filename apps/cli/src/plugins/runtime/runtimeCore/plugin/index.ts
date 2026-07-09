import type {
    BackendExecutionSurfaces,
    CliRuntimeCore,
    CliRuntimeCoreFactory,
    CliRuntimeCoreParams,
} from '@/agent/runtime/registry/engineRegistryTypes';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import type { ResolvedAgentRuntimeContribution, ResolvedAgentContribution } from '@/plugins/projection/registry/types';

import { createPluginExecutionRunBackend } from './executionRun';
import { createPluginSessionRuntimePlan } from './session';
import {
    buildPluginSessionBindingInput,
    type PluginSessionLaunchHandler,
} from './sessionLaunch';
import type { PluginSessionLaunchResultCandidate } from './sessionMetadata';

function createPluginRuntimeCore(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    provider: ResolvedAgentContribution;
    executionSurfaces: BackendExecutionSurfaces;
}>): CliRuntimeCore {
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

export function createPluginRuntimeCoreFactory(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    provider: ResolvedAgentContribution;
}>): CliRuntimeCoreFactory {
    return (runtimeCoreParams: CliRuntimeCoreParams) => Object.freeze({
        runtimeCore: createPluginRuntimeCore({
            backend: params.backend,
            provider: params.provider,
            executionSurfaces: runtimeCoreParams.executionSurfaces,
        }),
    });
}
