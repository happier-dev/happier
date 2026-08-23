import { join } from 'node:path';

import {
    createProviderErrorV1,
    projectAgentSessionProviderBindingV1,
    type BackendTargetRefV2Input,
    type ConnectedServiceBindingsV1,
    type ProviderBoundModelRef,
    type ProviderErrorV1,
} from '@happier-dev/protocol';
import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';

import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { readLeasedAgentProviderRequirements } from '@/plugins/runtime/providerBindings/adapter';
import { prepareDirectProviderLaunch } from '@/providers/lifecycle/prepareDirectLaunch';
import { createProviderRuntimeStateStore } from '@/providers/runtimeState';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import {
    getActiveAccountSettingsSnapshot,
    subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

type Cleanup = (() => void | Promise<void>) | null;

export type PreparedExecutionRunProviderLaunch = Readonly<{
    environment: Readonly<Record<string, string>>;
    unsetEnvKeys: readonly string[];
    connectedServices?: ConnectedServiceBindingsV1 | null;
    providerBinding?: AgentSessionProviderBinding;
    sanitizeDiagnosticText: (value: string) => string;
    revalidateBeforeCommit: () => Promise<Readonly<
        { ok: true } | { ok: false; error: ProviderErrorV1 }
    >>;
    cleanupOnExit: Cleanup;
}>;

function refusal(error: ProviderErrorV1): Error & { code: string } {
    return Object.assign(new Error(error.code), { code: error.code });
}

const nativeLaunch = Object.freeze({
    environment: Object.freeze({}),
    unsetEnvKeys: Object.freeze([]),
    sanitizeDiagnosticText: (value: string) => value,
    revalidateBeforeCommit: async () => Object.freeze({ ok: true as const }),
    cleanupOnExit: null,
});

/**
 * Canonical execution-run adapter over the shared direct Provider lifecycle.
 * The structured selection is re-authorized and re-materialized for each
 * runtime creation; only the resulting bounded SDK inputs live for the run.
 */
export async function prepareExecutionRunProviderLaunch(input: Readonly<{
    selection?: ProviderBoundModelRef;
    backendTarget: BackendTargetRefV2Input;
    machineId?: string;
    agentId: string;
    runId: string;
    connectedServices?: ConnectedServiceBindingsV1 | null;
    featureEnabled: boolean;
    happyHomeDir: string;
}>): Promise<PreparedExecutionRunProviderLaunch> {
    if (!input.selection || input.selection.providerConnectionId === null) {
        return nativeLaunch;
    }
    if (!input.runId.trim()) {
        throw refusal(createProviderErrorV1('provider_agent_runtime_unsupported', {
            connectionId: input.selection.providerConnectionId,
            ...(input.machineId ? { machineId: input.machineId } : {}),
        }));
    }

    const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
        happyHomeDir: input.happyHomeDir,
    });
    const selection = Object.freeze({
        v: 1 as const,
        ref: input.selection,
        updatedAt: Date.now(),
    });
    const direct = await prepareDirectProviderLaunch({
        selection,
        backendTarget: input.backendTarget,
        machineId: input.machineId,
        agentId: input.agentId,
        sessionId: input.runId,
        previousBinding: null,
        confirmation: null,
        connectedServices: input.connectedServices ?? null,
        featureEnabled: input.featureEnabled,
    }, {
        initialResources: [{
            onFailure: lease.release,
            onExit: lease.release,
        }],
        resolvePrerequisites: async () => {
            const requirements = readLeasedAgentProviderRequirements({
                lease,
                agentId: input.agentId,
            });
            return requirements
                ? { ok: true as const }
                : {
                    ok: false as const,
                    error: createProviderErrorV1('provider_incompatible_with_agent', {
                        connectionId: input.selection!.providerConnectionId ?? undefined,
                        ...(input.machineId ? { machineId: input.machineId } : {}),
                    }),
                };
        },
        createAuthorizationAttempt: async ({
            selection: authorizedSelection,
            machineId,
            agentTargetKey,
            agentId,
        }) => createRuntimeProviderSpawnAuthorizationAttempt({
            selection: authorizedSelection,
            machineId,
            agentTargetKey,
            agentId,
            lease,
            getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
            subscribeAccountSettingsSnapshot: (listener) =>
                subscribeActiveAccountSettingsSnapshot(() => listener()),
            runtimeStateStore: createProviderRuntimeStateStore({
                happyHomeDir: input.happyHomeDir,
                machineId,
            }),
            materializationBaseDir: join(
                input.happyHomeDir,
                'providers',
                'materialized',
            ),
            sessionId: input.runId,
        }),
    });

    if (!direct.ok) {
        if ('kind' in direct && direct.kind === 'managed_provider_requires_daemon') {
            throw refusal(createProviderErrorV1('provider_agent_runtime_unsupported', {
                connectionId: input.selection.providerConnectionId,
                ...(input.machineId ? { machineId: input.machineId } : {}),
            }));
        }
        throw refusal(direct.error);
    }
    if (direct.kind !== 'provider') {
        await direct.cleanupOnExit?.();
        throw refusal(createProviderErrorV1('provider_incompatible_with_agent', {
            connectionId: input.selection.providerConnectionId,
            ...(input.machineId ? { machineId: input.machineId } : {}),
        }));
    }

    let projectedProviderBinding: AgentSessionProviderBinding;
    try {
        projectedProviderBinding = projectAgentSessionProviderBindingV1({
            metadata: direct.bindingMetadata,
            materialization: direct.launchMaterialization,
        });
    } catch {
        await direct.cleanupOnExit?.();
        throw refusal(createProviderErrorV1('provider_materialization_failed', {
            connectionId: input.selection.providerConnectionId,
            ...(input.machineId ? { machineId: input.machineId } : {}),
        }));
    }
    if (
        projectedProviderBinding.connectionId !== input.selection.providerConnectionId
        || projectedProviderBinding.model.id !== input.selection.modelId
    ) {
        await direct.cleanupOnExit?.();
        throw refusal(createProviderErrorV1('provider_authorization_changed', {
            connectionId: input.selection.providerConnectionId,
            ...(input.machineId ? { machineId: input.machineId } : {}),
        }));
    }

    return Object.freeze({
        environment: direct.environment,
        unsetEnvKeys: direct.unsetEnvKeys,
        ...(input.connectedServices !== undefined
            ? { connectedServices: direct.connectedServices }
            : {}),
        providerBinding: projectedProviderBinding,
        sanitizeDiagnosticText: direct.sanitizeDiagnosticText,
        revalidateBeforeCommit: direct.revalidateBeforeCommit,
        cleanupOnExit: direct.cleanupOnExit,
    });
}
