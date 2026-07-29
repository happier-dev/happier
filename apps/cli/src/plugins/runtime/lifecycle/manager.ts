import { randomUUID } from 'node:crypto';

import type {
    PluginPermissionDeclarationV1,
    PluginPermissionCapabilityV1,
    PluginActionContributionV2,
    ParsedPluginEventContributionV1,
    PluginSystemToolContributionV1,
    PluginToolContributionV2,
    PluginCommandContributionV2,
} from '@happier-dev/protocol';
import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '../../validation/diagnostics/types';
import type {
    ResolvedContributionRegistry,
    ResolvedCommandContribution,
    ResolvedActionContribution,
    ResolvedContributionProvenance,
    ResolvedContributionSource,
    ResolvedToolContribution,
} from '../../projection/registry/types';

import type { ContributionRuntimeRegistration } from '../api/registrationRightsHost';
import type {
    PluginApiDaemonAuthBridgeRegistration,
    PluginDisposable,
    PluginApiMcpDiscoveryProviderRegistration,
    PluginApiMcpServerRegistration,
    PluginApiNotificationCategoryRegistration,
    PluginApiNotificationChannelRegistration,
    PluginApiScmBackendRegistration,
    PluginApiScmHostingProviderRegistration,
} from '../api/types';
import type { PluginActivationSource } from '../activationSources';
import { loadPluginModule } from '../loadPluginModule';
import { createPluginDisposableRegistry } from './disposables';
import { logger } from '@/ui/logger';
import type {
    PluginDaemonModuleNamespace,
    ResolvedPluginHookHandler,
} from '../types';

import {
    appendDiagnostic,
    appendDiagnostics,
    normalizePositiveTimeoutMs,
    runWithOptionalTimeout,
    mapDaemonModuleLoadErrorToDiagnostic,
} from './utils';
import {
    type ActivationTarget,
    type PluginContributionActivationDemand,
    collectActivationTargets,
    shouldActivateTargetAtStartup,
    activationTargetMatchesContributionDemand,
} from './activation/targets';
import { resolveActivationSource } from './activation/source';
import { activateContributionModule } from './activation/activateContributionModule';
import { buildActivationPolicy } from './activation/policy';
import {
    createTargetHookHandlerRegistry,
    type TargetInvocationServiceOwner,
} from './contributions/targetHooks';
import { createTargetMcpDiscoveryProviders } from './contributions/targetMcp';
import { createTargetScmRuntimeEntries } from './contributions/targetScm';
import {
    createTargetRequestInterceptorBindings,
    type TargetRequestInterceptorBinding,
} from './contributions/targetRequestInterceptors';
import {
    normalizeNetworkPermissionOrigin,
    normalizeProcessSpawnPermissionPath,
    normalizeEnvPermissionName,
    normalizeFilesystemPermissionPath,
    collectOptionalScopedPermissionMap,
    collectScopedPermissionMap,
} from './permissions/scopeNormalizers';
import type { PluginTargetActivationFact } from './activation/facts';
import { mapPluginSourceToDiagnosticSource } from '@/plugins/projection/introspection/source';
import {
    createTargetAgentRuntimeRegistry,
    type AgentRuntimeRegistrationLease,
} from './contributions/targetAgents';

/**
 * Orchestration entrypoint for the plugin runtime activation/deactivation
 * lifecycle. The individual responsibilities (contribution reading,
 * permission-scope normalization, activation-target/source/policy
 * resolution, ACP auto-registration, contribution resolution) live in the
 * sibling `contributions/`, `permissions/`, and `activation/` modules; this
 * file wires them together and owns the activated-registry shape, disposal,
 * and lazy (on-demand) activation.
 */

export type PluginActivationDemandResult = Readonly<{
    pluginId: string;
    diagnostics: readonly PluginCompatibilityDiagnostic[];
}>;

export type SupervisedPluginActivationAttempt = Readonly<{
    attemptId: string;
    pluginId: string;
    immutableGenerationId: string;
    phase: 'primaryBootstrap' | 'lazyActivation';
    startedAtMs: number;
    completedAtMs: number;
    outcome: 'fatal' | 'nonfatal';
}>;

type PluginRuntimeDisposalPhase = 'target_activation' | 'runtime_disposables' | 'registered_disposables';
type PluginRuntimeDisposalOptions = Readonly<{
    timeoutMs?: number;
    onError?: (event: Readonly<{
        pluginId: string;
        phase: PluginRuntimeDisposalPhase;
        error: unknown;
    }>) => void;
}>;

const DEFAULT_PLUGIN_RETIREMENT_TIMEOUT_MS = 5_000;

type ActivatedHandlerRegistry = Readonly<{
    hookHandlersByHookId: ReadonlyMap<string, readonly ResolvedPluginHookHandler[]>;
}>;

export type ActivatedPluginRuntimeRegistry = ActivatedHandlerRegistry & Readonly<{
    generation: number;
    targetRegistrations: readonly Readonly<{
        pluginId: string;
        generation: string;
        registration: ContributionRuntimeRegistration;
    }>[];
    targetActivationFacts: readonly PluginTargetActivationFact[];
    agentRuntimesByAgentId: ReadonlyMap<string, AgentRuntimeRegistrationLease>;
    daemonAuthBridgesByServiceId: ReadonlyMap<string, Readonly<{
        pluginId: string;
        registration: PluginApiDaemonAuthBridgeRegistration;
    }>>;
    notificationCategoriesById: ReadonlyMap<string, Readonly<{
        pluginId: string;
        registration: PluginApiNotificationCategoryRegistration;
    }>>;
    notificationChannelsById: ReadonlyMap<string, Readonly<{
        pluginId: string;
        registration: PluginApiNotificationChannelRegistration;
    }>>;
    scmHostingProvidersById: ReadonlyMap<string, Readonly<{
        pluginId: string;
        generation: string;
        registration: PluginApiScmHostingProviderRegistration;
    }>>;
    scmBackendsById: ReadonlyMap<string, Readonly<{
        pluginId: string;
        generation: string;
        registration: PluginApiScmBackendRegistration;
    }>>;
    scmBackendRegistrations: readonly Readonly<{
        pluginId: string;
        generation: string;
        registration: PluginApiScmBackendRegistration;
    }>[];
    requestInterceptors: readonly TargetRequestInterceptorBinding[];
    mcpServers: readonly Readonly<{
        pluginId: string;
        registration: PluginApiMcpServerRegistration;
    }>[];
    mcpDiscoveryProviders: readonly Readonly<{
        pluginId: string;
        registration: PluginApiMcpDiscoveryProviderRegistration;
    }>[];
    networkAllowedPluginIds: ReadonlySet<string>;
    networkAllowedUrlOriginsByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    processSpawnAllowedPathsByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    systemToolDefinitionsByPluginId: ReadonlyMap<string, readonly PluginSystemToolContributionV1[]>;
    envAllowedNamesByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    filesystemReadAllowedPathsByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    filesystemWriteAllowedPathsByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    permissionsByPluginId: ReadonlyMap<string, ReadonlySet<PluginPermissionCapabilityV1>>;
    permissionDeclarationsByPluginId: ReadonlyMap<string, readonly PluginPermissionDeclarationV1[]>;
    requiredPermissionsByPluginId: ReadonlyMap<string, ReadonlySet<PluginPermissionCapabilityV1>>;
    requiredPermissionDeclarationsByPluginId: ReadonlyMap<string, readonly PluginPermissionDeclarationV1[]>;
    runtimeCapabilitiesByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    eventDeclarationsByPluginId: ReadonlyMap<string, readonly ParsedPluginEventContributionV1[]>;
    eventSubscriptionPermissionsByPluginId: ReadonlyMap<string, ReadonlySet<PluginPermissionCapabilityV1>>;
    actions: readonly ResolvedActionContribution[];
    tools: readonly ResolvedToolContribution[];
    commands: readonly ResolvedCommandContribution[];
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    activatedPluginIds: ReadonlySet<string>;
    failedActivationPluginIds: ReadonlySet<string>;
    retryableActivationPreparationPluginIds: ReadonlySet<string>;
    activateContributionsOnDemand: (
        demands: readonly PluginContributionActivationDemand[],
    ) => Promise<readonly PluginActivationDemandResult[]>;
    activatePluginsForValidation: (
        pluginIds: readonly string[],
    ) => Promise<readonly PluginActivationDemandResult[]>;
    addRuntimeDisposable: (pluginId: string, disposable: PluginDisposable) => PluginDisposable;
    dispose: (params?: PluginRuntimeDisposalOptions) => Promise<void>;
}>;

async function runPluginDisposalStep(params: Readonly<{
    pluginId: string;
    phase: PluginRuntimeDisposalPhase;
    options: PluginRuntimeDisposalOptions;
    operation: () => Promise<void>;
}>): Promise<boolean> {
    const timeoutMs = normalizePositiveTimeoutMs(params.options.timeoutMs)
        ?? DEFAULT_PLUGIN_RETIREMENT_TIMEOUT_MS;
    try {
        await runWithOptionalTimeout(
            timeoutMs,
            params.operation,
            () => new Error(`Plugin '${params.pluginId}' ${params.phase} timed out after ${timeoutMs}ms`),
        );
        return true;
    } catch (error) {
        try {
            params.options.onError?.({
                pluginId: params.pluginId,
                phase: params.phase,
                error,
            });
        } catch (observerError) {
            logger.warn('[PLUGIN RUNTIME] Plugin cleanup diagnostic observer failed during disposal', {
                pluginId: params.pluginId,
                phase: params.phase,
                error: observerError instanceof Error ? observerError.message : String(observerError),
            });
        }
        logger.warn('[PLUGIN RUNTIME] Plugin cleanup step failed during disposal', {
            pluginId: params.pluginId,
            phase: params.phase,
            error: error instanceof Error ? error.message : String(error),
        });
        return false;
    }
}

export async function activatePluginRuntimeRegistry(params: Readonly<{
    contributes: ResolvedContributionRegistry;
    generation: number;
    happyHomeDir?: string;
    pluginIds?: readonly string[];
    retainedRegistries?: readonly ActivatedPluginRuntimeRegistry[];
    immutableGenerationIdsByPluginId?: ReadonlyMap<string, string>;
    activationAdmissionFailuresByPluginId?: ReadonlyMap<string, Readonly<{
        immutableGenerationId: string;
        message: string;
        isCurrent: () => Promise<boolean>;
    }>>;
    resolveActivationSource?: (target: ActivationTarget) => PluginActivationSource<PluginDaemonModuleNamespace> | null;
    invocationServices?: TargetInvocationServiceOwner;
    activationPhase?: SupervisedPluginActivationAttempt['phase'];
    createActivationAttemptId?: () => string;
    nowMs?: () => number;
    onActivationAttempt?: (attempt: SupervisedPluginActivationAttempt) => void | Promise<void>;
    isActivationCurrent?: () => boolean;
    adoptActivationComponent?: (component: Readonly<{
        pluginId: string;
        registry: ActivatedPluginRuntimeRegistry;
    }>) => void;
    /** Internal recursion guard for the canonical per-plugin component composer. */
    activationComponentMode?: boolean;
}>): Promise<ActivatedPluginRuntimeRegistry> {
    if (params.adoptActivationComponent && !params.activationComponentMode) {
        const requestedPluginIds = params.pluginIds === undefined
            ? [
                ...collectActivationTargets(params.contributes)
                    .filter(shouldActivateTargetAtStartup)
                    .map((target) => target.pluginId),
                ...(params.activationAdmissionFailuresByPluginId?.keys() ?? []),
            ]
            : params.pluginIds;
        const componentRegistries: ActivatedPluginRuntimeRegistry[] = [];
        for (const pluginId of [...new Set(requestedPluginIds)].sort()) {
            const registry = await activatePluginRuntimeRegistry({
                ...params,
                pluginIds: Object.freeze([pluginId]),
                retainedRegistries: undefined,
                adoptActivationComponent: undefined,
                activationComponentMode: true,
            });
            params.adoptActivationComponent(Object.freeze({ pluginId, registry }));
            componentRegistries.push(registry);
        }
        return await activatePluginRuntimeRegistry({
            ...params,
            pluginIds: Object.freeze([]),
            retainedRegistries: Object.freeze([
                ...(params.retainedRegistries ?? []),
                ...componentRegistries,
            ]),
            activationComponentMode: true,
        });
    }
    const diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]> = {};
    const allowedPluginIds = params.pluginIds ? new Set(params.pluginIds) : null;
    const activationTargets = collectActivationTargets(params.contributes);
    const targetRegistrations: Array<{
        pluginId: string;
        generation: string;
        registration: ContributionRuntimeRegistration;
    }> = [];
    const targetActivationFacts: PluginTargetActivationFact[] = [];
    const targetActivationDisposers: Array<Readonly<{
        pluginId: string;
        dispose(): Promise<void>;
    }>> = [];
    const retryableActivationPreparationPluginIds = new Set<string>();
    const reportedAdmissionFailurePluginIds = new Set<string>();
    let targetGenerationCurrent = true;
    const runtimeDisposableRegistriesByPluginId = new Map<string, ReturnType<typeof createPluginDisposableRegistry>>();
    const activationPhase = params.activationPhase ?? 'primaryBootstrap';
    const createActivationAttemptId = params.createActivationAttemptId ?? randomUUID;
    const nowMs = params.nowMs ?? Date.now;
    const isActivationCurrent = params.isActivationCurrent ?? (() => true);

    async function beginSupervisedAttempt(
        target: ActivationTarget,
        source: PluginActivationSource<PluginDaemonModuleNamespace>,
    ): Promise<Omit<SupervisedPluginActivationAttempt, 'completedAtMs' | 'outcome'> | null> {
        if (source.kind !== 'file_backed' || !source.committedAuthorization) return null;
        const authorization = source.committedAuthorization;
        if (authorization.pluginId !== target.pluginId) return null;
        try {
            if (!(await authorization.isCurrent())) return null;
        } catch {
            return null;
        }
        return Object.freeze({
            attemptId: createActivationAttemptId(),
            pluginId: target.pluginId,
            immutableGenerationId: authorization.immutableGenerationId,
            phase: activationPhase,
            startedAtMs: nowMs(),
        });
    }

    function completeSupervisedAttempt(
        attempt: Omit<SupervisedPluginActivationAttempt, 'completedAtMs' | 'outcome'> | null,
        outcome: SupervisedPluginActivationAttempt['outcome'],
    ): void {
        if (!attempt || !params.onActivationAttempt) return;
        const completed = Object.freeze({ ...attempt, completedAtMs: nowMs(), outcome });
        const reportObserverError = (error: unknown): void => {
            logger.warn('[PLUGIN RUNTIME] Plugin activation health observer failed', {
                pluginId: completed.pluginId,
                immutableGenerationId: completed.immutableGenerationId,
                attemptId: completed.attemptId,
                phase: completed.phase,
                error: error instanceof Error ? error.message : String(error),
            });
        };
        try {
            void Promise.resolve(params.onActivationAttempt(completed)).catch(reportObserverError);
        } catch (error) {
            reportObserverError(error);
        }
    }

    for (const target of activationTargets) {
        if (allowedPluginIds && !allowedPluginIds.has(target.pluginId)) {
            continue;
        }
        if (!allowedPluginIds && !shouldActivateTargetAtStartup(target)) {
            continue;
        }
        diagnosticsByPluginId[target.pluginId] = diagnosticsByPluginId[target.pluginId] ?? [];

        const targetFactMetadata = Object.freeze({
            pluginId: target.pluginId,
            pluginVersion: target.manifest.version,
            source: mapPluginSourceToDiagnosticSource(target.sourceSpec),
            generation: String(params.generation),
            host: 'daemon' as const,
            platform: process.platform,
        });
        const admissionFailure = params.activationAdmissionFailuresByPluginId?.get(target.pluginId);
        if (admissionFailure) {
            let current = false;
            try {
                current = await admissionFailure.isCurrent();
            } catch {
                current = false;
            }
            if (!current) continue;
            const diagnostic: PluginCompatibilityDiagnostic = {
                code: 'plugin_daemon_module_load_failed',
                message: `Committed plugin generation admission failed for '${target.pluginId}' (${admissionFailure.immutableGenerationId}): ${admissionFailure.message}`,
            };
            appendDiagnostic(diagnosticsByPluginId, target.pluginId, diagnostic);
            targetActivationFacts.push(Object.freeze({
                ...targetFactMetadata,
                occurredAtMs: nowMs(),
                status: 'unavailable',
                required: Object.freeze([...derivePluginDaemonContributionRegistrationRights(
                    target.manifest.contributes as unknown as Readonly<Record<string, unknown>>,
                )]),
                bound: Object.freeze([]),
                diagnostics: Object.freeze([diagnostic]),
            }));
            completeSupervisedAttempt(Object.freeze({
                attemptId: createActivationAttemptId(),
                pluginId: target.pluginId,
                immutableGenerationId: admissionFailure.immutableGenerationId,
                phase: activationPhase,
                startedAtMs: nowMs(),
            }), 'fatal');
            reportedAdmissionFailurePluginIds.add(target.pluginId);
            continue;
        }
        let activationSource: PluginActivationSource<PluginDaemonModuleNamespace>;
        try {
            activationSource = resolveActivationSource(target, params.resolveActivationSource);
        } catch (error) {
            const diagnostic = mapDaemonModuleLoadErrorToDiagnostic(error);
            appendDiagnostic(diagnosticsByPluginId, target.pluginId, diagnostic);
            targetActivationFacts.push(Object.freeze({
                ...targetFactMetadata,
                occurredAtMs: Date.now(),
                status: 'unavailable',
                required: Object.freeze([...derivePluginDaemonContributionRegistrationRights(
                    target.manifest.contributes as unknown as Readonly<Record<string, unknown>>,
                )]),
                bound: Object.freeze([]),
                diagnostics: Object.freeze([diagnostic]),
            }));
            continue;
        }
        const supervisedAttempt = await beginSupervisedAttempt(target, activationSource);

        if (!isActivationCurrent()) {
            continue;
        }
        let moduleNamespace: PluginDaemonModuleNamespace;
        if (activationSource.kind === 'bundled' && activationSource.prepare) {
            try {
                try {
                    await activationSource.prepare();
                } catch (error) {
                    if (activationPhase !== 'primaryBootstrap') throw error;
                    // A failed aggregate source-dev preflight switches the bundled source
                    // to package-local isolation. Startup must consume that transition in
                    // this generation; lazy activation instead retries on later demand.
                    await activationSource.prepare();
                }
            } catch (error) {
                if (!isActivationCurrent()) {
                    continue;
                }
                const diagnostic = mapDaemonModuleLoadErrorToDiagnostic(error);
                appendDiagnostic(diagnosticsByPluginId, target.pluginId, diagnostic);
                targetActivationFacts.push(Object.freeze({
                    ...targetFactMetadata,
                    occurredAtMs: Date.now(),
                    status: 'unavailable',
                    required: Object.freeze([...derivePluginDaemonContributionRegistrationRights(
                        target.manifest.contributes as unknown as Readonly<Record<string, unknown>>,
                    )]),
                    bound: Object.freeze([]),
                    diagnostics: Object.freeze([diagnostic]),
                }));
                if (activationPhase === 'lazyActivation') {
                    retryableActivationPreparationPluginIds.add(target.pluginId);
                }
                continue;
            }
        }
        if (!isActivationCurrent()) {
            continue;
        }
        try {
            moduleNamespace = await loadPluginModule({
                source: activationSource,
                cacheKey: `${target.manifestDigest}:generation:${params.generation}`,
            }) as PluginDaemonModuleNamespace;
        } catch (error) {
            if (!isActivationCurrent()) {
                continue;
            }
            completeSupervisedAttempt(supervisedAttempt, 'fatal');
            const diagnostic = mapDaemonModuleLoadErrorToDiagnostic(error);
            appendDiagnostic(diagnosticsByPluginId, target.pluginId, diagnostic);
            targetActivationFacts.push(Object.freeze({
                ...targetFactMetadata,
                occurredAtMs: Date.now(),
                status: 'unavailable',
                required: Object.freeze([...derivePluginDaemonContributionRegistrationRights(
                    target.manifest.contributes as unknown as Readonly<Record<string, unknown>>,
                )]),
                bound: Object.freeze([]),
                diagnostics: Object.freeze([diagnostic]),
            }));
            continue;
        }
        if (!isActivationCurrent()) {
            continue;
        }

        {
            const required = derivePluginDaemonContributionRegistrationRights(
                target.manifest.contributes as unknown as Readonly<Record<string, unknown>>,
            );
            const activated = await activateContributionModule({
                pluginId: target.pluginId,
                generation: String(params.generation),
                manifest: target.manifest,
                moduleNamespace,
                isGenerationCurrent: () => targetGenerationCurrent,
                forceActivation: target.activationEvents?.includes('startup') === true,
            });
            completeSupervisedAttempt(
                supervisedAttempt,
                activated.status === 'unavailable' ? 'fatal' : 'nonfatal',
            );
            appendDiagnostics(diagnosticsByPluginId, target.pluginId, activated.diagnostics);
            targetActivationFacts.push(Object.freeze({
                ...targetFactMetadata,
                occurredAtMs: Date.now(),
                status: activated.status,
                required: Object.freeze([...required]),
                bound: Object.freeze(activated.registrations.map(({ family, localId }) => Object.freeze({ family, localId }))),
                diagnostics: activated.diagnostics,
            }));
            if (activated.status === 'active') {
                targetRegistrations.push(...activated.registrations.map((registration) => Object.freeze({
                    pluginId: target.pluginId,
                    generation: String(params.generation),
                    registration,
                })));
                targetActivationDisposers.push(Object.freeze({
                    pluginId: target.pluginId,
                    dispose: activated.dispose,
                }));
            }
            continue;
        }

    }

    for (const [pluginId, admissionFailure] of params.activationAdmissionFailuresByPluginId ?? []) {
        if (
            reportedAdmissionFailurePluginIds.has(pluginId)
            || (allowedPluginIds && !allowedPluginIds.has(pluginId))
        ) continue;
        let current = false;
        try {
            current = await admissionFailure.isCurrent();
        } catch {
            current = false;
        }
        if (!current) continue;
        const diagnostic: PluginCompatibilityDiagnostic = {
            code: 'plugin_daemon_module_load_failed',
            message: `Committed plugin generation admission failed for '${pluginId}' (${admissionFailure.immutableGenerationId}): ${admissionFailure.message}`,
        };
        appendDiagnostic(diagnosticsByPluginId, pluginId, diagnostic);
        completeSupervisedAttempt(Object.freeze({
            attemptId: createActivationAttemptId(),
            pluginId,
            immutableGenerationId: admissionFailure.immutableGenerationId,
            phase: activationPhase,
            startedAtMs: nowMs(),
        }), 'fatal');
    }

    const activatedTargetMetadataEntries = [] as Array<Readonly<{
        pluginId: string;
        permissions: readonly PluginPermissionCapabilityV1[];
        permissionDeclarations: readonly PluginPermissionDeclarationV1[];
        requiredPermissions: readonly PluginPermissionCapabilityV1[];
        requiredPermissionDeclarations: readonly PluginPermissionDeclarationV1[];
        runtimeCapabilities: readonly string[];
        systemTools: readonly PluginSystemToolContributionV1[];
        declaredEventDeclarations: readonly ParsedPluginEventContributionV1[];
    }>>;
    for (const target of activationTargets) {
        const active = targetActivationFacts.some((fact) => (
            fact.pluginId === target.pluginId
            && fact.generation === String(params.generation)
            && fact.status === 'active'
        ));
        if (!active) continue;
        const policy = buildActivationPolicy(target.manifest);
        activatedTargetMetadataEntries.push(Object.freeze({
            pluginId: target.pluginId,
            permissions: Object.freeze([...new Set(policy.permissionDeclarations.map((permission) => permission.capability))]),
            permissionDeclarations: policy.permissionDeclarations,
            requiredPermissions: Object.freeze([...policy.permissions]),
            requiredPermissionDeclarations: policy.permissionDeclarations,
            runtimeCapabilities: policy.runtimeCapabilities,
            systemTools: policy.systemTools,
            declaredEventDeclarations: policy.declaredEventDeclarations,
        }));
    }

    let lifecycleState: 'active' | 'disposing' | 'disposed' = 'active';
    let disposalPromise: Promise<void> | null = null;
    const agentExternalSessionsRetirement = new AbortController();
    const targetHookHandlersByHookId = createTargetHookHandlerRegistry({
        generation: params.generation,
        activationTargets,
        targetRegistrations,
        isGenerationActive: () => lifecycleState === 'active',
        ...(params.invocationServices ? { invocationServices: params.invocationServices } : {}),
    });
    const targetMcpDiscoveryProviders = createTargetMcpDiscoveryProviders({
        generation: params.generation,
        activationTargets,
        targetRegistrations,
        isGenerationActive: () => lifecycleState === 'active',
        ...(params.invocationServices ? { invocationServices: params.invocationServices } : {}),
    });
    const targetScmRuntimeEntries = createTargetScmRuntimeEntries({
        generation: params.generation,
        activationTargets,
        targetRegistrations,
        isGenerationActive: () => lifecycleState === 'active',
    });
    const targetRequestInterceptorBindings = createTargetRequestInterceptorBindings({
        generation: params.generation,
        activationTargets,
        targetRegistrations,
        isGenerationActive: () => lifecycleState === 'active',
    });
    const agentRuntimesByAgentId = new Map(createTargetAgentRuntimeRegistry({
        agents: params.contributes.agents,
        activationTargets,
        targetRegistrations,
        immutableGenerationIdsByPluginId: params.immutableGenerationIdsByPluginId,
        isGenerationActive: () => lifecycleState === 'active',
        retirementSignal: agentExternalSessionsRetirement.signal,
        onDuplicate: ({ agentId, firstPluginId, secondPluginId }) => {
            for (const [pluginId, otherPluginId] of [
                [firstPluginId, secondPluginId],
                [secondPluginId, firstPluginId],
            ] as const) {
                appendDiagnostic(diagnosticsByPluginId, pluginId, {
                    code: 'plugin_agent_runtime_duplicate_agent_id',
                    message: `Plugin '${pluginId}' registered an agent runtime for '${agentId}', but it is also registered by plugin '${otherPluginId}'`,
                });
            }
        },
    }));
    const daemonAuthBridgesByServiceId = new Map<string, Readonly<{
        pluginId: string;
        registration: PluginApiDaemonAuthBridgeRegistration;
    }>>();
    const notificationCategoriesById = new Map<string, Readonly<{
        pluginId: string;
        registration: PluginApiNotificationCategoryRegistration;
    }>>();
    const notificationChannelsById = new Map<string, Readonly<{
        pluginId: string;
        registration: PluginApiNotificationChannelRegistration;
    }>>();
    const scmHostingProvidersById = new Map<string, Readonly<{
        pluginId: string;
        generation: string;
        registration: PluginApiScmHostingProviderRegistration;
    }>>();
    const scmBackendsById = new Map<string, Readonly<{
        pluginId: string;
        generation: string;
        registration: PluginApiScmBackendRegistration;
    }>>();
    const scmBackendRegistrations: Readonly<{
        pluginId: string;
        generation: string;
        registration: PluginApiScmBackendRegistration;
    }>[] = [];

    for (const entry of targetScmRuntimeEntries.hostingProviders) {
        const qualifiedId = `${entry.pluginId}/${entry.registration.id}`;
        scmHostingProvidersById.set(qualifiedId, entry);
    }
    for (const entry of targetScmRuntimeEntries.backends) {
        const qualifiedId = `${entry.pluginId}/${entry.registration.id}`;
        scmBackendsById.set(qualifiedId, entry);
        scmBackendRegistrations.push(entry);
    }

    const networkAllowedUrlOriginsByPluginId = new Map(collectScopedPermissionMap(
        activatedTargetMetadataEntries,
        'network',
        normalizeNetworkPermissionOrigin,
    ));
    const processSpawnAllowedPathsByPluginId = new Map(collectScopedPermissionMap(
        activatedTargetMetadataEntries,
        'process.spawn',
        normalizeProcessSpawnPermissionPath,
    ));
    const envAllowedNamesByPluginId = new Map(collectScopedPermissionMap(
        activatedTargetMetadataEntries,
        'env',
        normalizeEnvPermissionName,
    ));
    const filesystemReadAllowedPathsByPluginId = new Map(collectOptionalScopedPermissionMap(
        activatedTargetMetadataEntries,
        'filesystem.read',
        normalizeFilesystemPermissionPath,
    ));
    const filesystemWriteAllowedPathsByPluginId = new Map(collectOptionalScopedPermissionMap(
        activatedTargetMetadataEntries,
        'filesystem.write',
        normalizeFilesystemPermissionPath,
    ));
    const hookHandlersByHookId = new Map(targetHookHandlersByHookId);
    const requestInterceptors: TargetRequestInterceptorBinding[] = [...targetRequestInterceptorBindings];
    const mcpServers: Array<Readonly<{
        pluginId: string;
        registration: PluginApiMcpServerRegistration;
    }>> = [];
    const mcpDiscoveryProviders = [...targetMcpDiscoveryProviders];
    const networkAllowedPluginIds = new Set(activatedTargetMetadataEntries.flatMap((entry) => (
        entry.permissions.includes('network') ? [entry.pluginId] : []
    )));
    const systemToolDefinitionsByPluginId = new Map(activatedTargetMetadataEntries.map((entry) => [
        entry.pluginId,
        Object.freeze([...entry.systemTools]),
    ]));
    const permissionsByPluginId = new Map(activatedTargetMetadataEntries.map((entry) => [
        entry.pluginId,
        new Set(entry.permissions),
    ]));
    const permissionDeclarationsByPluginId = new Map(activatedTargetMetadataEntries.map((entry) => [
        entry.pluginId,
        Object.freeze([...entry.permissionDeclarations]),
    ]));
    const requiredPermissionsByPluginId = new Map(activatedTargetMetadataEntries.map((entry) => [
        entry.pluginId,
        new Set(entry.requiredPermissions),
    ]));
    const requiredPermissionDeclarationsByPluginId = new Map(activatedTargetMetadataEntries.map((entry) => [
        entry.pluginId,
        Object.freeze([...entry.requiredPermissionDeclarations]),
    ]));
    const runtimeCapabilitiesByPluginId = new Map(activatedTargetMetadataEntries.map((entry) => [
        entry.pluginId,
        new Set(entry.runtimeCapabilities),
    ]));
    const eventDeclarationsByPluginId = new Map(activatedTargetMetadataEntries.map((entry) => [
        entry.pluginId,
        Object.freeze([...entry.declaredEventDeclarations]),
    ]));
    const eventSubscriptionPermissionsByPluginId = new Map(activatedTargetMetadataEntries.map((entry) => [
        entry.pluginId,
        new Set(entry.permissions),
    ]));
    const actions: ResolvedActionContribution[] = [];
    const tools: ResolvedToolContribution[] = [];
    const commands: ResolvedCommandContribution[] = [];
    const activatedPluginIds = new Set(
        targetActivationFacts.flatMap((fact) => fact.status === 'active' ? [fact.pluginId] : []),
    );
    const failedActivationPluginIds = new Set(
        targetActivationFacts.flatMap((fact) => fact.status === 'unavailable' ? [fact.pluginId] : []),
    );
    const lazyActivationPromisesByPluginId = new Map<string, Promise<PluginActivationDemandResult>>();
    const lazyActivatedRegistries: ActivatedPluginRuntimeRegistry[] = [];

    const addRuntimeDisposable = (pluginId: string, disposable: PluginDisposable): PluginDisposable => {
        const registry = runtimeDisposableRegistriesByPluginId.get(pluginId) ?? createPluginDisposableRegistry();
        runtimeDisposableRegistriesByPluginId.set(pluginId, registry);
        return registry.add(disposable);
    };

    function mergeHandlerMaps(registry: ActivatedHandlerRegistry): void {
        for (const [hookId, handlers] of registry.hookHandlersByHookId.entries()) {
            const existing = hookHandlersByHookId.get(hookId) ?? [];
            hookHandlersByHookId.set(
                hookId,
                Object.freeze([...existing, ...handlers].sort((left, right) => (
                    left.priority - right.priority
                    || left.pluginId.localeCompare(right.pluginId)
                    || left.registrationIndex - right.registrationIndex
                    || left.manifestPath.localeCompare(right.manifestPath)
                    || (left.localId ?? '').localeCompare(right.localId ?? '')
                    || left.daemonEntryPath.localeCompare(right.daemonEntryPath)
                ))),
            );
        }
    }

    function mergeMapEntries<TKey, TValue>(target: Map<TKey, TValue>, source: ReadonlyMap<TKey, TValue>): void {
        for (const [key, value] of source.entries()) {
            target.set(key, value);
        }
    }

    function mergeSetEntries<TValue>(target: Set<TValue>, source: ReadonlySet<TValue>): void {
        for (const value of source) {
            target.add(value);
        }
    }

    function mergeDiagnosticsFromRegistry(registry: ActivatedPluginRuntimeRegistry, pluginId: string): void {
        const diagnostics = registry.pluginDiagnosticsByPluginId[pluginId] ?? [];
        diagnosticsByPluginId[pluginId] = diagnosticsByPluginId[pluginId] ?? [];
        for (const diagnostic of diagnostics) {
            if (!diagnosticsByPluginId[pluginId].some((existing) => (
                existing.code === diagnostic.code && existing.message === diagnostic.message
            ))) {
                diagnosticsByPluginId[pluginId].push(diagnostic);
            }
        }
    }

    function appendLazyActivationUnavailableDiagnostic(pluginId: string): void {
        const message = `Plugin '${pluginId}' activation skipped because the plugin runtime registry is disposed`;
        if (!diagnosticsByPluginId[pluginId]?.some((diagnostic) => (
            diagnostic.code === 'plugin_activation_failed' && diagnostic.message === message
        ))) {
            appendDiagnostic(diagnosticsByPluginId, pluginId, {
                code: 'plugin_activation_failed',
                message,
            });
        }
        failedActivationPluginIds.add(pluginId);
    }

    async function mergeActivatedRegistry(registry: ActivatedPluginRuntimeRegistry, pluginId: string): Promise<void> {
        const activated = registry.activatedPluginIds.has(pluginId);
        if (activated) {
            params.adoptActivationComponent?.(Object.freeze({ pluginId, registry }));
        }
        targetRegistrations.push(...registry.targetRegistrations);
        targetActivationFacts.push(...registry.targetActivationFacts);
        mergeHandlerMaps(registry);
        mergeMapEntries(agentRuntimesByAgentId, registry.agentRuntimesByAgentId);
        mergeMapEntries(daemonAuthBridgesByServiceId, registry.daemonAuthBridgesByServiceId);
        mergeMapEntries(notificationCategoriesById, registry.notificationCategoriesById);
        mergeMapEntries(notificationChannelsById, registry.notificationChannelsById);
        mergeMapEntries(scmHostingProvidersById, registry.scmHostingProvidersById);
        mergeMapEntries(scmBackendsById, registry.scmBackendsById);
        scmBackendRegistrations.push(...registry.scmBackendRegistrations);
        requestInterceptors.push(...registry.requestInterceptors);
        mcpServers.push(...registry.mcpServers);
        mcpDiscoveryProviders.push(...registry.mcpDiscoveryProviders);
        mergeSetEntries(networkAllowedPluginIds, registry.networkAllowedPluginIds);
        mergeMapEntries(networkAllowedUrlOriginsByPluginId, registry.networkAllowedUrlOriginsByPluginId);
        mergeMapEntries(processSpawnAllowedPathsByPluginId, registry.processSpawnAllowedPathsByPluginId);
        mergeMapEntries(systemToolDefinitionsByPluginId, registry.systemToolDefinitionsByPluginId);
        mergeMapEntries(envAllowedNamesByPluginId, registry.envAllowedNamesByPluginId);
        mergeMapEntries(filesystemReadAllowedPathsByPluginId, registry.filesystemReadAllowedPathsByPluginId);
        mergeMapEntries(filesystemWriteAllowedPathsByPluginId, registry.filesystemWriteAllowedPathsByPluginId);
        mergeMapEntries(permissionsByPluginId, registry.permissionsByPluginId);
        mergeMapEntries(permissionDeclarationsByPluginId, registry.permissionDeclarationsByPluginId);
        mergeMapEntries(requiredPermissionsByPluginId, registry.requiredPermissionsByPluginId);
        mergeMapEntries(requiredPermissionDeclarationsByPluginId, registry.requiredPermissionDeclarationsByPluginId);
        mergeMapEntries(runtimeCapabilitiesByPluginId, registry.runtimeCapabilitiesByPluginId);
        mergeMapEntries(eventDeclarationsByPluginId, registry.eventDeclarationsByPluginId);
        mergeMapEntries(eventSubscriptionPermissionsByPluginId, registry.eventSubscriptionPermissionsByPluginId);
        actions.push(...registry.actions);
        tools.push(...registry.tools);
        commands.push(...registry.commands);
        mergeDiagnosticsFromRegistry(registry, pluginId);
        if (activated) {
            activatedPluginIds.add(pluginId);
            if (!params.adoptActivationComponent) {
                lazyActivatedRegistries.push(registry);
            }
        } else {
            failedActivationPluginIds.add(pluginId);
        }
    }

    function mergeRetainedRegistry(registry: ActivatedPluginRuntimeRegistry): void {
        targetRegistrations.push(...registry.targetRegistrations);
        targetActivationFacts.push(...registry.targetActivationFacts);
        mergeHandlerMaps(registry);
        mergeMapEntries(agentRuntimesByAgentId, registry.agentRuntimesByAgentId);
        mergeMapEntries(daemonAuthBridgesByServiceId, registry.daemonAuthBridgesByServiceId);
        mergeMapEntries(notificationCategoriesById, registry.notificationCategoriesById);
        mergeMapEntries(notificationChannelsById, registry.notificationChannelsById);
        mergeMapEntries(scmHostingProvidersById, registry.scmHostingProvidersById);
        mergeMapEntries(scmBackendsById, registry.scmBackendsById);
        scmBackendRegistrations.push(...registry.scmBackendRegistrations);
        requestInterceptors.push(...registry.requestInterceptors);
        mcpServers.push(...registry.mcpServers);
        mcpDiscoveryProviders.push(...registry.mcpDiscoveryProviders);
        mergeSetEntries(networkAllowedPluginIds, registry.networkAllowedPluginIds);
        mergeMapEntries(networkAllowedUrlOriginsByPluginId, registry.networkAllowedUrlOriginsByPluginId);
        mergeMapEntries(processSpawnAllowedPathsByPluginId, registry.processSpawnAllowedPathsByPluginId);
        mergeMapEntries(systemToolDefinitionsByPluginId, registry.systemToolDefinitionsByPluginId);
        mergeMapEntries(envAllowedNamesByPluginId, registry.envAllowedNamesByPluginId);
        mergeMapEntries(filesystemReadAllowedPathsByPluginId, registry.filesystemReadAllowedPathsByPluginId);
        mergeMapEntries(filesystemWriteAllowedPathsByPluginId, registry.filesystemWriteAllowedPathsByPluginId);
        mergeMapEntries(permissionsByPluginId, registry.permissionsByPluginId);
        mergeMapEntries(permissionDeclarationsByPluginId, registry.permissionDeclarationsByPluginId);
        mergeMapEntries(requiredPermissionsByPluginId, registry.requiredPermissionsByPluginId);
        mergeMapEntries(requiredPermissionDeclarationsByPluginId, registry.requiredPermissionDeclarationsByPluginId);
        mergeMapEntries(runtimeCapabilitiesByPluginId, registry.runtimeCapabilitiesByPluginId);
        mergeMapEntries(eventDeclarationsByPluginId, registry.eventDeclarationsByPluginId);
        mergeMapEntries(eventSubscriptionPermissionsByPluginId, registry.eventSubscriptionPermissionsByPluginId);
        actions.push(...registry.actions);
        tools.push(...registry.tools);
        commands.push(...registry.commands);
        for (const pluginId of Object.keys(registry.pluginDiagnosticsByPluginId)) {
            mergeDiagnosticsFromRegistry(registry, pluginId);
        }
        mergeSetEntries(activatedPluginIds, registry.activatedPluginIds);
        mergeSetEntries(failedActivationPluginIds, registry.failedActivationPluginIds);
        mergeSetEntries(retryableActivationPreparationPluginIds, registry.retryableActivationPreparationPluginIds);
    }

    async function activatePluginIdForDemand(pluginId: string): Promise<PluginActivationDemandResult> {
        if (lifecycleState !== 'active') {
            appendLazyActivationUnavailableDiagnostic(pluginId);
            return {
                pluginId,
                diagnostics: Object.freeze([...(diagnosticsByPluginId[pluginId] ?? [])]),
            };
        }
        if (activatedPluginIds.has(pluginId) || failedActivationPluginIds.has(pluginId)) {
            return {
                pluginId,
                diagnostics: Object.freeze([...(diagnosticsByPluginId[pluginId] ?? [])]),
            };
        }
        const existing = lazyActivationPromisesByPluginId.get(pluginId);
        if (existing) {
            return await existing;
        }

        const promise = (async (): Promise<PluginActivationDemandResult> => {
            const registry = await activatePluginRuntimeRegistry({
                contributes: params.contributes,
                generation: params.generation,
                happyHomeDir: params.happyHomeDir,
                pluginIds: [pluginId],
                immutableGenerationIdsByPluginId: params.immutableGenerationIdsByPluginId,
                resolveActivationSource: params.resolveActivationSource,
                activationPhase: 'lazyActivation',
                createActivationAttemptId,
                nowMs,
                onActivationAttempt: params.onActivationAttempt,
                isActivationCurrent: () => lifecycleState === 'active',
                ...(params.invocationServices ? { invocationServices: params.invocationServices } : {}),
            });
            if (registry.retryableActivationPreparationPluginIds.has(pluginId)) {
                const diagnostics = Object.freeze([
                    ...(registry.pluginDiagnosticsByPluginId[pluginId] ?? []),
                ]);
                await registry.dispose({ timeoutMs: 5_000 }).catch((error: unknown) => {
                    logger.warn('[PLUGIN RUNTIME] Failed to dispose retryable lazy activation preparation', {
                        pluginId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                });
                return { pluginId, diagnostics };
            }
            if (lifecycleState !== 'active') {
                appendLazyActivationUnavailableDiagnostic(pluginId);
                await registry.dispose({ timeoutMs: 5_000 }).catch((error: unknown) => {
                    logger.warn('[PLUGIN RUNTIME] Failed to dispose late lazy activation after registry disposal', {
                        pluginId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                });
                return {
                    pluginId,
                    diagnostics: Object.freeze([...(diagnosticsByPluginId[pluginId] ?? [])]),
                };
            }
            await mergeActivatedRegistry(registry, pluginId);
            return {
                pluginId,
                diagnostics: Object.freeze([...(diagnosticsByPluginId[pluginId] ?? [])]),
            };
        })();
        lazyActivationPromisesByPluginId.set(pluginId, promise);
        try {
            return await promise;
        } finally {
            lazyActivationPromisesByPluginId.delete(pluginId);
        }
    }

    async function activateContributionsOnDemand(
        demands: readonly PluginContributionActivationDemand[],
    ): Promise<readonly PluginActivationDemandResult[]> {
        const pluginIds = [...new Set(
            activationTargets
                .filter((target) => demands.some((demand) => (
                    activationTargetMatchesContributionDemand(target, demand)
                )))
                .map((target) => target.pluginId),
        )].sort();
        return Object.freeze(await Promise.all(pluginIds.map((pluginId) => activatePluginIdForDemand(pluginId))));
    }

    async function activatePluginsForValidation(
        pluginIds: readonly string[],
    ): Promise<readonly PluginActivationDemandResult[]> {
        const executablePluginIds = new Set(activationTargets.map((target) => target.pluginId));
        const selected = [...new Set(pluginIds.map((pluginId) => pluginId.trim()).filter((pluginId) => (
            pluginId.length > 0 && executablePluginIds.has(pluginId)
        )))].sort();
        return Object.freeze(await Promise.all(selected.map((pluginId) => activatePluginIdForDemand(pluginId))));
    }

    for (const retained of params.retainedRegistries ?? []) {
        mergeRetainedRegistry(retained);
    }

    return {
        generation: params.generation,
        targetRegistrations,
        targetActivationFacts,
        agentRuntimesByAgentId,
        daemonAuthBridgesByServiceId,
        notificationCategoriesById,
        notificationChannelsById,
        scmHostingProvidersById,
        scmBackendsById,
        scmBackendRegistrations,
        requestInterceptors,
        mcpServers,
        mcpDiscoveryProviders,
        networkAllowedPluginIds,
        networkAllowedUrlOriginsByPluginId,
        processSpawnAllowedPathsByPluginId,
        systemToolDefinitionsByPluginId,
        envAllowedNamesByPluginId,
        filesystemReadAllowedPathsByPluginId,
        filesystemWriteAllowedPathsByPluginId,
        permissionsByPluginId,
        permissionDeclarationsByPluginId,
        requiredPermissionsByPluginId,
        requiredPermissionDeclarationsByPluginId,
        runtimeCapabilitiesByPluginId,
        eventDeclarationsByPluginId,
        eventSubscriptionPermissionsByPluginId,
        actions,
        tools,
        commands,
        hookHandlersByHookId,
        pluginDiagnosticsByPluginId: diagnosticsByPluginId,
        activatedPluginIds,
        failedActivationPluginIds,
        retryableActivationPreparationPluginIds,
        activateContributionsOnDemand,
        activatePluginsForValidation,
        addRuntimeDisposable,
        dispose(disposeOptions = {}) {
            if (disposalPromise) return disposalPromise;
            disposalPromise = (async () => {
                lifecycleState = 'disposing';
                agentExternalSessionsRetirement.abort();
                targetGenerationCurrent = false;
                try {
                    for (const target of [...targetActivationDisposers].reverse()) {
                        await runPluginDisposalStep({
                            pluginId: target.pluginId,
                            phase: 'target_activation',
                            options: disposeOptions,
                            operation: target.dispose,
                        });
                    }
                    targetRegistrations.length = 0;
                    for (const registry of [...lazyActivatedRegistries].reverse()) {
                        await registry.dispose(disposeOptions);
                    }
                    for (const [pluginId, registry] of [...runtimeDisposableRegistriesByPluginId.entries()].reverse()) {
                        await runPluginDisposalStep({
                            pluginId,
                            phase: 'runtime_disposables',
                            options: disposeOptions,
                            operation: registry.dispose,
                        });
                    }
                    runtimeDisposableRegistriesByPluginId.clear();
                } finally {
                    targetRegistrations.length = 0;
                    lifecycleState = 'disposed';
                }
            })();
            return disposalPromise;
        },
    };
}
