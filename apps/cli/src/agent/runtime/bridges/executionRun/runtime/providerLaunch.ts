import { join } from 'node:path';

import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { projectAgentSessionProviderBindingV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import type { BackendTargetRefV2Input, ConnectedServiceBindingsV2, ProviderBoundModelRef, TeamCredentialProviderModelSelectionV1, ProviderErrorV1 } from '@happier-dev/protocol';
import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';

import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { readLeasedAgentProviderRequirements } from '@/plugins/runtime/providerBindings/adapter';
import { prepareDirectProviderLaunch } from '@/providers/lifecycle/prepareDirectLaunch';
import { createProviderRuntimeStateStore } from '@/providers/runtimeState';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

type Cleanup = (() => void | Promise<void>) | null;

export type PreparedExecutionRunProviderLaunch = Readonly<{
    environment: Readonly<Record<string, string>>;
    unsetEnvKeys: readonly string[];
    connectedServices?: ConnectedServiceBindingsV2 | null;
    providerBinding?: AgentSessionProviderBinding;
    sanitizeDiagnosticText: (value: string) => string;
    revalidateBeforeCommit: () => Promise<Readonly<
        { ok: true } | { ok: false; error: ProviderErrorV1 }
    >>;
    cleanupOnExit: Cleanup;
}>;

/**
 * Host-owned adapter that opens one Team credential binding for an exact Run.
 * Session-owned Runs adapt their incumbent Session host through this seam;
 * detached Runs receive the daemon-owned opener for the authenticated Machine.
 */
export type ExecutionRunTeamCredentialProviderBindingPreparer = (input: Readonly<{
    runId: string;
    agentId: string;
    machineId?: string;
    selection?: TeamCredentialProviderModelSelectionV1;
}>) => Promise<Readonly<{
    providerBinding: AgentSessionProviderBinding;
    environmentOverlay: import('@happier-dev/protocol').SessionEnvOverlayV1;
    additionalRedactionValues: readonly string[];
    cleanup(): void | Promise<void>;
}> | null>;

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
    teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
    backendTarget: BackendTargetRefV2Input;
    machineId?: string;
    agentId: string;
    runId: string;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    featureEnabled: boolean;
    happyHomeDir: string;
    accountSettingsSnapshot?: ActiveAccountSettingsSnapshot | null;
    prepareTeamCredentialProviderBinding?: ExecutionRunTeamCredentialProviderBindingPreparer;
}>): Promise<PreparedExecutionRunProviderLaunch> {
    if (!input.selection && input.prepareTeamCredentialProviderBinding) {
        const teamBinding = await input.prepareTeamCredentialProviderBinding({
            runId: input.runId,
            agentId: input.agentId,
            ...(input.machineId ? { machineId: input.machineId } : {}),
            ...(input.teamCredentialModel ? { selection: input.teamCredentialModel } : {}),
        });
        if (teamBinding) {
            const environment: Record<string, string> = {};
            const unsetEnvKeys: string[] = [];
            for (const entry of teamBinding.environmentOverlay) {
                if (entry.value === null) unsetEnvKeys.push(entry.name);
                else environment[entry.name] = entry.value;
            }
            const redaction = createProviderRedactionLease({
                values: teamBinding.additionalRedactionValues,
            });
            return Object.freeze({
                environment: Object.freeze(environment),
                unsetEnvKeys: Object.freeze(unsetEnvKeys),
                ...(input.connectedServices !== undefined
                    ? { connectedServices: input.connectedServices }
                    : {}),
                providerBinding: teamBinding.providerBinding,
                sanitizeDiagnosticText: redaction.redact,
                revalidateBeforeCommit: async () => Object.freeze({ ok: true as const }),
                cleanupOnExit: async () => {
                    try { await teamBinding.cleanup(); } finally { redaction.close(); }
                },
            });
        }
        if (input.teamCredentialModel) {
            throw refusal(createProviderErrorV1('provider_connection_not_found', {
                connectionId: input.teamCredentialModel.resourceId,
                ...(input.machineId ? { machineId: input.machineId } : {}),
            }));
        }
    }
    if (input.teamCredentialModel) {
        throw refusal(createProviderErrorV1('provider_connection_not_found', {
            connectionId: input.teamCredentialModel.resourceId,
            ...(input.machineId ? { machineId: input.machineId } : {}),
        }));
    }
    if (!input.selection || input.selection.providerConnectionId === null) {
        return nativeLaunch;
    }
    if (!input.runId.trim()) {
        throw refusal(createProviderErrorV1('provider_agent_runtime_unsupported', {
            connectionId: input.selection.providerConnectionId,
            ...(input.machineId ? { machineId: input.machineId } : {}),
        }));
    }
    if (!input.accountSettingsSnapshot) {
        throw refusal(createProviderErrorV1('provider_connection_not_found', {
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
        scope: { kind: 'execution_run', executionRunId: input.runId },
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
            // A Run is authorized against its owning Account snapshot. It must
            // never borrow the process-global active Account when another
            // Session becomes active while this runtime is provisioning.
            getAccountSettingsSnapshot: () => input.accountSettingsSnapshot ?? null,
            runtimeStateStore: createProviderRuntimeStateStore({
                happyHomeDir: input.happyHomeDir,
                machineId,
            }),
            materializationBaseDir: join(
                input.happyHomeDir,
                'providers',
                'materialized',
            ),
            scope: { kind: 'execution_run', executionRunId: input.runId },
        }),
    });

    if (!direct.ok) {
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
