import { isDeepStrictEqual } from 'node:util';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { AgentSessionProviderBindingV1Schema } from '@happier-dev/protocol/providers/sessions/agentSessionProviderBindingV1';
import type { SessionEnvOverlayV1 } from '@happier-dev/protocol';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ProviderLaunchCleanup } from '@/providers/lifecycle/resourceScope';
import type { DirectManagedProviderEndpointPreparer } from '@/providers/lifecycle/prepareDirectLaunch';
import type { RunnerExecutionRunSnapshotV1 } from '@/agent/runtime/session/process/executionRunSnapshotProtocol';
import {
    admitExecutionRunInheritedProviderSelection,
    prepareExecutionRunProviderLaunch,
    type ExecutionRunProviderSelectionInput,
    type ExecutionRunProviderLaunchRequest,
    type ExecutionRunProviderLaunchServices,
    type ExecutionRunTeamCredentialProviderBindingPreparer,
    type PreparedExecutionRunProviderLaunch,
} from '@/agent/runtime/bridges/executionRun/runtime/providerLaunch';

export type RunnerExecutionRunProviderPreparation = Omit<ExecutionRunProviderSelectionInput,
    'selection' | 'backendTarget' | 'agentId' | 'runId' | 'connectedServices' | 'runtimeRegistryLease'> & Readonly<{
    prepareManagedEndpoint?: DirectManagedProviderEndpointPreparer;
    prepareTeamCredentialProviderBinding?: ExecutionRunTeamCredentialProviderBindingPreparer;
    isCurrent(): boolean | Promise<boolean>;
}>;

/** Adapts the incumbent Provider policy to a Run's existing executable lease.
 * Account and endpoint authority are supplied by the tracked-runner service owner. */
export function createRunnerExecutionRunProviderLaunchServices(input: Readonly<{
    agent: RunnerExecutionRunSnapshotV1['agent'];
    backendTarget: ExecutionRunProviderLaunchRequest['backendTarget'];
    runtimeRegistryLease: PluginRuntimeRegistryLease;
    resolvePreparation(request: ExecutionRunProviderLaunchRequest): Promise<RunnerExecutionRunProviderPreparation | null>;
    retainCleanup(cleanup: ProviderLaunchCleanup): void;
}>): ExecutionRunProviderLaunchServices {
    const changed = () => Object.assign(new Error('provider_authorization_changed'), { code: 'provider_authorization_changed' });
    const isSourceCurrent = (request: ExecutionRunProviderLaunchRequest) => {
        const registration = input.runtimeRegistryLease.registry.agentRuntimesByAgentId.get(request.agentId);
        return Boolean(input.agent && input.agent.descriptor.agentId === request.agentId
            && input.agent.descriptor.backendId === readBackendTargetRefV2(request.backendTarget).backendId
            && buildBackendTargetKeyV2(readBackendTargetRefV2(input.backendTarget)) === buildBackendTargetKeyV2(readBackendTargetRefV2(request.backendTarget))
            && isDeepStrictEqual(input.agent.binding, registration?.sessionRunnerFactoryBinding)
            && registration?.isCurrent());
    };
    const resolve = async (request: ExecutionRunProviderLaunchRequest) => {
        if (!isSourceCurrent(request)) throw changed();
        const preparation = await input.resolvePreparation(request);
        if (!preparation || preparation.accountSettingsSnapshot?.scopeKey !== request.expectedAccountSettingsScopeKey
            || !isSourceCurrent(request) || !await preparation.isCurrent()) throw changed();
        return preparation;
    };
    return Object.freeze({
        async admitInheritedSelection(request, signal) {
            const preparation = await resolve(request);
            await admitExecutionRunInheritedProviderSelection({ ...request, ...preparation,
                signal: signal ?? preparation.signal,
                runtimeRegistryLease: input.runtimeRegistryLease });
            if (!isSourceCurrent(request) || !await preparation.isCurrent()) throw changed();
        },
        async prepareLaunch(request, signal) {
            const preparation = await resolve(request);
            const prepared = await prepareExecutionRunProviderLaunch({ ...request, ...preparation,
                signal: signal ?? preparation.signal,
                runtimeRegistryLease: input.runtimeRegistryLease, retainCleanup: input.retainCleanup });
            const isCurrent = async () => isSourceCurrent(request) && await preparation.isCurrent();
            if (!await isCurrent()) { await prepared.cleanupOnExit?.(); throw changed(); }
            return Object.freeze({ ...prepared,
                revalidateBeforeCommit: async (signal?: AbortSignal) => {
                    if (await isCurrent()) {
                        const result = await prepared.revalidateBeforeCommit(signal);
                        if (await isCurrent()) return result;
                    }
                    await prepared.cleanupOnExit?.();
                    return { ok: false as const, error: createProviderErrorV1('provider_authorization_changed', {
                        connectionId: request.selection.providerConnectionId ?? undefined,
                        ...(preparation.machineId ? { machineId: preparation.machineId } : {}),
                    }) };
                },
            });
        },
    });
}

export function projectRunnerExecutionRunProviderLaunch(prepared: PreparedExecutionRunProviderLaunch) {
    if (!prepared.providerBinding) throw Object.assign(new Error('provider_incompatible_with_agent'), { code: 'provider_incompatible_with_agent' });
    const environmentOverlay: SessionEnvOverlayV1 = [
        ...Object.entries(prepared.environment).map(([name, value]) => ({ name, value, source: 'provider' as const })),
        ...prepared.unsetEnvKeys.map(name => ({ name, value: null, source: 'provider' as const })),
    ];
    return { ok: true as const, environmentOverlay, providerBinding: AgentSessionProviderBindingV1Schema.parse(prepared.providerBinding),
        ...(prepared.connectedServices !== undefined ? { connectedServices: prepared.connectedServices } : {}),
        additionalRedactionValues: [...prepared.additionalRedactionValues] };
}
