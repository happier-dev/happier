import { SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunchError';
import { join } from 'node:path';

import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { projectAgentSessionProviderBindingV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import type { BackendTargetRefV2Input, ConnectedServiceBindingsV2, ProviderBoundModelRef, TeamCredentialProviderModelSelectionV1, ProviderErrorV1 } from '@happier-dev/protocol';
import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';

import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { readLeasedAgentProviderRequirements } from '@/plugins/runtime/providerBindings/adapter';
import { prepareDirectProviderLaunch, type DirectManagedProviderEndpointPreparer } from '@/providers/lifecycle/prepareDirectLaunch';
import { prepareProviderLaunch } from '@/providers/lifecycle/prepareLaunch';
import type { ProviderLaunchCleanup } from '@/providers/lifecycle/resourceScope';
import { createProviderRuntimeStateStore } from '@/providers/runtimeState';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import type { ProviderRuntimeModelProjectionReader } from '@/providers/spawn/runtimeCatalog';
import type { ResolveManagedProviderPurposeBindingIntent } from '@/providers/managed/resolvePurposeBindingSnapshot';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createExecutionRunCodedError } from '../errors';

type Cleanup = (() => void | Promise<void>) | null;

export type ExecutionRunProviderSelectionInput = Readonly<{
    signal?: AbortSignal;
    selection: ProviderBoundModelRef;
    backendTarget: BackendTargetRefV2Input;
    machineId?: string;
    agentId: string;
    runId: string;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    featureEnabled: boolean;
    happyHomeDir: string;
    accountSettingsSnapshot?: ActiveAccountSettingsSnapshot | null;
    readAccountSettingsSnapshot?: () => ActiveAccountSettingsSnapshot | null;
    savedSecretOperationContext?: SavedSecretOperationContextV1;
    resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
    readModelProjection?: ProviderRuntimeModelProjectionReader;
    /** Borrowed from this Run's pinned daemon snapshot; its owner releases it. */
    runtimeRegistryLease?: PluginRuntimeRegistryLease;
}>;

/** Only the caller's exact choice crosses the existing snapshot service seam. */
export type ExecutionRunProviderLaunchRequest = Readonly<{
    selection: ProviderBoundModelRef;
    teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
    backendTarget: BackendTargetRefV2Input;
    agentId: string;
    runId: string;
    controllerOccurrenceId?: string;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    expectedAccountSettingsScopeKey: string;
}>;

export type ExecutionRunProviderLaunchServices = Readonly<{
    admitInheritedSelection(input: ExecutionRunProviderLaunchRequest, signal?: AbortSignal): Promise<void>;
    prepareLaunch(input: ExecutionRunProviderLaunchRequest, signal?: AbortSignal): Promise<PreparedExecutionRunProviderLaunch>;
}>;

/** Authorizes a rematched child choice without materializing credentials or launching a runtime. */
export async function admitExecutionRunInheritedProviderSelection(input: ExecutionRunProviderSelectionInput): Promise<void> {
    if (input.selection.providerConnectionId === null) return;
    validateExecutionRunProviderSelectionInput(input);
    const lease = input.runtimeRegistryLease ?? await acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: input.happyHomeDir });
    try {
        const prepared = await prepareProviderLaunch(createExecutionRunProviderPreparation(input, lease));
        if (!prepared.ok) throw inheritedProviderRefusal(prepared.error);
        if (prepared.kind !== 'provider') {
            throw inheritedProviderRefusal(createProviderErrorV1('provider_incompatible_with_agent', {
                connectionId: input.selection.providerConnectionId,
                ...(input.machineId ? { machineId: input.machineId } : {}),
            }));
        }
        await prepared.attempt.cleanupOnFailure();
    } finally {
        if (!input.runtimeRegistryLease) await lease.release();
    }
}

export type PreparedExecutionRunProviderLaunch = Readonly<{
    environment: Readonly<Record<string, string>>;
    unsetEnvKeys: readonly string[];
    connectedServices?: ConnectedServiceBindingsV2 | null;
    providerBinding?: AgentSessionProviderBinding;
    sanitizeDiagnosticText: (value: string) => string;
    additionalRedactionValues: readonly string[];
    revalidateBeforeCommit: (signal?: AbortSignal) => Promise<Readonly<
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
    return Object.assign(new Error(error.code), { code: error.code, details: { providerError: error } });
}

function inheritedProviderRefusal(error: ProviderErrorV1): Error {
    switch (error.code) {
        case 'provider_incompatible_with_agent':
        case 'provider_compatibility_unverified':
        case 'provider_agent_runtime_unsupported':
        case 'provider_model_not_found':
        case 'provider_model_unloaded': {
            const code = 'execution_run_child_choice_required';
            return Object.assign(createExecutionRunCodedError(code,
                'Choose a Provider and exact model supported by the child Agent.'), { code, details: { providerError: error } });
        }
        default: return refusal(error);
    }
}

function validateExecutionRunProviderSelectionInput(input: ExecutionRunProviderSelectionInput): void {
    const context = {
        connectionId: input.selection.providerConnectionId ?? undefined,
        ...(input.machineId ? { machineId: input.machineId } : {}),
    };
    if (!input.runId.trim()) throw refusal(createProviderErrorV1('provider_agent_runtime_unsupported', context));
    if (!input.accountSettingsSnapshot) throw refusal(createProviderErrorV1('provider_connection_not_found', context));
}

function createExecutionRunProviderPreparation(
    input: ExecutionRunProviderSelectionInput,
    lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>>,
): Parameters<typeof prepareProviderLaunch>[0] {
    const operationContext = input.savedSecretOperationContext;
    return {
        selection: { v: 1, ref: input.selection, updatedAt: Date.now() },
        backendTarget: input.backendTarget,
        machineId: input.machineId,
        agentId: input.agentId,
        previousBinding: null,
        confirmation: null,
        connectedServices: input.connectedServices ?? null,
        featureEnabled: input.featureEnabled,
        resolvePrerequisites: async () => {
            const requirements = readLeasedAgentProviderRequirements({ lease, agentId: input.agentId });
            return requirements
                ? { ok: true as const }
                : { ok: false as const, error: createProviderErrorV1('provider_incompatible_with_agent', {
                    connectionId: input.selection.providerConnectionId ?? undefined,
                    ...(input.machineId ? { machineId: input.machineId } : {}),
                }) };
        },
        createAuthorizationAttempt: async ({ selection, machineId, agentTargetKey, agentId }) =>
            createRuntimeProviderSpawnAuthorizationAttempt({
                signal: input.signal,
                selection, machineId, agentTargetKey, agentId, lease,
                // Each child is authorized against its owning Account, never
                // the process-global Account of another active Session.
                getAccountSettingsSnapshot: input.readAccountSettingsSnapshot
                    ?? (operationContext ? () => operationContext.readSnapshot()
                        : () => input.accountSettingsSnapshot ?? null),
                savedSecretOperationContext: input.savedSecretOperationContext,
                runtimeStateStore: createProviderRuntimeStateStore({ happyHomeDir: input.happyHomeDir, machineId }),
                materializationBaseDir: join(input.happyHomeDir, 'providers', 'materialized'),
                scope: { kind: 'execution_run', executionRunId: input.runId },
                resolveManagedPurposeBindingIntent: input.resolveManagedPurposeBindingIntent,
                readModelProjection: input.readModelProjection,
            }),
    };
}

const nativeLaunch = Object.freeze({
    environment: Object.freeze({}),
    unsetEnvKeys: Object.freeze([]),
    sanitizeDiagnosticText: (value: string) => value,
    additionalRedactionValues: Object.freeze([]),
    revalidateBeforeCommit: async () => Object.freeze({ ok: true as const }),
    cleanupOnExit: null,
});

/**
 * Canonical execution-run adapter over the shared direct Provider lifecycle.
 * The structured selection is re-authorized and re-materialized for each
 * runtime creation; only the resulting bounded SDK inputs live for the run.
 */
export async function prepareExecutionRunProviderLaunch(input: Readonly<{
    signal?: AbortSignal;
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
    readAccountSettingsSnapshot?: () => ActiveAccountSettingsSnapshot | null;
    savedSecretOperationContext?: SavedSecretOperationContextV1;
    prepareTeamCredentialProviderBinding?: ExecutionRunTeamCredentialProviderBindingPreparer;
    resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
    readModelProjection?: ProviderRuntimeModelProjectionReader;
    prepareManagedEndpoint?: DirectManagedProviderEndpointPreparer;
    retainCleanup?: (cleanup: ProviderLaunchCleanup) => void;
    runtimeRegistryLease?: PluginRuntimeRegistryLease;
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
            const cleanupOnExit = async () => {
                try { await teamBinding.cleanup(); } finally { redaction.close(); }
            };
            input.retainCleanup?.(cleanupOnExit);
            return Object.freeze({
                environment: Object.freeze(environment),
                unsetEnvKeys: Object.freeze(unsetEnvKeys),
                ...(input.connectedServices !== undefined
                    ? { connectedServices: input.connectedServices }
                    : {}),
                providerBinding: teamBinding.providerBinding,
                sanitizeDiagnosticText: redaction.redact,
                additionalRedactionValues: redaction.values(),
                revalidateBeforeCommit: async () => Object.freeze({ ok: true as const }),
                cleanupOnExit,
            });
        }
        if (input.teamCredentialModel) {
            throw new SessionTeamCredentialLaunchUnavailableError();
        }
    }
    if (input.teamCredentialModel) {
        throw new SessionTeamCredentialLaunchUnavailableError();
    }
    if (!input.selection || input.selection.providerConnectionId === null) {
        return nativeLaunch;
    }
    const providerInput = { ...input, selection: input.selection };
    validateExecutionRunProviderSelectionInput(providerInput);

    const lease = input.runtimeRegistryLease ?? await acquireAuthoritativePluginRuntimeRegistryLease({
        happyHomeDir: input.happyHomeDir,
    });
    const { resolvePrerequisites, createAuthorizationAttempt, ...launchInput } = createExecutionRunProviderPreparation(providerInput, lease);
    const direct = await prepareDirectProviderLaunch({
        signal: input.signal,
        ...launchInput,
        scope: { kind: 'execution_run', executionRunId: input.runId },
    }, {
        initialResources: input.runtimeRegistryLease ? [] : [{
            onFailure: lease.release,
            onExit: lease.release,
        }],
        resolvePrerequisites,
        createAuthorizationAttempt,
        prepareManagedEndpoint: input.prepareManagedEndpoint,
        retainCleanup: input.retainCleanup,
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
        additionalRedactionValues: direct.additionalRedactionValues,
        revalidateBeforeCommit: direct.revalidateBeforeCommit,
        cleanupOnExit: direct.cleanupOnExit,
    });
}
