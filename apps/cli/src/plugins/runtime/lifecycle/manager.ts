import { randomUUID } from 'node:crypto';

import type {
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
    PluginDisposable,
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
    projectPluginFailureText,
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
import {
    buildActivationPolicy,
} from './activation/policy';
import {
    createTargetHookHandlerRegistry,
    type TargetInvocationServiceOwner,
} from './contributions/targetHooks';
import { createTargetScmRuntimeEntries } from './contributions/targetScm';
import {
    createTargetRequestInterceptorBindings,
    type TargetRequestInterceptorBinding,
} from './contributions/targetRequestInterceptors';
import {
    type PluginTargetActivationFact,
    projectPluginTargetActivationRegistrationFacts,
} from './activation/facts';
import { mapPluginSourceToDiagnosticSource } from '@/plugins/projection/introspection/source';
import {
    createTargetAgentRuntimeRegistry,
    type AgentRuntimeRegistrationLease,
} from './contributions/targetAgents';
import { createBackgroundServiceRunnerHost } from './contributions/backgroundServices';
import {
    projectRequiredManifestEnvironmentNames,
    projectRequiredManifestWorkspaceFilesystemReadPaths,
    resolveManifestHostAccessRequests,
} from '../hostAccess/manifestRequests';
import { createPluginInvocationPresentation } from '../invocation/services/interactions';
import { createPluginInvocationLifetime } from '../invocation/lifetime';
import type { PluginInvocationServicesSeed } from '../invocation/services/types';

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
    systemToolDefinitionsByPluginId: ReadonlyMap<string, readonly PluginSystemToolContributionV1[]>;
    envAllowedNamesByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    filesystemReadAllowedPathsByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    runtimeCapabilitiesByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    eventDeclarationsByPluginId: ReadonlyMap<string, readonly ParsedPluginEventContributionV1[]>;
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
    /**
     * Records a host-owned terminal availability failure that arrives after
     * this plugin's activation fact was produced — readiness rejection or an
     * unexpectedly settled generation-long background service. The plugin
     * leaves the activated set, its one activation fact becomes `unavailable`,
     * and the reason uses the existing activation diagnostic owner.
     */
    recordPluginActivationFailure: (pluginId: string, message: string) => void;
    startAdoptedBackgroundServices: () => void;
    retireBackgroundServices: (pluginIds: readonly string[]) => void;
    settleRetiredBackgroundServices: (pluginIds: readonly string[]) => Promise<void>;
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
                error: projectPluginFailureText(observerError),
            });
        }
        logger.warn('[PLUGIN RUNTIME] Plugin cleanup step failed during disposal', {
            pluginId: params.pluginId,
            phase: params.phase,
            error: projectPluginFailureText(error),
        });
        return false;
    }
}

function resolveLocalDevelopmentDiagnosticSourceRoot(
    target: ActivationTarget,
    source: PluginActivationSource<PluginDaemonModuleNamespace>,
): string | undefined {
    if (
        source.kind !== 'file_backed'
        || source.useDevelopmentEntry !== true
        || !source.committedAuthorization
        || target.sourceSpec.kind !== 'path'
        || target.sourceSpec.devWatch !== true
    ) {
        return undefined;
    }
    return target.sourceSpec.locator;
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
    retryFailedPreparation?: boolean;
    nowMs?: () => number;
    isActivationCurrent?: () => boolean;
    adoptActivationComponent?: (component: Readonly<{
        pluginId: string;
        registry: ActivatedPluginRuntimeRegistry;
    }>) => void;
    /** Same-generation lazy activation became terminally unavailable. */
    onTerminalActivationFailure?: (pluginId: string) => void;
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
    const runtimeDisposableRetirementPromisesByPluginId = new Map<string, Promise<void>>();
    const retiredRuntimeDisposablePluginIds = new Set<string>();
    const nowMs = params.nowMs ?? Date.now;
    const isActivationCurrent = params.isActivationCurrent ?? (() => true);

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
        const requiredRegistrationFacts = projectPluginTargetActivationRegistrationFacts(
            derivePluginDaemonContributionRegistrationRights(
                target.manifest.contributes as unknown as Readonly<Record<string, unknown>>,
            ),
        );
        const activationPolicy = buildActivationPolicy(target.manifest);
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
                message: projectPluginFailureText(new Error(
                    `Committed plugin generation admission failed for '${target.pluginId}' (${admissionFailure.immutableGenerationId}): ${admissionFailure.message}`,
                )),
            };
            appendDiagnostic(diagnosticsByPluginId, target.pluginId, diagnostic);
            targetActivationFacts.push(Object.freeze({
                ...targetFactMetadata,
                occurredAtMs: nowMs(),
                status: 'unavailable',
                required: requiredRegistrationFacts,
                bound: Object.freeze([]),
                diagnostics: Object.freeze([diagnostic]),
            }));
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
                required: requiredRegistrationFacts,
                bound: Object.freeze([]),
                diagnostics: Object.freeze([diagnostic]),
            }));
            continue;
        }
        if (!isActivationCurrent()) {
            continue;
        }
        const localDevelopmentSourceRoot = resolveLocalDevelopmentDiagnosticSourceRoot(
            target,
            activationSource,
        );
        let moduleNamespace: PluginDaemonModuleNamespace;
        if (activationSource.kind === 'bundled' && activationSource.prepare) {
            try {
                try {
                    await activationSource.prepare();
                } catch {
                    // A failed aggregate source-dev preflight switches the bundled source
                    // to package-local isolation. The activation owner consumes that one
                    // bounded transition before returning to startup or a lazy caller.
                    // A second failure remains retryable on a later lazy demand below.
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
                    required: requiredRegistrationFacts,
                    bound: Object.freeze([]),
                    diagnostics: Object.freeze([diagnostic]),
                }));
                if (params.retryFailedPreparation === true) {
                    retryableActivationPreparationPluginIds.add(target.pluginId);
                }
                continue;
            }
        }
        if (!isActivationCurrent()) {
            continue;
        }
        try {
            let cacheGenerationId: string;
            if (activationSource.kind === 'bundled') {
                cacheGenerationId = (
                    params.immutableGenerationIdsByPluginId?.get(target.pluginId)
                    ?? `runtime:${params.generation}:${target.pluginId}`
                );
            } else {
                const committedAuthorization = activationSource.committedAuthorization;
                if (!committedAuthorization) {
                    throw new Error(
                        `Plugin '${target.pluginId}' has no committed authorization for daemon activation`,
                    );
                }
                cacheGenerationId = committedAuthorization.immutableGenerationId;
            }
            moduleNamespace = await loadPluginModule({
                source: activationSource,
                // Module graphs are scoped by the direct immutable generation,
                // never a copied manifest/package digest.
                cacheKey: `generation:${cacheGenerationId}`,
            }) as PluginDaemonModuleNamespace;
        } catch (error) {
            if (!isActivationCurrent()) {
                continue;
            }
            const diagnostic = mapDaemonModuleLoadErrorToDiagnostic(
                error,
                localDevelopmentSourceRoot
                    ? { localDevelopmentSourceRoot }
                    : undefined,
            );
            appendDiagnostic(diagnosticsByPluginId, target.pluginId, diagnostic);
            targetActivationFacts.push(Object.freeze({
                ...targetFactMetadata,
                occurredAtMs: Date.now(),
                status: 'unavailable',
                required: requiredRegistrationFacts,
                bound: Object.freeze([]),
                diagnostics: Object.freeze([diagnostic]),
            }));
            continue;
        }
        if (!isActivationCurrent()) {
            continue;
        }

        {
            const activated = await activateContributionModule({
                pluginId: target.pluginId,
                manifestAuthority:
                    target.provenance === 'first_party'
                    && target.source.kind === 'bundled'
                        ? 'bundled_first_party'
                        : 'external',
                generation: String(params.generation),
                manifest: target.manifest,
                moduleNamespace,
                isGenerationCurrent: () => targetGenerationCurrent,
                forceActivation: target.activationEvents?.includes('startup') === true,
                ...(localDevelopmentSourceRoot
                    ? { localDevelopmentSourceRoot }
                    : {}),
                ...(activationSource.resolveRelativeModule
                    ? { resolveRelativeModule: activationSource.resolveRelativeModule }
                    : {}),
                ...(activationSource.persistValidatedAgentSessionRunnerFactories
                    ? {
                        persistValidatedAgentSessionRunnerFactories:
                            activationSource.persistValidatedAgentSessionRunnerFactories,
                    }
                    : {}),
            });
            appendDiagnostics(diagnosticsByPluginId, target.pluginId, activated.diagnostics);
            targetActivationFacts.push(Object.freeze({
                ...targetFactMetadata,
                occurredAtMs: Date.now(),
                status: activated.status,
                required: requiredRegistrationFacts,
                bound: projectPluginTargetActivationRegistrationFacts(activated.registrations),
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
            message: projectPluginFailureText(new Error(
                `Committed plugin generation admission failed for '${pluginId}' (${admissionFailure.immutableGenerationId}): ${admissionFailure.message}`,
            )),
        };
        appendDiagnostic(diagnosticsByPluginId, pluginId, diagnostic);
    }

    const activatedTargetMetadataEntries = [] as Array<Readonly<{
        pluginId: string;
        manifest: ActivationTarget['manifest'];
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
            manifest: target.manifest,
            runtimeCapabilities: policy.runtimeCapabilities,
            systemTools: policy.systemTools,
            declaredEventDeclarations: policy.declaredEventDeclarations,
        }));
    }

    let lifecycleState: 'active' | 'disposing' | 'disposed' = 'active';
    let disposalPromise: Promise<void> | null = null;
    const agentExternalSessionsRetirement = new AbortController();
    const backgroundServiceRegistrations = targetRegistrations.flatMap((entry) => {
        if (entry.registration.family !== 'backgroundServices') return [];
        if (entry.generation !== String(params.generation)) {
            throw new Error(
                `Background service '${entry.pluginId}/backgroundServices/${entry.registration.localId}' was published for the wrong generation`,
            );
        }
        const target = activationTargets.find((candidate) => candidate.pluginId === entry.pluginId);
        const declaration = target?.manifest.contributes.backgroundServices.find((service) => (
            service.id === entry.registration.localId
        ));
        if (!target || !declaration) {
            throw new Error(
                `Background service registration '${entry.pluginId}/backgroundServices/${entry.registration.localId}' has no matching manifest declaration`,
            );
        }
        return [Object.freeze({
            pluginId: entry.pluginId,
            pluginVersion: target.manifest.version,
            generation: entry.generation,
            localId: entry.registration.localId,
            runner: entry.registration.value,
        })];
    });
    if (!params.invocationServices) {
        for (const pluginId of new Set(backgroundServiceRegistrations.map(({ pluginId }) => pluginId))) {
            appendDiagnostic(diagnosticsByPluginId, pluginId, {
                code: 'plugin_activation_failed',
                message: `Plugin '${pluginId}' background services cannot start because the daemon invocation-service owner is unavailable`,
            });
        }
    }
    const terminalBackgroundServicePluginIds = new Set<string>();
    const backgroundServiceRunnerHost = createBackgroundServiceRunnerHost({
        registrations: params.invocationServices ? backgroundServiceRegistrations : Object.freeze([]),
        createContext(input) {
            if (!params.invocationServices) {
                throw new Error('Background service invocation requires the daemon invocation-service owner');
            }
            const lifetime = createPluginInvocationLifetime(input.signal);
            const seed: PluginInvocationServicesSeed = Object.freeze({
                plugin: Object.freeze({ id: input.pluginId, version: input.pluginVersion }),
                contribution: Object.freeze({
                    id: input.localId,
                    qualifiedId: `${input.pluginId}/backgroundServices/${input.localId}`,
                }),
                generation: input.generation,
                ...(params.immutableGenerationIdsByPluginId?.get(input.pluginId) === undefined
                    ? {}
                    : {
                        immutableGenerationId:
                            params.immutableGenerationIdsByPluginId.get(input.pluginId),
                    }),
                correlationId: randomUUID(),
                surface: 'background',
                signal: lifetime.signal,
                redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
                isGenerationCurrent: input.isGenerationCurrent,
            });
            try {
                const target = activationTargets.find((candidate) => candidate.pluginId === input.pluginId);
                const declaration = target?.manifest.contributes.backgroundServices.find((service) => (
                    service.id === input.localId
                ));
                if (!target || !declaration) {
                    throw new Error(
                        `Background service '${seed.contribution.qualifiedId}' has no matching manifest declaration`,
                    );
                }
                const hostAccessRequests = resolveManifestHostAccessRequests({
                    manifest: target.manifest,
                    pluginId: target.pluginId,
                    contribution: {
                        family: 'backgroundServices',
                        localId: declaration.id,
                    },
                });
                const hostAccessPolicy = hostAccessRequests.length === 0
                    ? undefined
                    : params.invocationServices.resolveInvocationHostPolicy?.({
                        pluginId: seed.plugin.id,
                        generation: seed.generation,
                        qualifiedId: seed.contribution.qualifiedId,
                    }, {
                        hostAccessRequests,
                        surface: seed.surface,
                        signal: seed.signal,
                    });
                const unavailableRequired = hostAccessRequests
                    .filter(({ required }) => required)
                    .map(({ request }) => Object.freeze({
                        request,
                        decision: hostAccessPolicy?.hostAccess.find((candidate) => candidate.id === request.id),
                    }))
                    .find(({ decision }) => decision?.status !== 'available');
                if (unavailableRequired || (hostAccessRequests.length > 0 && !hostAccessPolicy)) {
                    lifetime.complete();
                    return Object.freeze({
                        unavailable: Object.freeze({
                            code: unavailableRequired?.decision?.code ?? 'plugin_host_access_service_unavailable',
                            hostAccessId: unavailableRequired?.request.id ?? hostAccessRequests[0]!.request.id,
                            status: unavailableRequired?.decision?.status === 'denied'
                                ? 'denied' as const
                                : 'unavailable' as const,
                        }),
                    });
                }
                const services = params.invocationServices.createServices(
                    seed,
                    hostAccessPolicy?.serviceBinding
                        ?? params.invocationServices.createOrdinaryServiceBinding(
                            seed.generation,
                            `${seed.contribution.qualifiedId}:${seed.correlationId}:binding`,
                            undefined,
                            seed.contribution.qualifiedId,
                        ),
                );
                return Object.freeze({
                    context: Object.freeze({
                        plugin: seed.plugin,
                        contribution: seed.contribution,
                        surface: 'background' as const,
                        invokedAtMs: lifetime.invokedAtMs,
                        signal: seed.signal,
                        services,
                        ui: createPluginInvocationPresentation({
                            currentSession: null,
                            signal: seed.signal,
                            isGenerationCurrent: seed.isGenerationCurrent,
                        }),
                    }),
                    complete: () => lifetime.complete(),
                });
            } catch (error) {
                lifetime.complete();
                throw error;
            }
        },
        onDiagnostic(event) {
            logger.warn('[PLUGIN RUNTIME] Background service lifecycle diagnostic', {
                code: event.code,
                pluginId: event.pluginId,
                generation: event.generation,
                localId: event.localId,
                ...(event.code === 'background_service_failed' && event.error !== undefined
                    ? { error: projectPluginFailureText(event.error) }
                    : {}),
                ...(event.code === 'background_service_unavailable' ? { reason: event.reason } : {}),
            });
        },
        onUnexpectedSettlement(event) {
            // Background services are generation-long required contributions.
            // Once one stops while its generation is current, the existing
            // activation fact is the canonical availability owner: retire the
            // plugin's active projection there and invalidate its readers. A
            // watchdog/restart loop would contradict the background-service
            // lifecycle contract and conceal the provider's stopped observer.
            if (terminalBackgroundServicePluginIds.has(event.pluginId)) return;
            terminalBackgroundServicePluginIds.add(event.pluginId);
            const detail = event.outcome === 'rejected'
                ? projectPluginFailureText(event.error)
                : event.outcome === 'unavailable'
                    ? `${event.reason?.code ?? 'background_service_unavailable'} (${event.reason?.hostAccessId ?? 'unknown'})`
                    : 'runner resolved while its generation remained current';
            recordPluginActivationFailure(
                event.pluginId,
                `Background service '${event.localId}' stopped: ${detail}`,
            );
            params.onTerminalActivationFailure?.(event.pluginId);
        },
    });
    let backgroundServicesStarted = false;
    const targetHookHandlers = createTargetHookHandlerRegistry({
        generation: params.generation,
        activationTargets,
        targetRegistrations,
        isGenerationActive: () => lifecycleState === 'active',
        ...(params.invocationServices ? { invocationServices: params.invocationServices } : {}),
    });
    const targetHookHandlersByHookId = targetHookHandlers.handlersByHookId;
    for (const [pluginId, diagnostics] of Object.entries(targetHookHandlers.diagnosticsByPluginId)) {
        appendDiagnostics(diagnosticsByPluginId, pluginId, diagnostics);
    }
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

    const envAllowedNamesByPluginId = new Map(activatedTargetMetadataEntries.flatMap((entry) => {
        const names = projectRequiredManifestEnvironmentNames(entry.manifest);
        return names.length > 0 ? [[entry.pluginId, new Set(names)] as const] : [];
    }));
    const filesystemReadAllowedPathsByPluginId = new Map(activatedTargetMetadataEntries.flatMap((entry) => {
        const paths = projectRequiredManifestWorkspaceFilesystemReadPaths(entry.manifest);
        return paths.length > 0 ? [[entry.pluginId, new Set(paths)] as const] : [];
    }));
    const hookHandlersByHookId = new Map(targetHookHandlersByHookId);
    const requestInterceptors: TargetRequestInterceptorBinding[] = [...targetRequestInterceptorBindings];
    const systemToolDefinitionsByPluginId = new Map(activatedTargetMetadataEntries.map((entry) => [
        entry.pluginId,
        Object.freeze([...entry.systemTools]),
    ]));
    const runtimeCapabilitiesByPluginId = new Map(activatedTargetMetadataEntries.map((entry) => [
        entry.pluginId,
        new Set(entry.runtimeCapabilities),
    ]));
    const eventDeclarationsByPluginId = new Map(activatedTargetMetadataEntries.map((entry) => [
        entry.pluginId,
        Object.freeze([...entry.declaredEventDeclarations]),
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
    const projectedActivatedRegistries: ActivatedPluginRuntimeRegistry[] = [];
    const componentRegistries = (): readonly ActivatedPluginRuntimeRegistry[] => Object.freeze([
        ...(params.retainedRegistries ?? []),
        ...projectedActivatedRegistries,
    ]);
    const backgroundServiceRegistries = (): readonly ActivatedPluginRuntimeRegistry[] => Object.freeze([
        ...(params.retainedRegistries ?? []),
        ...lazyActivatedRegistries,
    ]);

    // A host-owned failure after the activation loop — readiness preparation or
    // unexpected generation-long background-service settlement — can invalidate
    // a plugin the loop already reported as active. It is represented exactly
    // like an activation-time failure so every reader keeps one meaning of
    // "ready": one `unavailable` fact carrying one typed diagnostic.
    function recordPluginActivationFailure(pluginId: string, message: string): void {
        const target = activationTargets.find((candidate) => candidate.pluginId === pluginId);
        if (!target) {
            throw new Error(`Plugin '${pluginId}' is not an activation target of this runtime registry`);
        }
        const localIndex = targetActivationFacts.findIndex((fact) => fact.pluginId === pluginId);
        if (localIndex < 0) {
            const component = componentRegistries().find((registry) => (
                registry.targetActivationFacts.some((fact) => fact.pluginId === pluginId)
            ));
            if (component) {
                component.recordPluginActivationFailure(pluginId, message);
                mergeDiagnosticsFromRegistry(component, pluginId);
                activatedPluginIds.delete(pluginId);
                failedActivationPluginIds.add(pluginId);
                return;
            }
        }
        const diagnostic: PluginCompatibilityDiagnostic = {
            code: 'plugin_activation_failed',
            message,
        };
        appendDiagnostic(diagnosticsByPluginId, pluginId, diagnostic);
        activatedPluginIds.delete(pluginId);
        failedActivationPluginIds.add(pluginId);
        const existing = localIndex < 0 ? null : targetActivationFacts[localIndex]!;
        // Exactly one fact per plugin, and an inactive target may never keep
        // publishing bound contributions.
        const fact: PluginTargetActivationFact = Object.freeze({
            pluginId,
            pluginVersion: existing?.pluginVersion ?? target.manifest.version,
            source: existing?.source ?? mapPluginSourceToDiagnosticSource(target.sourceSpec),
            generation: existing?.generation ?? String(params.generation),
            host: existing?.host ?? 'daemon',
            platform: existing?.platform ?? process.platform,
            occurredAtMs: nowMs(),
            status: 'unavailable',
            required: existing?.required ?? projectPluginTargetActivationRegistrationFacts(
                derivePluginDaemonContributionRegistrationRights(
                    target.manifest.contributes as unknown as Readonly<Record<string, unknown>>,
                ),
            ),
            bound: Object.freeze([]),
            diagnostics: Object.freeze([...(existing?.diagnostics ?? []), diagnostic]),
        });
        if (localIndex < 0) targetActivationFacts.push(fact);
        else targetActivationFacts[localIndex] = fact;
    }

    const addRuntimeDisposable = (pluginId: string, disposable: PluginDisposable): PluginDisposable => {
        if (lifecycleState !== 'active' || retiredRuntimeDisposablePluginIds.has(pluginId)) {
            throw new Error(
                `Plugin '${pluginId}' runtime disposable registration rejected because its lifecycle is retired`,
            );
        }
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
        projectedActivatedRegistries.push(registry);
        mergeHandlerMaps(registry);
        mergeMapEntries(agentRuntimesByAgentId, registry.agentRuntimesByAgentId);
        mergeMapEntries(scmHostingProvidersById, registry.scmHostingProvidersById);
        mergeMapEntries(scmBackendsById, registry.scmBackendsById);
        scmBackendRegistrations.push(...registry.scmBackendRegistrations);
        requestInterceptors.push(...registry.requestInterceptors);
        mergeMapEntries(systemToolDefinitionsByPluginId, registry.systemToolDefinitionsByPluginId);
        mergeMapEntries(envAllowedNamesByPluginId, registry.envAllowedNamesByPluginId);
        mergeMapEntries(filesystemReadAllowedPathsByPluginId, registry.filesystemReadAllowedPathsByPluginId);
        mergeMapEntries(runtimeCapabilitiesByPluginId, registry.runtimeCapabilitiesByPluginId);
        mergeMapEntries(eventDeclarationsByPluginId, registry.eventDeclarationsByPluginId);
        actions.push(...registry.actions);
        tools.push(...registry.tools);
        commands.push(...registry.commands);
        mergeDiagnosticsFromRegistry(registry, pluginId);
        if (activated) {
            activatedPluginIds.add(pluginId);
            if (backgroundServicesStarted) {
                registry.startAdoptedBackgroundServices();
            }
            if (!params.adoptActivationComponent) {
                lazyActivatedRegistries.push(registry);
            }
        } else {
            failedActivationPluginIds.add(pluginId);
        }
    }

    function mergeRetainedRegistry(registry: ActivatedPluginRuntimeRegistry): void {
        targetRegistrations.push(...registry.targetRegistrations);
        mergeHandlerMaps(registry);
        mergeMapEntries(agentRuntimesByAgentId, registry.agentRuntimesByAgentId);
        mergeMapEntries(scmHostingProvidersById, registry.scmHostingProvidersById);
        mergeMapEntries(scmBackendsById, registry.scmBackendsById);
        scmBackendRegistrations.push(...registry.scmBackendRegistrations);
        requestInterceptors.push(...registry.requestInterceptors);
        mergeMapEntries(systemToolDefinitionsByPluginId, registry.systemToolDefinitionsByPluginId);
        mergeMapEntries(envAllowedNamesByPluginId, registry.envAllowedNamesByPluginId);
        mergeMapEntries(filesystemReadAllowedPathsByPluginId, registry.filesystemReadAllowedPathsByPluginId);
        mergeMapEntries(runtimeCapabilitiesByPluginId, registry.runtimeCapabilitiesByPluginId);
        mergeMapEntries(eventDeclarationsByPluginId, registry.eventDeclarationsByPluginId);
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
                retryFailedPreparation: true,
                nowMs,
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
                        error: projectPluginFailureText(error),
                    });
                });
                return { pluginId, diagnostics };
            }
            if (lifecycleState !== 'active') {
                appendLazyActivationUnavailableDiagnostic(pluginId);
                await registry.dispose({ timeoutMs: 5_000 }).catch((error: unknown) => {
                    logger.warn('[PLUGIN RUNTIME] Failed to dispose late lazy activation after registry disposal', {
                        pluginId,
                        error: projectPluginFailureText(error),
                    });
                });
                return {
                    pluginId,
                    diagnostics: Object.freeze([...(diagnosticsByPluginId[pluginId] ?? [])]),
                };
            }
            await mergeActivatedRegistry(registry, pluginId);
            if (registry.failedActivationPluginIds.has(pluginId)) {
                params.onTerminalActivationFailure?.(pluginId);
            }
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

    const readCurrentTargetActivationFacts = (): readonly PluginTargetActivationFact[] => Object.freeze([
        ...targetActivationFacts,
        ...componentRegistries().flatMap((registry) => registry.targetActivationFacts),
    ]);
    const readCurrentFailedActivationPluginIds = (): ReadonlySet<string> => new Set([
        ...failedActivationPluginIds,
        ...componentRegistries().flatMap((registry) => [...registry.failedActivationPluginIds]),
    ]);
    const readCurrentActivatedPluginIds = (): ReadonlySet<string> => {
        const failed = readCurrentFailedActivationPluginIds();
        return new Set([
            ...activatedPluginIds,
            ...componentRegistries().flatMap((registry) => [...registry.activatedPluginIds]),
        ].filter((pluginId) => !failed.has(pluginId)));
    };

    function startAdoptedBackgroundServices(): void {
        if (backgroundServicesStarted || lifecycleState !== 'active') return;
        backgroundServicesStarted = true;
        backgroundServiceRunnerHost.start();
        for (const registry of backgroundServiceRegistries()) {
            registry.startAdoptedBackgroundServices();
        }
    }

    function retireBackgroundServices(pluginIds: readonly string[]): void {
        for (const pluginId of pluginIds) {
            retiredRuntimeDisposablePluginIds.add(pluginId);
        }
        backgroundServiceRunnerHost.retire(pluginIds);
        for (const registry of backgroundServiceRegistries()) {
            registry.retireBackgroundServices(pluginIds);
        }
    }

    async function settleRetiredBackgroundServices(pluginIds: readonly string[]): Promise<void> {
        for (const pluginId of pluginIds) {
            retiredRuntimeDisposablePluginIds.add(pluginId);
        }
        const runtimeDisposableRetirements = [...new Set(pluginIds)].flatMap((pluginId) => {
            const pending = runtimeDisposableRetirementPromisesByPluginId.get(pluginId);
            if (pending) return [pending];
            const registry = runtimeDisposableRegistriesByPluginId.get(pluginId);
            if (!registry) return [];
            runtimeDisposableRegistriesByPluginId.delete(pluginId);
            const retirement = registry.dispose();
            runtimeDisposableRetirementPromisesByPluginId.set(pluginId, retirement);
            retirement.then(
                () => {
                    if (runtimeDisposableRetirementPromisesByPluginId.get(pluginId) === retirement) {
                        runtimeDisposableRetirementPromisesByPluginId.delete(pluginId);
                    }
                },
                () => {
                    if (runtimeDisposableRetirementPromisesByPluginId.get(pluginId) === retirement) {
                        runtimeDisposableRetirementPromisesByPluginId.delete(pluginId);
                    }
                },
            );
            return [retirement];
        });
        await Promise.all([
            backgroundServiceRunnerHost.settle(pluginIds),
            ...backgroundServiceRegistries().map(async (registry) => {
                await registry.settleRetiredBackgroundServices(pluginIds);
            }),
            ...runtimeDisposableRetirements,
        ]);
    }

    return {
        generation: params.generation,
        targetRegistrations,
        // Component registries retain the lifecycle owner for their required
        // contributions. Read their current facts instead of copying a startup
        // snapshot that would keep advertising a background runner after it
        // terminally settles.
        get targetActivationFacts() {
            return readCurrentTargetActivationFacts();
        },
        agentRuntimesByAgentId,
        scmHostingProvidersById,
        scmBackendsById,
        scmBackendRegistrations,
        requestInterceptors,
        systemToolDefinitionsByPluginId,
        envAllowedNamesByPluginId,
        filesystemReadAllowedPathsByPluginId,
        runtimeCapabilitiesByPluginId,
        eventDeclarationsByPluginId,
        actions,
        tools,
        commands,
        hookHandlersByHookId,
        pluginDiagnosticsByPluginId: diagnosticsByPluginId,
        get activatedPluginIds() {
            return readCurrentActivatedPluginIds();
        },
        get failedActivationPluginIds() {
            return readCurrentFailedActivationPluginIds();
        },
        retryableActivationPreparationPluginIds,
        activateContributionsOnDemand,
        activatePluginsForValidation,
        recordPluginActivationFailure,
        startAdoptedBackgroundServices,
        retireBackgroundServices,
        settleRetiredBackgroundServices,
        addRuntimeDisposable,
        dispose(disposeOptions = {}) {
            if (disposalPromise) return disposalPromise;
            disposalPromise = (async () => {
                lifecycleState = 'disposing';
                agentExternalSessionsRetirement.abort();
                targetGenerationCurrent = false;
                try {
                    await backgroundServiceRunnerHost.dispose();
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
                    for (const [pluginId, retirement] of [...runtimeDisposableRetirementPromisesByPluginId.entries()].reverse()) {
                        await runPluginDisposalStep({
                            pluginId,
                            phase: 'runtime_disposables',
                            options: disposeOptions,
                            operation: async () => await retirement,
                        });
                    }
                    runtimeDisposableRetirementPromisesByPluginId.clear();
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
