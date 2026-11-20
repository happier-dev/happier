import { isDeepStrictEqual } from 'node:util';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { AgentSessionProviderBindingV1Schema } from '@happier-dev/protocol/providers/sessions/agentSessionProviderBindingV1';
import type { SessionEnvOverlayV1 } from '@happier-dev/protocol';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ProviderLaunchCleanup } from '@/providers/lifecycle/resourceScope';
import type { DirectManagedProviderEndpointPreparer } from '@/providers/lifecycle/prepareDirectLaunch';
import type { RunnerExecutionRunSnapshotV1 } from '@/agent/runtime/session/process/executionRunSnapshotProtocol';
import { logger } from '@/ui/logger';
import {
    prepareExecutionRunProviderLaunch,
    type ExecutionRunProviderSelectionInput,
    type ExecutionRunProviderLaunchRequest,
    type ExecutionRunProviderLaunchServices,
    type ExecutionRunTeamCredentialProviderBindingPreparer,
    type PreparedExecutionRunProviderLaunch,
} from '@/agent/runtime/bridges/executionRun/runtime/providerLaunch';

export type RunnerExecutionRunProviderPreparation = Omit<ExecutionRunProviderSelectionInput,
    'selection' | 'sessionConfigOptionOverrides' | 'backendTarget' | 'agentId' | 'runId' | 'connectedServices' | 'runtimeRegistryLease'> & Readonly<{
    prepareManagedEndpoint?: DirectManagedProviderEndpointPreparer;
    prepareTeamCredentialProviderBinding?: ExecutionRunTeamCredentialProviderBindingPreparer;
    readCurrentnessRefusal(): Promise<RunProviderAuthorizationRefusal | null>;
}>;

export type RunProviderAuthorizationRefusal =
    | 'daemon_account_missing' | 'request_account_missing' | 'request_account_mismatch' | 'request_settings_scope_mismatch'
    | 'request_home_identity_mismatch' | 'request_machine_mismatch' | 'request_home_origin_mismatch'
    | 'daemon_work_aborted' | 'daemon_publication_quiescing' | 'tracked_runner_replaced' | 'tracked_runner_retiring'
    | 'tracked_session_mismatch' | 'requester_custody_replaced' | 'account_settings_lifetime_changed'
    | 'session_account_no_longer_current' | 'account_settings_snapshot_missing' | 'account_settings_snapshot_scope_mismatch'
    | 'account_settings_snapshot_unreadable'
    | 'run_runner_missing' | 'run_snapshot_retired' | 'run_snapshot_replaced' | 'runner_service_no_longer_current'
    | 'retained_agent_missing' | 'retained_agent_mismatch' | 'retained_backend_mismatch' | 'run_backend_mismatch'
    | 'agent_registration_missing' | 'agent_factory_binding_mismatch' | 'agent_registration_retired'
    | 'run_preparation_missing';

export function reportRunProviderAuthorizationRefusal(
    reason: RunProviderAuthorizationRefusal,
    scopeKind: 'requester_account' | 'daemon_account' | 'runner_snapshot',
    code: 'provider_authorization_changed' | 'provider_endpoint_unavailable' = 'provider_authorization_changed',
) {
    try {
        logger.infoFile('[PROVIDER] Run authorization refused', JSON.stringify({ code, reason, scopeKind }));
    } catch { /* A diagnostic sink cannot replace the refusal. */ }
    return createProviderErrorV1(code, { failureCause: {
        phase: 'execution_run.provider_authorization', errorClass: 'Error', errorCode: code,
        httpStatus: null, nativeErrorReason: reason,
    } });
}

/** Adapts the incumbent Provider policy to a Run's existing executable lease.
 * Account and endpoint authority are supplied by the tracked-runner service owner. */
export function createRunnerExecutionRunProviderLaunchServices(input: Readonly<{
    agent: RunnerExecutionRunSnapshotV1['agent'];
    backendTarget: ExecutionRunProviderLaunchRequest['backendTarget'];
    runtimeRegistryLease: PluginRuntimeRegistryLease;
    resolvePreparation(request: ExecutionRunProviderLaunchRequest): Promise<RunnerExecutionRunProviderPreparation | null>;
    retainCleanup(cleanup: ProviderLaunchCleanup): void;
}>): ExecutionRunProviderLaunchServices {
    const changed = (reason: RunProviderAuthorizationRefusal) => reportRunProviderAuthorizationRefusal(reason, 'runner_snapshot');
    const readSourceRefusal = (request: ExecutionRunProviderLaunchRequest): RunProviderAuthorizationRefusal | null => {
        if (!input.agent) return 'retained_agent_missing';
        if (input.agent.descriptor.agentId !== request.agentId) return 'retained_agent_mismatch';
        if (input.agent.descriptor.backendId !== readBackendTargetRefV2(request.backendTarget).backendId) return 'retained_backend_mismatch';
        if (buildBackendTargetKeyV2(readBackendTargetRefV2(input.backendTarget)) !== buildBackendTargetKeyV2(readBackendTargetRefV2(request.backendTarget))) {
            return 'run_backend_mismatch';
        }
        const registration = input.runtimeRegistryLease.registry.agentRuntimesByAgentId.get(request.agentId);
        if (!registration) return 'agent_registration_missing';
        if (!isDeepStrictEqual(input.agent.binding, registration.sessionRunnerFactoryBinding)) return 'agent_factory_binding_mismatch';
        return registration.isCurrent() ? null : 'agent_registration_retired';
    };
    const resolve = async (request: ExecutionRunProviderLaunchRequest) => {
        const sourceRefusal = readSourceRefusal(request);
        if (sourceRefusal) throw changed(sourceRefusal);
        const preparation = await input.resolvePreparation(request);
        if (!preparation) throw changed('run_preparation_missing');
        if (!preparation.accountSettingsSnapshot) throw changed('account_settings_snapshot_missing');
        if (preparation.accountSettingsSnapshot.scopeKey !== request.expectedAccountSettingsScopeKey) throw changed('account_settings_snapshot_scope_mismatch');
        const refusal = readSourceRefusal(request) ?? await preparation.readCurrentnessRefusal();
        if (refusal) throw changed(refusal);
        return preparation;
    };
    return Object.freeze({
        async prepareLaunch(request, signal) {
            const preparation = await resolve(request);
            const prepared = await prepareExecutionRunProviderLaunch({ ...request, ...preparation,
                signal: signal ?? preparation.signal,
                runtimeRegistryLease: input.runtimeRegistryLease, retainCleanup: input.retainCleanup });
            const readRefusal = async () => readSourceRefusal(request) ?? await preparation.readCurrentnessRefusal();
            const preparationRefusal = await readRefusal();
            if (preparationRefusal) { await prepared.cleanupOnExit?.(); throw changed(preparationRefusal); }
            return Object.freeze({ ...prepared,
                revalidateBeforeCommit: async (signal?: AbortSignal) => {
                    let reason = await readRefusal();
                    if (!reason) {
                        const result = await prepared.revalidateBeforeCommit(signal);
                        reason = await readRefusal();
                        if (!reason) return result;
                    }
                    await prepared.cleanupOnExit?.();
                    return { ok: false as const, error: { ...changed(reason),
                        ...(request.selection?.providerConnectionId ? { connectionId: request.selection.providerConnectionId } : {}),
                        ...(preparation.machineId ? { machineId: preparation.machineId } : {}),
                    } };
                },
            });
        },
    });
}

export function projectRunnerExecutionRunProviderLaunch(prepared: PreparedExecutionRunProviderLaunch) {
    const environmentOverlay: SessionEnvOverlayV1 = [
        ...Object.entries(prepared.environment).map(([name, value]) => ({ name, value, source: 'provider' as const })),
        ...prepared.unsetEnvKeys.map(name => ({ name, value: null, source: 'provider' as const })),
    ];
    return { ok: true as const, environmentOverlay,
        ...(prepared.providerBinding ? { providerBinding: AgentSessionProviderBindingV1Schema.parse(prepared.providerBinding) } : {}),
        ...(prepared.connectedServices !== undefined ? { connectedServices: prepared.connectedServices } : {}),
        additionalRedactionValues: [...prepared.additionalRedactionValues] };
}
