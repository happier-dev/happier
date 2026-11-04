import { randomUUID } from 'node:crypto';

import type { AgentId } from '@happier-dev/agents';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { convertBackendTargetRefV2ToV1, readBackendTargetRefV2, writePersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { AccountSettings, AcpConfigOptionOverridesV1, BackendTargetRefV1, BackendTargetRefV2, BackendTargetRefV2Input, ConnectedServiceBindingsV2, ExecutionRunConnectedServicesLaunchV1, PluginContributionIdentityV1, ProviderBoundModelRef, TeamCredentialProviderModelSelectionV1, SessionInputCausalPermissionAuthorityV1, SecretReferenceOverlayV1 } from '@happier-dev/protocol';

import type {
    ExecutionRunHostRuntime,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type {
    ExecutionRunHostRunScopeBinding,
    CreateCliExecutionRunBackendParams,
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
import { SavedSecretOperationAdmissionError } from "@/settings/secrets/savedSecretCatalogRead";
import {
    LaunchSecretReferenceOverlayError,
    readLaunchSecretReferenceOverlayProviderErrorCodeV1,
    resolveSecretReferenceOverlayEnvironment,
} from '@/settings/secrets/secretReferenceOverlay';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import type { ResolveManagedProviderPurposeBindingIntent } from '@/providers/managed/resolvePurposeBindingSnapshot';
import type { ProviderRuntimeModelProjectionReader } from '@/providers/spawn/runtimeCatalog';
import type { DirectManagedProviderEndpointPreparer } from '@/providers/lifecycle/prepareDirectLaunch';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { traceRunPreparationPhase } from '@/providers/diagnostics';
import { normalizeUnsetEnvKeys, stripUnsetEnvironmentVariables } from '@/utils/processEnv/buildScopedProcessEnv';

import { withExecutionRunHostRuntimeCleanup } from '../hostRuntime/cleanup';
import { createLazyExecutionRunHostRuntime } from '../hostRuntime/lazy';
import { sanitizeExecutionRunError } from '../errors';
import {
    hasConnectedExecutionRunBinding,
    resolveExecutionRunConnectedServicesEnv,
    resolveExecutionRunConnectedServicesSelection,
    type ResolvedExecutionRunConnectedServicesSelection,
} from './connectedServicesEnv';
import { cleanupExecutionRunIsolationBundle } from './isolation';
import { buildExecutionRunConfiguration } from './openInputs';
import {
    type ExecutionRunTeamCredentialProviderBindingPreparer,
    type ExecutionRunProviderLaunchServices,
    type PreparedExecutionRunProviderLaunch,
} from './providerLaunch';
import { assertExecutionRunProviderLaunchPlacement, prepareExecutionRunRuntimeProviderLaunch } from './providerPreparation';

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

type LazyExecutionRunRuntimeShellConfig = Parameters<typeof createLazyExecutionRunHostRuntime>[0] & Readonly<{
    retireProviderResources(): Promise<void>;
}>;

function createEngineExecutionRunRuntimeShellConfig(opts: Readonly<{
    cwd: string;
    runId?: string;
    controllerOccurrenceId?: string;
    callId?: string;
    sidechainId?: string;
    scope: ExecutionRunRetainedInteractionScope;
    projectLaunchContext?: CreateCliExecutionRunBackendParams['projectLaunchContext'];
    projectSetupOperation?: CreateCliExecutionRunBackendParams['projectSetupOperation'];
    resolveProjectSetupOperation?: CreateCliExecutionRunBackendParams['resolveProjectSetupOperation'];
    getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider;
    backendId: string;
    backendTarget?: BackendTargetRefV2Input;
    agentTarget?: AgentExecutionTargetV1;
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
    resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
    readModelProjection?: ProviderRuntimeModelProjectionReader;
    prepareManagedEndpoint?: DirectManagedProviderEndpointPreparer;
    providerLaunch?: ExecutionRunProviderLaunchServices;
    resolveAccountSettingsSnapshot?: import('@/settings/accountSettings/activeAccountSettingsSnapshot').AccountSettingsSnapshotResolver;
}>): LazyExecutionRunRuntimeShellConfig {
    let resolvedBackendPromise: Promise<ExecutionRunHostRuntime> | null = null;
    let activeConnectedServicesEnv: Awaited<ReturnType<typeof resolveExecutionRunConnectedServicesEnv>> = null;
    // Retain the incumbent per-attempt launch scopes before preparation can
    // reject, including attempts replaced by existing rejected-start recovery.
    const providerResources = createProviderLaunchResourceScope();

    const resolveBackend = async (signal: AbortSignal): Promise<ExecutionRunHostRuntime> => {
        signal.throwIfAborted();
        if (resolvedBackendPromise) return await resolvedBackendPromise;
        resolvedBackendPromise = (async () => {
            assertExecutionRunProviderLaunchPlacement({ scope: opts.scope,
                selection: opts.modelSelection, teamCredentialModel: opts.teamCredentialModel,
                providerLaunch: opts.providerLaunch });
            const trace = <T>(phase: Parameters<typeof traceRunPreparationPhase>[1], work: () => T | Promise<T>) =>
                traceRunPreparationPhase(opts.runId, phase, signal, work);
            const engineResolution = await trace('engine_resolution', () => opts.engineRegistry
                ? opts.agentTarget
                    ? opts.engineRegistry.resolveForAgentTarget(opts.agentTarget)
                    : opts.engineRegistry.resolveForBackendId(opts.backendId)
                : resolveBackendEngineAdapterResolution(opts.backendId, {
                    happyHomeDir: opts.happyHomeDir ?? configuration.happyHomeDir,
                    ...(opts.agentTarget ? { agentTarget: opts.agentTarget } : {}),
                }));
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
                    ...(opts.start?.allowedTools !== undefined ? { allowedTools: opts.start.allowedTools } : {}),
                    ...(opts.start?.unlistedTools !== undefined ? { unlistedTools: opts.start.unlistedTools } : {}),
                    workspaceWrites: opts.workspaceWrites,
                    updatedAtMs: Date.now(),
                })
                : null;
            const connectedServicesSelection =
                await trace('connected_services_selection', () => resolveExecutionRunConnectedServicesSelection({
                    backendId: engineResolution.backendId,
                    signal,
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
                }));
            const prepareRunTeamCredentialProviderBinding = opts.teamCredentialModel
                ? opts.prepareRunTeamCredentialProviderBinding
                    ?? opts.sessionInteractionHost?.prepareRunTeamCredentialProviderBinding
                : opts.sessionInteractionHost?.prepareRunTeamCredentialProviderBinding;
            let providerLaunch: PreparedExecutionRunProviderLaunch | null = null;
            if (effectiveBackendTarget && (
                opts.modelSelection || opts.teamCredentialModel || opts.sessionInteractionHost?.prepareRunTeamCredentialProviderBinding
            )) {
                providerLaunch = await prepareExecutionRunRuntimeProviderLaunch({
                    signal,
                    scope: opts.scope,
                    providerLaunch: opts.providerLaunch,
                    controllerOccurrenceId: opts.controllerOccurrenceId,
                    ...(opts.modelSelection ? { selection: opts.modelSelection } : {}),
                    ...(opts.teamCredentialModel ? { teamCredentialModel: opts.teamCredentialModel } : {}),
                    backendTarget: effectiveBackendTarget,
                    machineId: opts.machineId,
                    agentId: engineResolution.agentId,
                    runId: String(opts.runId ?? '').trim(),
                    connectedServices:
                        connectedServicesSelection?.bindings ?? null,
                    happyHomeDir:
                        opts.happyHomeDir ?? configuration.happyHomeDir,
                    resolveProvidersFeatureEnabled: opts.resolveProvidersFeatureEnabled,
                    resolveAccountSettingsSnapshot: opts.resolveAccountSettingsSnapshot,
                    ...(opts.resolveManagedPurposeBindingIntent ? { resolveManagedPurposeBindingIntent: opts.resolveManagedPurposeBindingIntent } : {}),
                    ...(opts.readModelProjection ? { readModelProjection: opts.readModelProjection } : {}),
                    ...(opts.prepareManagedEndpoint ? { prepareManagedEndpoint: opts.prepareManagedEndpoint } : {}),
                    retainCleanup: providerResources.register,
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
                connectedServicesEnv = await trace('connected_services_materialization', () => resolveExecutionRunConnectedServicesEnv({
                    signal,
                    runId: connectedServicesRunKey,
                    backendId: engineResolution.backendId,
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
                }));
                activeConnectedServicesEnv = connectedServicesEnv;
                signal.throwIfAborted();
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
                    const snapshot = await trace('secret_reference_snapshot', () => opts.resolveAccountSettingsSnapshot?.({
                        secretReferenceOverlay: opts.secretReferenceOverlay,
                    })) ?? null;
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
            let isolationUnsetEnvKeys = normalizeUnsetEnvKeys([
                ...(connectedServicesEnv?.unsetEnvKeys ?? []),
                ...(providerLaunch?.unsetEnvKeys ?? []),
            ]);
            let isolationEnv = stripUnsetEnvironmentVariables({
                ...(pluginIsolationBundle?.env ?? {}),
                ...(connectedServicesEnv?.env ?? {}),
                ...(providerLaunch?.environment ?? {}),
                ...secretReferenceEnvironment,
            }, isolationUnsetEnvKeys);
            const prepareRuntimeFailureRecovery: NonNullable<CreateCliExecutionRunBackendParams['prepareRuntimeFailureRecovery']> = async input => {
                const incumbent = connectedServicesEnv;
                if (!incumbent) return { status: 'failed' };
                const result = await incumbent.recoverRuntimeFailure(input);
                input.signal.throwIfAborted();
                if (result.status !== 'continue') return { status: 'failed' };
                return {
                    status: 'continue',
                    input: result.input,
                    async prepareResume() {
                        if (result.rematerialize) {
                            // Preserve the checkpoint in place; releasing the
                            // incumbent first would remove native resume state.
                            const next = await incumbent.rematerializeForRecovery(input.providerSessionId);
                            connectedServicesEnv = next;
                            activeConnectedServicesEnv = next;
                            isolationUnsetEnvKeys = normalizeUnsetEnvKeys([
                                ...(next.unsetEnvKeys ?? []), ...(providerLaunch?.unsetEnvKeys ?? []),
                            ]);
                            isolationEnv = stripUnsetEnvironmentVariables({
                                ...(pluginIsolationBundle?.env ?? {}), ...next.env,
                                ...(providerLaunch?.environment ?? {}), ...secretReferenceEnvironment,
                            }, isolationUnsetEnvKeys);
                            input.signal.throwIfAborted();
                            await opts.onConnectedServicesRegistration?.(next.registration);
                        }
                        input.signal.throwIfAborted();
                        return { values: isolationEnv, unset: isolationUnsetEnvKeys };
                    },
                };
            };
            const runtimeOpts = {
                ...(opts.projectLaunchContext ? { projectLaunchContext: opts.projectLaunchContext } : {}),
                ...(opts.projectSetupOperation ? { projectSetupOperation: opts.projectSetupOperation } : {}),
                ...(opts.resolveProjectSetupOperation ? { resolveProjectSetupOperation: opts.resolveProjectSetupOperation } : {}),
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
                backendId: engineResolution.backendId,
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
                ...(opts.resolveAccountSettingsSnapshot ? { resolveAccountSettingsSnapshot: opts.resolveAccountSettingsSnapshot } : {}),
                start: opts.start ?? null,
                ...(opts.parentSessionStateTarget ? { parentSessionStateTarget: opts.parentSessionStateTarget } : {}),
                ...(opts.happierSessionId ? { happierSessionId: opts.happierSessionId } : {}),
                ...(opts.sessionInteractionHost ? { sessionInteractionHost: opts.sessionInteractionHost } : {}),
                ...(opts.sessionOwnedRunScope ? { sessionOwnedRunScope: opts.sessionOwnedRunScope } : {}),
                ...(connectedServicesEnv ? {
                    connectedServiceRuntimeAuthRefresh: (...args: Parameters<NonNullable<CreateCliExecutionRunBackendParams['connectedServiceRuntimeAuthRefresh']>>) => connectedServicesEnv!.refreshRuntimeAuth(...args),
                    prepareRuntimeFailureRecovery,
                    connectedServiceRuntimeTurnCompleted: () => connectedServicesEnv!.completeRuntimeTurn(),
                } : {}),
                ...(Object.keys(isolationEnv).length > 0
                    || isolationUnsetEnvKeys.length > 0
                    ? {
                        get isolation() {
                            return { env: isolationEnv,
                                ...(isolationUnsetEnvKeys.length > 0 ? { unsetEnvKeys: isolationUnsetEnvKeys } : {}) };
                        },
                    }
                    : {}),
            };

            let runtime: ExecutionRunHostRuntime;
            try {
                const providerCurrent = providerLaunch
                    ? await trace('runtime_provider_commit', () => providerLaunch.revalidateBeforeCommit(signal)) : undefined;
                if (providerCurrent && !providerCurrent.ok) {
                    const error = Object.assign(
                        new Error(providerCurrent.error.code),
                        { code: providerCurrent.error.code },
                    );
                    throw error;
                }
                runtime = await trace('runtime_create', () => runtimeCore.createExecutionRunBackend!(runtimeOpts));
            } catch (error) {
                if (pluginIsolationBundle?.shouldCleanupIsolation) {
                    await cleanupExecutionRunIsolationBundle(pluginIsolationBundle);
                }
                await connectedServicesEnv?.cleanup();
                await providerLaunch?.cleanupOnExit?.();
                if (providerLaunch || secretReferenceRedaction) {
                    const sanitized = sanitizeExecutionRunError(error, value => secretReferenceRedaction?.redact(
                        providerLaunch?.sanitizeDiagnosticText(value) ?? value,
                    ) ?? providerLaunch?.sanitizeDiagnosticText(value) ?? value, opts.runId ? { runId: opts.runId } : undefined);
                    secretReferenceRedaction?.close();
                    throw sanitized;
                }
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
                ? withExecutionRunHostRuntimeCleanup(withSecretReferenceCleanup, async () => await connectedServicesEnv?.cleanup())
                : withSecretReferenceCleanup;
        })();
        return await resolvedBackendPromise;
    };

    return {
        resolveRuntime: resolveBackend,
        async retireProviderResources() {
            // Generic lazy disposal intentionally does not await provisioning.
            // Provider acquisition must settle before its retained scopes retire.
            await resolvedBackendPromise?.catch(() => undefined);
            await providerResources.retire();
        },
        async recoverRejectedStart(error) {
            const retry = await activeConnectedServicesEnv?.recoverRejectedStart(error.classification) ?? false;
            if (retry) resolvedBackendPromise = null;
            return retry;
        },
    };
}

export function createExecutionRunRuntime(opts: Readonly<{
    projectLaunchContext?: CreateCliExecutionRunBackendParams['projectLaunchContext'];
    projectSetupOperation?: CreateCliExecutionRunBackendParams['projectSetupOperation'];
    resolveProjectSetupOperation?: CreateCliExecutionRunBackendParams['resolveProjectSetupOperation'];
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
    resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
    readModelProjection?: ProviderRuntimeModelProjectionReader;
    prepareManagedEndpoint?: DirectManagedProviderEndpointPreparer;
    providerLaunch?: ExecutionRunProviderLaunchServices;
    resolveAccountSettingsSnapshot?: import('@/settings/accountSettings/activeAccountSettingsSnapshot').AccountSettingsSnapshotResolver;
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
    const persistedTarget = resolvedBackendTarget
        ? writePersistedBackendTargetRefV2(resolvedBackendTarget.canonical) : null;
    const agentTarget = persistedTarget?.kind === 'agent' && persistedTarget.definitionId !== undefined
        ? persistedTarget : undefined;
    const runtimeBackendId = backendId;
    const runtimeBackendTarget = resolvedBackendTarget?.canonical.sourceKind === 'configured'
        ? {
            ...resolvedBackendTarget.canonical,
            configuredBackendId: resolvedBackendTarget.canonical.configuredBackendId ?? resolvedBackendTarget.canonical.backendId,
            sourceKind: 'configured' as const,
        }
        : resolvedBackendTarget?.canonical;
    const runtimeShellConfig = createEngineExecutionRunRuntimeShellConfig({
            ...(opts.projectLaunchContext ? { projectLaunchContext: opts.projectLaunchContext } : {}),
            ...(opts.projectSetupOperation ? { projectSetupOperation: opts.projectSetupOperation } : {}),
            ...(opts.resolveProjectSetupOperation ? { resolveProjectSetupOperation: opts.resolveProjectSetupOperation } : {}),
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
            ...(agentTarget ? { agentTarget } : {}),
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
            ...(opts.resolveManagedPurposeBindingIntent ? { resolveManagedPurposeBindingIntent: opts.resolveManagedPurposeBindingIntent } : {}),
            ...(opts.readModelProjection ? { readModelProjection: opts.readModelProjection } : {}),
            ...(opts.prepareManagedEndpoint ? { prepareManagedEndpoint: opts.prepareManagedEndpoint } : {}),
            ...(opts.providerLaunch ? { providerLaunch: opts.providerLaunch } : {}),
        });
    const runtime = createLazyExecutionRunHostRuntime(runtimeShellConfig);
    return opts.modelSelection?.providerConnectionId
        ? withExecutionRunHostRuntimeCleanup(runtime, runtimeShellConfig.retireProviderResources)
        : runtime;
}
