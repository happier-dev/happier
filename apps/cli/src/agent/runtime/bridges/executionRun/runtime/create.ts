import { randomUUID } from 'node:crypto';

import type { AgentId } from '@happier-dev/agents';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { convertBackendTargetRefV2ToV1, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AccountSettings, AcpConfigOptionOverridesV1, BackendTargetRefV1, BackendTargetRefV2, BackendTargetRefV2Input, ConnectedServiceBindingsV2, ExecutionRunConnectedServicesLaunchV1, PluginContributionIdentityV1, ProviderBoundModelRef, TeamCredentialProviderModelSelectionV1, SessionInputCausalPermissionAuthorityV1, SecretReferenceOverlayV1 } from '@happier-dev/protocol';

import type {
    ExecutionRunHostRuntime,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type {
    ExecutionRunHostRunScopeBinding,
    NativeAgentSessionInteractionHostBinding,
    ResolvedCliEngineRegistry,
} from '@/agent/runtime/registry/engineRegistryTypes';
import {
    buildExecutionRunRuntimeIdentityPublication,
    withExecutionRunRuntimeIdentityPublication,
} from '@/agent/runtime/identity/executionRunRuntimeIdentityPublication';
import type { ExecutionRunSessionStateTarget } from '@/agent/runtime/bridges/executionRun/sessionStateDelivery';
import type { ExecutionRunPermissionRequestStoreProvider } from '@/agent/runtime/bridges/executionRun/executionRunPermissionResponseTarget';
import type { ExecutionRunRetainedInteractionScope } from '@/agent/runtime/bridges/executionRun/retainedInteractionEligibility';
import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { resolveBackendEngineAdapterResolution } from '@/agent/runtime/registry/engineRegistry';
import { throwIfPluginRuntimeStartBlocked } from '@/agent/runtime/registry/throwIfPluginRuntimeStartBlocked';
import { configuration } from '@/configuration';
import { resolveBackendIsolationBundle } from '@/packagedRuntime/isolation/resolveBackendIsolationBundle';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { assertBackendEnabledByAccountSettings } from '@/settings/backendEnabled';
import { SavedSecretOperationAdmissionError } from '@/settings/secrets/hydrateSavedSecretCatalog';
import {
    LaunchSecretReferenceOverlayError,
    readLaunchSecretReferenceOverlayProviderErrorCodeV1,
    resolveSecretReferenceOverlayEnvironment,
} from '@/daemon/agentRuntime/resolveForegroundProfileSavedSecretEnvironment';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';

import { withExecutionRunHostRuntimeCleanup } from '../hostRuntime/cleanup';
import { createLazyExecutionRunHostRuntime } from '../hostRuntime/lazy';
import {
    hasConnectedExecutionRunBinding,
    resolveExecutionRunConnectedServicesEnv,
    resolveExecutionRunConnectedServicesSelection,
    type ResolvedExecutionRunConnectedServicesSelection,
} from './connectedServicesEnv';
import { cleanupExecutionRunIsolationBundle } from './isolation';
import { buildExecutionRunConfiguration } from './openInputs';
import {
    prepareExecutionRunProviderLaunch,
    type ExecutionRunTeamCredentialProviderBindingPreparer,
    type PreparedExecutionRunProviderLaunch,
} from './providerLaunch';

/**
 * The Run's resolved connected-services selection, reported to its Run owner
 * BEFORE materialization. The daemon opens direct Team material inside that
 * materialization, and the Home asks the Run owner to attest this exact
 * selection then, before any registration exists. `agentContribution` is the
 * Run's own Agent from its engine resolution; null when that names none.
 */
export type ExecutionRunConnectedServicesSelectionReport = Readonly<{
    connectedServicesBindings: ConnectedServiceBindingsV2;
    agentContribution: PluginContributionIdentityV1 | null;
}>;

function normalizeAccountSettings(value: unknown): AccountSettings | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return accountSettingsParse(value);
}

function resolveExecutionRunAccountSettings(accountSettings: unknown): AccountSettings | null {
    return normalizeAccountSettings(accountSettings);
}

function resolveExecutionRunCompatBackendTarget(
    backendTarget: BackendTargetRefV2Input | null | undefined,
): Readonly<{
    canonical: BackendTargetRefV2;
    compat: BackendTargetRefV1;
}> | null {
    if (!backendTarget) {
        return null;
    }

    const canonical = readBackendTargetRefV2(backendTarget);
    return {
        canonical,
        compat: convertBackendTargetRefV2ToV1(canonical),
    };
}

function resolveExecutionRunPluginIsolationBundle(opts: Readonly<{
    cwd: string;
    runId?: string;
    controllerOccurrenceId?: string;
    callId?: string;
    sidechainId?: string;
    getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider;
    backendId: string;
    start?: ExecutionRunBackendStartContext | null;
}>): Readonly<{
    env: Readonly<Record<string, string>>;
    cleanup?: (() => Promise<void>) | undefined;
    shouldCleanupIsolation: boolean;
}> | null {
    const retentionPolicy = String(opts.start?.retentionPolicy ?? '').trim();
    const shouldCleanupIsolation = retentionPolicy === 'ephemeral';
    const shouldIsolate = shouldCleanupIsolation || String(opts.runId ?? '').trim().length > 0;
    if (!shouldIsolate) {
        return null;
    }

    const intent = String(opts.start?.intent ?? '').trim();
    const isolationId = String(opts.runId ?? '').trim() || `run_${opts.backendId}_${Date.now()}`;
    const bundle = resolveBackendIsolationBundle({
        backendId: opts.backendId,
        isolationId,
        scope: 'execution_run',
        ...(intent.length > 0 ? { intent } : {}),
        cwd: opts.cwd,
    });
    const cleanup = bundle.cleanup
        ? async () => {
            await Promise.resolve(bundle.cleanup?.());
        }
        : undefined;

    return {
        env: bundle.env,
        cleanup,
        shouldCleanupIsolation,
    };
}

type LazyExecutionRunRuntimeShellConfig = Parameters<typeof createLazyExecutionRunHostRuntime>[0];

function createEngineExecutionRunRuntimeShellConfig(opts: Readonly<{
    cwd: string;
    runId?: string;
    controllerOccurrenceId?: string;
    callId?: string;
    sidechainId?: string;
    scope: ExecutionRunRetainedInteractionScope;
    getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider;
    backendId: string;
    backendTarget?: BackendTargetRefV2Input;
    backendSourceKind?: string;
    modelId?: string;
    onEffectiveEngine?: (engine: Readonly<{ agentId: string; modelId?: string }>) => void;
    modelSelection?: ProviderBoundModelRef;
    teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    secretReferenceOverlay?: SecretReferenceOverlayV1;
    /** Already materialized first-launch values; never persisted or used on resume. */
    secretReferenceEnvironment?: Readonly<Record<string, string>>;
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    permissionMode: string;
    workspaceWrites?: 'allow' | 'deny';
    /** Normalized Protocol settings; the outer input normalizes raw settings exactly once. */
    accountSettings?: AccountSettings | null;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    connectedServicesDefaultServiceIds?: readonly string[];
    start?: ExecutionRunBackendStartContext | null;
    happyHomeDir?: string | null;
    engineRegistry?: ResolvedCliEngineRegistry;
    parentSessionStateTarget?: ExecutionRunSessionStateTarget | null;
    /** Owning Happier Session id when the host scope has one; absent for detached Runs. */
    happierSessionId?: string;
    sessionInteractionHost?: NativeAgentSessionInteractionHostBinding;
    sessionOwnedRunScope?: ExecutionRunHostRunScopeBinding;
    prepareRunTeamCredentialProviderBinding?: ExecutionRunTeamCredentialProviderBindingPreparer;
    onConnectedServicesRegistration?: (registration: ExecutionRunConnectedServicesLaunchV1) => void | Promise<void>;
    onConnectedServicesSelection?: (selection: ExecutionRunConnectedServicesSelectionReport) => void | Promise<void>;
    machineId?: string;
    resolveProvidersFeatureEnabled?: () => boolean | Promise<boolean>;
    resolveAccountSettingsSnapshot?: (input?: Readonly<{
        secretReferenceOverlay?: SecretReferenceOverlayV1;
    }>) => Promise<ActiveAccountSettingsSnapshot | null>;
}>): LazyExecutionRunRuntimeShellConfig {
    let resolvedBackendPromise: Promise<ExecutionRunHostRuntime> | null = null;
    let activeConnectedServicesEnv: Awaited<ReturnType<typeof resolveExecutionRunConnectedServicesEnv>> = null;

    const resolveBackend = async (): Promise<ExecutionRunHostRuntime> => {
        if (resolvedBackendPromise) return await resolvedBackendPromise;
        resolvedBackendPromise = (async () => {
            const engineResolution = opts.engineRegistry
                ? await opts.engineRegistry.resolveForBackendId(opts.backendId)
                : await resolveBackendEngineAdapterResolution(opts.backendId, {
                    happyHomeDir: opts.happyHomeDir ?? configuration.happyHomeDir,
                });
            if (engineResolution) {
                throwIfPluginRuntimeStartBlocked(engineResolution);
            }
            if (!engineResolution) {
                throw new Error(`Unsupported execution-run backend: ${opts.backendId}`);
            }
            const runtimeCore = engineResolution.engineAdapter.runtimeCore;
            if (typeof runtimeCore?.createExecutionRunBackend !== 'function') {
                throw new Error(`Engine adapter for ${opts.backendId} does not expose runtimeCore.createExecutionRunBackend`);
            }
            const effectiveBackendTarget = opts.backendTarget
                ? readBackendTargetRefV2(opts.backendTarget)
                : null;
            if (opts.modelSelection && !effectiveBackendTarget) {
                throw new Error('Execution-run model selection requires an exact backend target');
            }
            const boundedOpenInputs = effectiveBackendTarget
                ? buildExecutionRunConfiguration({
                    backendTarget: effectiveBackendTarget,
                    ...(opts.modelId ? { modelId: opts.modelId } : {}),
                    ...(opts.modelSelection
                        ? { modelSelection: opts.modelSelection }
                        : {}),
                    ...(opts.sessionConfigOptionOverrides
                        ? {
                            sessionConfigOptionOverrides:
                                opts.sessionConfigOptionOverrides,
                        }
                        : {}),
                    ...(opts.start?.acpSessionModeId
                        ? { acpSessionModeId: opts.start.acpSessionModeId }
                        : {}),
                    permissionMode: opts.permissionMode,
                    workspaceWrites: opts.workspaceWrites,
                    updatedAtMs: Date.now(),
                })
                : null;
            const connectedServicesSelection =
                await resolveExecutionRunConnectedServicesSelection({
                    backendId: opts.backendId,
                    backendSourceKind:
                        opts.backendSourceKind ?? 'built_in',
                    ...(opts.connectedServices !== undefined
                        ? { connectedServices: opts.connectedServices }
                        : {}),
                    ...(opts.connectedServicesDefaultServiceIds
                        && opts.connectedServicesDefaultServiceIds.length > 0
                        ? {
                            connectedServicesDefaultServiceIds:
                                opts.connectedServicesDefaultServiceIds,
                        }
                        : {}),
                });
            const prepareRunTeamCredentialProviderBinding = opts.teamCredentialModel
                ? opts.prepareRunTeamCredentialProviderBinding
                    ?? opts.sessionInteractionHost?.prepareRunTeamCredentialProviderBinding
                : opts.sessionInteractionHost?.prepareRunTeamCredentialProviderBinding;
            let providerLaunch: PreparedExecutionRunProviderLaunch | null = null;
            if (effectiveBackendTarget && (
                opts.modelSelection || opts.teamCredentialModel || opts.sessionInteractionHost?.prepareRunTeamCredentialProviderBinding
            )) {
                const featureEnabled =
                    !opts.modelSelection
                    || opts.modelSelection.providerConnectionId === null
                    || await opts.resolveProvidersFeatureEnabled?.() === true;
                providerLaunch = await prepareExecutionRunProviderLaunch({
                    ...(opts.modelSelection ? { selection: opts.modelSelection } : {}),
                    ...(opts.teamCredentialModel ? { teamCredentialModel: opts.teamCredentialModel } : {}),
                    backendTarget: effectiveBackendTarget,
                    machineId: opts.machineId,
                    agentId: engineResolution.agentId,
                    runId: String(opts.runId ?? '').trim(),
                    connectedServices:
                        connectedServicesSelection?.bindings ?? null,
                    featureEnabled,
                    happyHomeDir:
                        opts.happyHomeDir ?? configuration.happyHomeDir,
                    accountSettingsSnapshot:
                        await opts.resolveAccountSettingsSnapshot?.() ?? null,
                    ...(prepareRunTeamCredentialProviderBinding
                        ? { prepareTeamCredentialProviderBinding: prepareRunTeamCredentialProviderBinding }
                        : {}),
                });
            }
            const materializedConnectedServicesSelection:
                ResolvedExecutionRunConnectedServicesSelection | null =
                providerLaunch?.providerBinding
                && providerLaunch.connectedServices
                && hasConnectedExecutionRunBinding(
                    providerLaunch.connectedServices,
                )
                    ? {
                        bindings: providerLaunch.connectedServices,
                        source:
                            connectedServicesSelection?.source ?? 'explicit',
                        hadCredentials:
                            connectedServicesSelection?.hadCredentials ?? null,
                    }
                    : providerLaunch?.providerBinding
                        ? null
                        : connectedServicesSelection;
            // Connected-services env resolution (generic, provider-agnostic): resolved via the
            // daemon bridge BEFORE the per-backend launch and merged into the isolation bundle
            // env so every backend path (catalog/ACP + plugin) receives it the same way.
            // Connected selections FAIL CLOSED: a throw here rejects the run's backend
            // resolution loudly instead of silently running on ambient/native auth.
            // Defaulting happens INSIDE the helper through the session spawn-defaulting owner
            // (QA2-F02) — never from this process's account-settings snapshot.
            const connectedServicesRunKey = String(opts.runId ?? '').trim() || `run_${opts.backendId}_${randomUUID()}`;
            let connectedServicesEnv: Awaited<
                ReturnType<typeof resolveExecutionRunConnectedServicesEnv>
            > = null;
            try {
                // The Run owner learns its exact selection before the daemon
                // materializes it: direct Team material is opened inside that
                // materialization, and the Home asks the Run owner to attest it.
                if (materializedConnectedServicesSelection && opts.onConnectedServicesSelection) {
                    await opts.onConnectedServicesSelection({
                        connectedServicesBindings: materializedConnectedServicesSelection.bindings,
                        agentContribution: engineResolution.agent.identity ?? null,
                    });
                }
                connectedServicesEnv = await resolveExecutionRunConnectedServicesEnv({
                    runId: connectedServicesRunKey,
                    backendId: opts.backendId,
                    backendSourceKind: opts.backendSourceKind ?? 'built_in',
                    ...(opts.connectedServices !== undefined
                        ? {
                            connectedServices:
                                providerLaunch?.connectedServices
                                ?? opts.connectedServices,
                        }
                        : {}),
                    ...(opts.connectedServicesDefaultServiceIds && opts.connectedServicesDefaultServiceIds.length > 0
                        ? { connectedServicesDefaultServiceIds: opts.connectedServicesDefaultServiceIds }
                        : {}),
                    resolvedSelection:
                        materializedConnectedServicesSelection,
                    cwd: opts.cwd,
                    modelId: boundedOpenInputs?.configuration.model.value ?? opts.modelSelection?.modelId ?? opts.modelId,
                });
                activeConnectedServicesEnv = connectedServicesEnv;
                if (connectedServicesEnv && opts.onConnectedServicesRegistration) {
                    await opts.onConnectedServicesRegistration(connectedServicesEnv.registration);
                }
            } catch (error) {
                await connectedServicesEnv?.cleanup().catch(() => {});
                await providerLaunch?.cleanupOnExit?.();
                throw error;
            }
            const pluginIsolationBundle = engineResolution.runtimeOwner?.selected?.kind === 'plugin_engine'
                ? resolveExecutionRunPluginIsolationBundle(opts)
                : null;
            let secretReferenceEnvironment: Readonly<Record<string, string>> =
                opts.secretReferenceEnvironment ?? {};
            let secretReferenceRedaction: ReturnType<typeof createProviderRedactionLease> | null = null;
            if (opts.secretReferenceOverlay && !opts.secretReferenceEnvironment) {
                try {
                    const snapshot = await opts.resolveAccountSettingsSnapshot?.({
                        secretReferenceOverlay: opts.secretReferenceOverlay,
                    }) ?? null;
                    if (!snapshot) {
                        throw new LaunchSecretReferenceOverlayError('reference_unavailable', 'launch');
                    }
                    secretReferenceEnvironment = resolveSecretReferenceOverlayEnvironment({
                        accountSettings: snapshot.settings,
                        settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys,
                        ...(snapshot.savedSecretResources
                            ? { savedSecretResources: snapshot.savedSecretResources }
                            : {}),
                        secretReferenceOverlay: opts.secretReferenceOverlay,
                    });
                } catch (error) {
                    await connectedServicesEnv?.cleanup();
                    await providerLaunch?.cleanupOnExit?.();
                    if (
                        error instanceof LaunchSecretReferenceOverlayError
                        || error instanceof SavedSecretOperationAdmissionError
                    ) {
                        throw Object.assign(error, {
                            code: readLaunchSecretReferenceOverlayProviderErrorCodeV1(error.reason),
                        });
                    }
                    throw error;
                }
            }
            if (Object.keys(secretReferenceEnvironment).length > 0) {
                secretReferenceRedaction = createProviderRedactionLease({
                    values: Object.values(secretReferenceEnvironment),
                });
            }
            const isolationEnv: Record<string, string> = {
                ...(pluginIsolationBundle?.env ?? {}),
                ...(connectedServicesEnv?.env ?? {}),
                ...(providerLaunch?.environment ?? {}),
                ...secretReferenceEnvironment,
            };
            const runtimeOpts = {
                cwd: opts.cwd,
                scope: opts.scope,
                ...(opts.machineId ? { machineId: opts.machineId } : {}),
                runId: opts.runId,
                ...(opts.controllerOccurrenceId ? { controllerOccurrenceId: opts.controllerOccurrenceId } : {}),
                ...(opts.callId ? { callId: opts.callId } : {}),
                ...(opts.sidechainId ? { sidechainId: opts.sidechainId } : {}),
                ...(opts.getPermissionRequestStore
                    ? { getPermissionRequestStore: opts.getPermissionRequestStore }
                    : {}),
                backendId: opts.backendId,
                backendTarget: opts.backendTarget,
                modelId: opts.modelId,
                ...(boundedOpenInputs?.modelSelection
                    ? { modelSelection: boundedOpenInputs.modelSelection }
                    : {}),
                ...(opts.sessionConfigOptionOverrides
                    ? { sessionConfigOptionOverrides: opts.sessionConfigOptionOverrides }
                    : {}),
                ...(opts.causalPermissionAuthority
                    ? { causalPermissionAuthority: opts.causalPermissionAuthority }
                    : {}),
                ...(boundedOpenInputs
                    ? { configuration: boundedOpenInputs.configuration }
                    : {}),
                ...(opts.start?.runtimeDescriptorV1
                    ? { runtimeDescriptorV1: opts.start.runtimeDescriptorV1 }
                    : {}),
                ...(providerLaunch?.providerBinding
                    ? { providerBinding: providerLaunch.providerBinding }
                    : {}),
                ...(providerLaunch || secretReferenceRedaction
                    ? {
                        ...(providerLaunch
                            ? { revalidateProviderBeforeOpen: providerLaunch.revalidateBeforeCommit }
                            : {}),
                        sanitizeProviderDiagnosticText:
                            (value: string) => secretReferenceRedaction?.redact(
                                providerLaunch?.sanitizeDiagnosticText(value) ?? value,
                            ) ?? providerLaunch?.sanitizeDiagnosticText(value) ?? value,
                    }
                    : {}),
                permissionMode: opts.permissionMode,
                workspaceWrites: opts.workspaceWrites,
                accountSettings: opts.accountSettings ?? null,
                start: opts.start ?? null,
                ...(opts.parentSessionStateTarget ? { parentSessionStateTarget: opts.parentSessionStateTarget } : {}),
                ...(opts.happierSessionId ? { happierSessionId: opts.happierSessionId } : {}),
                ...(opts.sessionInteractionHost ? { sessionInteractionHost: opts.sessionInteractionHost } : {}),
                ...(opts.sessionOwnedRunScope ? { sessionOwnedRunScope: opts.sessionOwnedRunScope } : {}),
                ...(Object.keys(isolationEnv).length > 0
                    || (providerLaunch?.unsetEnvKeys.length ?? 0) > 0
                    ? {
                        isolation: {
                            env: isolationEnv,
                            ...(providerLaunch?.unsetEnvKeys.length
                                ? { unsetEnvKeys: providerLaunch.unsetEnvKeys }
                                : {}),
                        },
                    }
                    : {}),
            };

            let runtime: ExecutionRunHostRuntime;
            try {
                const providerCurrent = await providerLaunch?.revalidateBeforeCommit();
                if (providerCurrent && !providerCurrent.ok) {
                    const error = Object.assign(
                        new Error(providerCurrent.error.code),
                        { code: providerCurrent.error.code },
                    );
                    throw error;
                }
                runtime = runtimeCore.createExecutionRunBackend(runtimeOpts);
            } catch (error) {
                if (pluginIsolationBundle?.shouldCleanupIsolation) {
                    await cleanupExecutionRunIsolationBundle(pluginIsolationBundle);
                }
                await connectedServicesEnv?.cleanup();
                await providerLaunch?.cleanupOnExit?.();
                if ((providerLaunch || secretReferenceRedaction) && error instanceof Error) {
                    const sanitized = new Error(
                        secretReferenceRedaction?.redact(
                            providerLaunch?.sanitizeDiagnosticText(error.message) ?? error.message,
                        ) ?? providerLaunch?.sanitizeDiagnosticText(error.message) ?? error.message,
                    ) as Error & { code?: string };
                    sanitized.name = error.name;
                    if ('code' in error && typeof error.code === 'string') {
                        sanitized.code = error.code;
                    }
                    secretReferenceRedaction?.close();
                    throw sanitized;
                }
                secretReferenceRedaction?.close();
                throw error;
            }

            const runtimeWithIdentity = withExecutionRunRuntimeIdentityPublication({
                runtime,
                identity: buildExecutionRunRuntimeIdentityPublication(engineResolution),
            });
            opts.onEffectiveEngine?.({
                agentId: engineResolution.agentId,
            });
            // Authored model preferences are not proof of the model the Agent used.
            const unsubscribeEffectiveEngine = opts.onEffectiveEngine
                ? runtimeWithIdentity.subscribeRuntimeEvents?.((event) => {
                    if (event.kind !== 'usage-observed') return;
                    const observedModel = event.modelId ?? (event.context?.source !== 'derived_estimate' ? event.context?.modelId : null);
                    if (observedModel) opts.onEffectiveEngine?.({ agentId: engineResolution.agentId, modelId: observedModel });
                })
                : undefined;
            const withEffectiveEngineCleanup = unsubscribeEffectiveEngine
                ? withExecutionRunHostRuntimeCleanup(runtimeWithIdentity, unsubscribeEffectiveEngine)
                : runtimeWithIdentity;
            const withPluginIsolationCleanup = pluginIsolationBundle?.shouldCleanupIsolation && pluginIsolationBundle.cleanup
                ? withExecutionRunHostRuntimeCleanup(withEffectiveEngineCleanup, pluginIsolationBundle.cleanup)
                : withEffectiveEngineCleanup;
            // Connected-services release runs at run end for EVERY retention policy: it
            // unregisters the run's runtime-registry targets and triggers daemon-side cleanup.
            const withProviderCleanup = providerLaunch?.cleanupOnExit
                ? withExecutionRunHostRuntimeCleanup(
                    withPluginIsolationCleanup,
                    providerLaunch.cleanupOnExit,
                )
                : withPluginIsolationCleanup;
            const withSecretReferenceCleanup = secretReferenceRedaction
                ? withExecutionRunHostRuntimeCleanup(
                    withProviderCleanup,
                    async () => { secretReferenceRedaction?.close(); },
                )
                : withProviderCleanup;
            return connectedServicesEnv
                ? withExecutionRunHostRuntimeCleanup(withSecretReferenceCleanup, connectedServicesEnv.cleanup)
                : withSecretReferenceCleanup;
        })();
        return await resolvedBackendPromise;
    };

    return {
        resolveRuntime: resolveBackend,
        async recoverRejectedStart(error) {
            const retry = await activeConnectedServicesEnv?.recoverRejectedStart(error.classification) ?? false;
            if (retry) resolvedBackendPromise = null;
            return retry;
        },
    };
}

export function createExecutionRunRuntime(opts: Readonly<{
    cwd: string;
    runId?: string;
    controllerOccurrenceId?: string;
    callId?: string;
    sidechainId?: string;
    scope: ExecutionRunRetainedInteractionScope;
    getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider;
    backendId: string;
    backendTarget?: BackendTargetRefV2Input;
    modelId?: string;
    onEffectiveEngine?: (engine: Readonly<{ agentId: string; modelId?: string }>) => void;
    modelSelection?: ProviderBoundModelRef;
    teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    secretReferenceOverlay?: SecretReferenceOverlayV1;
    secretReferenceEnvironment?: Readonly<Record<string, string>>;
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    permissionMode: string;
    workspaceWrites?: 'allow' | 'deny';
    accountSettings?: Readonly<Record<string, unknown>> | null;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    connectedServicesDefaultServiceIds?: readonly string[];
    start?: ExecutionRunBackendStartContext | null;
    happyHomeDir?: string | null;
    engineRegistry?: ResolvedCliEngineRegistry;
    parentSessionStateTarget?: ExecutionRunSessionStateTarget | null;
    /** Owning Happier Session id when the host scope has one; absent for detached Runs. */
    happierSessionId?: string;
    sessionInteractionHost?: NativeAgentSessionInteractionHostBinding;
    sessionOwnedRunScope?: ExecutionRunHostRunScopeBinding;
    prepareRunTeamCredentialProviderBinding?: ExecutionRunTeamCredentialProviderBindingPreparer;
    onConnectedServicesRegistration?: (registration: ExecutionRunConnectedServicesLaunchV1) => void | Promise<void>;
    onConnectedServicesSelection?: (selection: ExecutionRunConnectedServicesSelectionReport) => void | Promise<void>;
    machineId?: string;
    resolveProvidersFeatureEnabled?: () => boolean | Promise<boolean>;
    resolveAccountSettingsSnapshot?: (input?: Readonly<{
        secretReferenceOverlay?: SecretReferenceOverlayV1;
    }>) => Promise<ActiveAccountSettingsSnapshot | null>;
}>): ExecutionRunHostRuntime {
    const resolvedBackendTarget = resolveExecutionRunCompatBackendTarget(opts.backendTarget);
    const backendId = String(opts.backendId ?? '').trim();
    const accountSettings = resolveExecutionRunAccountSettings(opts.accountSettings);
    if (accountSettings && resolvedBackendTarget?.canonical.sourceKind === 'built_in') {
        assertBackendEnabledByAccountSettings({
            agentId: resolvedBackendTarget.compat.kind === 'builtInAgent' ? resolvedBackendTarget.compat.agentId as AgentId : undefined,
            backendTarget: resolvedBackendTarget.compat,
            settings: accountSettings,
        });
    }
    if (accountSettings && resolvedBackendTarget?.canonical.sourceKind === 'configured') {
        assertBackendEnabledByAccountSettings({
            backendTarget: resolvedBackendTarget.compat,
            settings: accountSettings,
        });
    }
    const runtimeBackendId = resolvedBackendTarget?.canonical.sourceKind === 'configured'
        ? resolvedBackendTarget.canonical.configuredBackendId ?? resolvedBackendTarget.canonical.backendId
        : backendId;
    const runtimeBackendTarget = resolvedBackendTarget?.canonical.sourceKind === 'configured'
        ? {
            ...resolvedBackendTarget.canonical,
            configuredBackendId: resolvedBackendTarget.canonical.configuredBackendId ?? resolvedBackendTarget.canonical.backendId,
            sourceKind: 'configured' as const,
        }
        : resolvedBackendTarget?.canonical;
    const runtimeShellConfig = createEngineExecutionRunRuntimeShellConfig({
            cwd: opts.cwd,
            scope: opts.scope,
            runId: opts.runId,
            ...(opts.controllerOccurrenceId ? { controllerOccurrenceId: opts.controllerOccurrenceId } : {}),
            ...(opts.callId ? { callId: opts.callId } : {}),
            ...(opts.sidechainId ? { sidechainId: opts.sidechainId } : {}),
            ...(opts.getPermissionRequestStore
                ? { getPermissionRequestStore: opts.getPermissionRequestStore }
                : {}),
            backendId: runtimeBackendId,
            ...(runtimeBackendTarget ? { backendTarget: runtimeBackendTarget } : {}),
            backendSourceKind: resolvedBackendTarget?.canonical.sourceKind ?? 'built_in',
            modelId: opts.modelId,
            ...(opts.onEffectiveEngine ? { onEffectiveEngine: opts.onEffectiveEngine } : {}),
            ...(opts.modelSelection
                ? { modelSelection: opts.modelSelection }
                : {}),
            ...(opts.teamCredentialModel
                ? { teamCredentialModel: opts.teamCredentialModel }
                : {}),
            ...(opts.sessionConfigOptionOverrides
                ? { sessionConfigOptionOverrides: opts.sessionConfigOptionOverrides }
                : {}),
            ...(opts.secretReferenceOverlay
                ? { secretReferenceOverlay: opts.secretReferenceOverlay }
                : {}),
            ...(opts.secretReferenceEnvironment
                ? { secretReferenceEnvironment: opts.secretReferenceEnvironment }
                : {}),
            ...(opts.causalPermissionAuthority
                ? { causalPermissionAuthority: opts.causalPermissionAuthority }
                : {}),
            permissionMode: opts.permissionMode,
            workspaceWrites: opts.workspaceWrites,
            accountSettings,
            ...(opts.connectedServices !== undefined ? { connectedServices: opts.connectedServices } : {}),
            ...(opts.connectedServicesDefaultServiceIds && opts.connectedServicesDefaultServiceIds.length > 0
                ? { connectedServicesDefaultServiceIds: opts.connectedServicesDefaultServiceIds }
                : {}),
            start: opts.start ?? null,
            happyHomeDir: opts.happyHomeDir ?? null,
            ...(opts.engineRegistry ? { engineRegistry: opts.engineRegistry } : {}),
            parentSessionStateTarget: opts.parentSessionStateTarget ?? null,
            ...(opts.happierSessionId ? { happierSessionId: opts.happierSessionId } : {}),
            ...(opts.sessionInteractionHost ? { sessionInteractionHost: opts.sessionInteractionHost } : {}),
            ...(opts.sessionOwnedRunScope ? { sessionOwnedRunScope: opts.sessionOwnedRunScope } : {}),
            ...(opts.prepareRunTeamCredentialProviderBinding
                ? { prepareRunTeamCredentialProviderBinding: opts.prepareRunTeamCredentialProviderBinding }
                : {}),
            ...(opts.onConnectedServicesRegistration
                ? { onConnectedServicesRegistration: opts.onConnectedServicesRegistration }
                : {}),
            ...(opts.onConnectedServicesSelection
                ? { onConnectedServicesSelection: opts.onConnectedServicesSelection }
                : {}),
            ...(opts.machineId ? { machineId: opts.machineId } : {}),
            ...(opts.resolveProvidersFeatureEnabled
                ? {
                    resolveProvidersFeatureEnabled:
                        opts.resolveProvidersFeatureEnabled,
                }
                : {}),
            ...(opts.resolveAccountSettingsSnapshot
                ? { resolveAccountSettingsSnapshot: opts.resolveAccountSettingsSnapshot }
                : {}),
        });
    return createLazyExecutionRunHostRuntime(runtimeShellConfig);
}
