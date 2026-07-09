import type {
    PluginPermissionDeclarationV1,
    PluginPermissionCapabilityV1,
    PluginActionContributionV2,
    ParsedPluginEventContributionV1,
    PluginRequestInterceptorContributionV1,
    PluginSourceSpecV1,
    PluginSystemToolContributionV1,
    PluginToolContributionV2,
    PluginCommandContributionV2,
} from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '../../validation/diagnostics/types';
import type {
    ResolvedContributionRegistry,
    ResolvedCommandContribution,
    ResolvedLifecycleHandlerContribution,
    ResolvedActionContribution,
    ResolvedContributionProvenance,
    ResolvedContributionSource,
    ResolvedToolContribution,
} from '../../projection/registry/types';

import { createPluginApiHost } from '../api/host';
import type {
    PluginApiActionRegistration,
    PluginApiAgentRuntimeRegistration,
    PluginApiCommandRegistration,
    PluginApiDaemonAuthBridgeRegistration,
    PluginDisposable,
    PluginApiHookRegistration,
    PluginApiLifecycleHandlerRegistration,
    PluginApiMcpDiscoveryProviderRegistration,
    PluginApiMcpServerRegistration,
    PluginApiNotificationCategoryRegistration,
    PluginApiNotificationChannelRegistration,
    PluginApiRequestInterceptorRegistration,
    PluginApiScmBackendRegistration,
    PluginApiScmHostingProviderRegistration,
    PluginApiToolRegistration,
} from '../api/types';
import { createActivatedHandlerRegistry, type ActivatedHandlerRegistry } from '../handlers/registry';
import type { PluginActivationSource } from '../activationSources';
import { loadPluginModule } from '../loadPluginModule';
import {
    loadTrustedOptionalPermissionDeclarations,
    type ResolveTrustedOptionalPluginPermissionGrants,
} from '../permissions/grants';
import { createPluginDisposableRegistry } from './disposables';
import { logger } from '@/ui/logger';
import type {
    PluginDaemonModuleNamespace,
    PluginHookHandler,
    PluginLifecycleHandlerRequest,
    ResolvedPluginLifecycleHandler,
} from '../types';
import type { PluginContextV1, PluginHandlerServicesV1 } from '@happier-dev/plugin-sdk';
import { createHostPluginContextV1 } from '../../../agent/runtime/registry/engineRegistry/pluginContext';

import {
    appendDiagnostic,
    appendDiagnostics,
    normalizePositiveTimeoutMs,
    runWithOptionalTimeout,
    mapDaemonModuleLoadErrorToDiagnostic,
} from './utils';
import {
    type ActivationTarget,
    collectActivationTargets,
    shouldActivateTargetAtStartup,
    activationTargetMatchesEvent,
} from './activation/targets';
import { resolveActivationExport, resolveActivationSource, resolveAutoAcpPluginRoot } from './activation/source';
import { readBundledActivationPolicy, resolveActivationPolicy, type ActivationPolicy } from './activation/policy';
import { autoRegisterAcpBackend } from './activation/autoAcp';
import {
    toResolvedActionContribution,
    toResolvedToolContribution,
    toSyntheticActionContributionFromTool,
    toResolvedCommandContribution,
    toSyntheticActionContributionFromCommand,
    toResolvedLifecycleHandlerContribution,
} from './contributions/resolve';
import {
    normalizeNetworkPermissionOrigin,
    normalizeProcessSpawnPermissionPath,
    normalizeEnvPermissionName,
    normalizeFilesystemPermissionPath,
    collectOptionalScopedPermissionMap,
    collectScopedPermissionMap,
} from './permissions/scopeNormalizers';

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
type PluginRuntimeDisposalPhase = 'deactivating' | 'runtime_disposables' | 'registered_disposables' | 'deactivated';
type PluginRuntimeDisposalOptions = Readonly<{
    timeoutMs?: number;
    onError?: (event: Readonly<{
        pluginId: string;
        phase: PluginRuntimeDisposalPhase;
        error: unknown;
    }>) => void;
}>;

export type ActivatedPluginRuntimeRegistry = ActivatedHandlerRegistry & Readonly<{
    generation: number;
    agentRuntimesByAgentId: ReadonlyMap<string, Readonly<{
        pluginId: string;
        registration: PluginApiAgentRuntimeRegistration;
    }>>;
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
        registration: PluginApiScmHostingProviderRegistration;
    }>>;
    scmBackendsById: ReadonlyMap<string, Readonly<{
        pluginId: string;
        registration: PluginApiScmBackendRegistration;
    }>>;
    scmBackendRegistrations: readonly Readonly<{
        pluginId: string;
        registration: PluginApiScmBackendRegistration;
    }>[];
    requestInterceptors: readonly Readonly<{
        pluginId: string;
        contribution: PluginRequestInterceptorContributionV1;
        registration: PluginApiRequestInterceptorRegistration;
    }>[];
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
    optionalPermissionDeclarationsByPluginId: ReadonlyMap<string, readonly PluginPermissionDeclarationV1[]>;
    trustedOptionalPermissionsByPluginId: ReadonlyMap<string, ReadonlySet<PluginPermissionCapabilityV1>>;
    trustedOptionalPermissionDeclarationsByPluginId: ReadonlyMap<string, readonly PluginPermissionDeclarationV1[]>;
    runtimeCapabilitiesByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    eventDeclarationsByPluginId: ReadonlyMap<string, readonly ParsedPluginEventContributionV1[]>;
    eventSubscriptionPermissionsByPluginId: ReadonlyMap<string, ReadonlySet<PluginPermissionCapabilityV1>>;
    runtimeCoreHandlersByBackendId: ReadonlyMap<string, ReadonlyMap<string, PluginHookHandler>>;
    actions: readonly ResolvedActionContribution[];
    tools: readonly ResolvedToolContribution[];
    commands: readonly ResolvedCommandContribution[];
    lifecycleHandlers: readonly ResolvedLifecycleHandlerContribution[];
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    activatedPluginIds: ReadonlySet<string>;
    activatePluginsByEvent: (activationEvent: string) => Promise<readonly PluginActivationDemandResult[]>;
    addRuntimeDisposable: (pluginId: string, disposable: PluginDisposable) => PluginDisposable;
    dispose: (params?: PluginRuntimeDisposalOptions) => Promise<void>;
}>;

const DEFAULT_PLUGIN_ACTIVATION_TIMEOUT_MS = 30_000;

async function runPluginDisposalStep(params: Readonly<{
    pluginId: string;
    phase: PluginRuntimeDisposalPhase;
    options: PluginRuntimeDisposalOptions;
    operation: () => Promise<void>;
}>): Promise<boolean> {
    const timeoutMs = normalizePositiveTimeoutMs(params.options.timeoutMs);
    try {
        await runWithOptionalTimeout(
            timeoutMs,
            params.operation,
            () => new Error(`Plugin '${params.pluginId}' ${params.phase} timed out after ${timeoutMs}ms`),
        );
        return true;
    } catch (error) {
        params.options.onError?.({
            pluginId: params.pluginId,
            phase: params.phase,
            error,
        });
        logger.warn('[PLUGIN RUNTIME] Plugin cleanup step failed during disposal', {
            pluginId: params.pluginId,
            phase: params.phase,
            error: error instanceof Error ? error.message : String(error),
        });
        return false;
    }
}

async function dispatchLifecycleHandlers(params: Readonly<{
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>;
    event: PluginLifecycleHandlerRequest['event'];
    generation: number;
    handlers: readonly ResolvedPluginLifecycleHandler[];
}>): Promise<void> {
    for (const handler of params.handlers) {
        try {
            await handler.handler({
                event: params.event,
                pluginId: handler.pluginId,
                generation: params.generation,
                provenance: {
                    manifestPath: handler.manifestPath,
                    manifestDigest: handler.manifestDigest,
                    sourceKind: handler.sourceKind ?? 'path',
                },
            });
        } catch (error) {
            appendDiagnostic(params.diagnosticsByPluginId, handler.pluginId, {
                code: 'plugin_activation_failed',
                message: error instanceof Error
                    ? error.message
                    : `Plugin lifecycle handler '${handler.registrationId}' failed`,
            });
        }
    }
}

function readPluginHandlerServices(ctx: PluginContextV1): PluginHandlerServicesV1 {
    return Object.freeze({
        storage: ctx.storage,
        settings: ctx.settings,
        logger: ctx.logger,
        events: ctx.events,
    });
}

export async function activatePluginRuntimeRegistry(params: Readonly<{
    contributes: ResolvedContributionRegistry;
    generation: number;
    happyHomeDir?: string;
    pluginIds?: readonly string[];
    resolveActivationSource?: (target: ActivationTarget) => PluginActivationSource<PluginDaemonModuleNamespace> | null;
    resolveTrustedOptionalPermissionGrants?: ResolveTrustedOptionalPluginPermissionGrants;
}>): Promise<ActivatedPluginRuntimeRegistry> {
    const diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]> = {};
    const allowedPluginIds = params.pluginIds ? new Set(params.pluginIds) : null;
    const activationTargets = collectActivationTargets(params.contributes);
    const activationPolicyCache = new Map<string, ActivationPolicy>();
    const activatedEntries: Array<{
        pluginId: string;
        provenance: ResolvedContributionProvenance;
        source: ResolvedContributionSource;
        manifestPath: string;
        manifestDigest: string;
        daemonEntryPath: string;
        sourceSpec?: PluginSourceSpecV1;
        agentRuntimes: readonly PluginApiAgentRuntimeRegistration[];
        daemonAuthBridges: readonly PluginApiDaemonAuthBridgeRegistration[];
        actions: readonly PluginApiActionRegistration[];
        tools: readonly PluginApiToolRegistration[];
        commands: readonly PluginApiCommandRegistration[];
        notificationCategories: readonly PluginApiNotificationCategoryRegistration[];
        notificationChannels: readonly PluginApiNotificationChannelRegistration[];
        scmHostingProviders: readonly PluginApiScmHostingProviderRegistration[];
        scmBackends: readonly PluginApiScmBackendRegistration[];
        requestInterceptors: readonly PluginApiRequestInterceptorRegistration[];
        requestInterceptorContributions: readonly PluginRequestInterceptorContributionV1[];
        mcpServers: readonly PluginApiMcpServerRegistration[];
        mcpDiscoveryProviders: readonly PluginApiMcpDiscoveryProviderRegistration[];
        permissions: readonly PluginPermissionCapabilityV1[];
        permissionDeclarations: readonly PluginPermissionDeclarationV1[];
        requiredPermissions: readonly PluginPermissionCapabilityV1[];
        requiredPermissionDeclarations: readonly PluginPermissionDeclarationV1[];
        optionalPermissionDeclarations: readonly PluginPermissionDeclarationV1[];
        trustedOptionalPermissions: readonly PluginPermissionCapabilityV1[];
        trustedOptionalPermissionDeclarations: readonly PluginPermissionDeclarationV1[];
        runtimeCapabilities: readonly string[];
        systemTools: readonly PluginSystemToolContributionV1[];
        declaredEventIds: readonly string[];
        declaredEventDeclarations: readonly ParsedPluginEventContributionV1[];
        declaredActions: readonly PluginActionContributionV2[];
        declaredTools: readonly PluginToolContributionV2[];
        declaredCommands: readonly PluginCommandContributionV2[];
        hooks: readonly PluginApiHookRegistration[];
        lifecycleHandlers: readonly PluginApiLifecycleHandlerRegistration[];
        handlerServices: PluginHandlerServicesV1;
        dispose: () => Promise<void>;
    }> = [];
    const runtimeDisposableRegistriesByPluginId = new Map<string, ReturnType<typeof createPluginDisposableRegistry>>();

    for (const target of activationTargets) {
        if (allowedPluginIds && !allowedPluginIds.has(target.pluginId)) {
            continue;
        }
        if (!allowedPluginIds && !shouldActivateTargetAtStartup(target)) {
            continue;
        }
        diagnosticsByPluginId[target.pluginId] = diagnosticsByPluginId[target.pluginId] ?? [];

        const activationSource = resolveActivationSource(target, params.resolveActivationSource);
        const activationPolicy = activationSource.kind === 'bundled'
            ? null
            : await resolveActivationPolicy(target, activationPolicyCache);
        if (activationPolicy && !activationPolicy.ok) {
            appendDiagnostics(diagnosticsByPluginId, target.pluginId, activationPolicy.diagnostics);
            continue;
        }

        let moduleNamespace: PluginDaemonModuleNamespace;
        try {
            moduleNamespace = await loadPluginModule({
                source: activationSource,
                cacheKey: `${target.manifestDigest}:generation:${params.generation}`,
            }) as PluginDaemonModuleNamespace;
        } catch (error) {
            appendDiagnostic(diagnosticsByPluginId, target.pluginId, mapDaemonModuleLoadErrorToDiagnostic(error));
            continue;
        }

        const activationExport = resolveActivationExport(moduleNamespace);
        if (activationExport.status === 'missing') {
            continue;
        }
        if (activationExport.status === 'invalid') {
            appendDiagnostic(diagnosticsByPluginId, target.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin '${target.pluginId}' activation export is not a function`,
            });
            continue;
        }

        const bundledPolicy = activationSource.kind === 'bundled'
            ? readBundledActivationPolicy({
                target,
                moduleNamespace,
                diagnosticsByPluginId,
            })
            : null;
        if (activationSource.kind === 'bundled' && !bundledPolicy) {
            continue;
        }

        const requiredPermissionDeclarations = activationSource.kind === 'bundled'
            ? bundledPolicy!.permissionDeclarations
            : activationPolicy!.policy.permissionDeclarations;
        const requiredPermissions = Object.freeze(
            requiredPermissionDeclarations.map((permission) => permission.capability),
        );
        const optionalPermissionDeclarations = activationSource.kind === 'bundled'
            ? bundledPolicy!.optionalPermissionDeclarations
            : activationPolicy!.policy.optionalPermissionDeclarations;
        const trustedOptionalPermissionDeclarations = await loadTrustedOptionalPermissionDeclarations({
            pluginId: target.pluginId,
            manifestPath: target.manifestPath,
            manifestDigest: target.manifestDigest,
            requiredPermissions: requiredPermissionDeclarations,
            optionalPermissions: optionalPermissionDeclarations,
            provenance: target.provenance,
            ...(target.sourceSpec ? { sourceSpec: target.sourceSpec } : {}),
            resolveTrustedOptionalPermissionGrants: params.resolveTrustedOptionalPermissionGrants,
        });
        const trustedOptionalPermissions = Object.freeze(
            trustedOptionalPermissionDeclarations.map((permission) => permission.capability),
        );
        const activePermissionDeclarations = Object.freeze([
            ...requiredPermissionDeclarations,
            ...trustedOptionalPermissionDeclarations,
        ]);
        const activePermissions = Object.freeze(
            Array.from(new Set(activePermissionDeclarations.map((permission) => permission.capability))),
        );
        const declaredEventIds = activationSource.kind === 'bundled'
            ? bundledPolicy!.declaredEventIds
            : activationPolicy!.policy.declaredEventIds;
        const declaredEventDeclarations = activationSource.kind === 'bundled'
            ? bundledPolicy!.declaredEventDeclarations
            : activationPolicy!.policy.declaredEventDeclarations;

        const host = createPluginApiHost({
            pluginId: target.pluginId,
            runtimeCapabilities: activationSource.kind === 'bundled'
                ? bundledPolicy!.runtimeCapabilities
                : activationPolicy!.policy.runtimeCapabilities,
            permissions: activePermissions,
            declaredAgentIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredAgentIds
                : activationPolicy!.policy.declaredAgentIds,
            declaredActionIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredActionIds
                : activationPolicy!.policy.declaredActionIds,
            declaredActions: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredActions
                : activationPolicy!.policy.declaredActions,
            declaredToolIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredToolIds
                : activationPolicy!.policy.declaredToolIds,
            declaredCommandIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredCommandIds
                : activationPolicy!.policy.declaredCommandIds,
            declaredHookIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredHookIds
                : activationPolicy!.policy.declaredHookIds,
            declaredLifecycleHandlerIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredLifecycleHandlerIds
                : activationPolicy!.policy.declaredLifecycleHandlerIds,
            declaredLifecycleHandlers: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredLifecycleHandlers
                : activationPolicy!.policy.declaredLifecycleHandlers,
            declaredNotificationCategoryIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredNotificationCategoryIds
                : activationPolicy!.policy.declaredNotificationCategoryIds,
            declaredNotificationChannelIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredNotificationChannelIds
                : activationPolicy!.policy.declaredNotificationChannelIds,
            declaredScmHostingProviderIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredScmHostingProviderIds
                : activationPolicy!.policy.declaredScmHostingProviderIds,
            declaredScmBackendIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredScmBackendIds
                : activationPolicy!.policy.declaredScmBackendIds,
            declaredRequestInterceptorIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredRequestInterceptorIds
                : activationPolicy!.policy.declaredRequestInterceptorIds,
            declaredMcpServerIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredMcpServerIds
                : activationPolicy!.policy.declaredMcpServerIds,
            declaredMcpDiscoveryProviderIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredMcpDiscoveryProviderIds
                : activationPolicy!.policy.declaredMcpDiscoveryProviderIds,
        });
        try {
            const disposable = await runWithOptionalTimeout(
                DEFAULT_PLUGIN_ACTIVATION_TIMEOUT_MS,
                async () => await activationExport.activate(host.api),
                () => new Error(
                    `Plugin '${target.pluginId}' activation timed out after ${DEFAULT_PLUGIN_ACTIVATION_TIMEOUT_MS}ms`,
                ),
            );
            if (disposable) {
                host.addDisposable(disposable);
            }
            const autoAcpPluginRoot = resolveAutoAcpPluginRoot(target, activationSource);
            if (autoAcpPluginRoot) {
                await autoRegisterAcpBackend(autoAcpPluginRoot, host.api);
            }
        } catch (error) {
            appendDiagnostics(diagnosticsByPluginId, target.pluginId, host.registrations().diagnostics);
            await host.dispose();
            appendDiagnostic(diagnosticsByPluginId, target.pluginId, {
                code: 'plugin_activation_failed',
                message: error instanceof Error ? error.message : `Failed to activate plugin '${target.pluginId}'`,
            });
            continue;
        }

        const registrations = host.registrations();
        const pluginContext = createHostPluginContextV1({
            happyHomeDir: params.happyHomeDir,
            backendId: target.pluginId,
            contributes: params.contributes,
        });
        const handlerServices = readPluginHandlerServices(pluginContext);
        appendDiagnostics(diagnosticsByPluginId, target.pluginId, registrations.diagnostics);
        activatedEntries.push({
            pluginId: target.pluginId,
            provenance: target.provenance,
            source: target.source,
            manifestPath: target.manifestPath,
            manifestDigest: target.manifestDigest,
            daemonEntryPath: target.daemonEntryPath,
            sourceSpec: target.sourceSpec,
            agentRuntimes: registrations.agentRuntimes,
            daemonAuthBridges: registrations.daemonAuthBridges,
            actions: registrations.actions,
            tools: registrations.tools,
            commands: registrations.commands,
            notificationCategories: registrations.notificationCategories,
            notificationChannels: registrations.notificationChannels,
            scmHostingProviders: registrations.scmHostingProviders,
            scmBackends: registrations.scmBackends,
            requestInterceptors: registrations.requestInterceptors,
            requestInterceptorContributions: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredRequestInterceptors
                : activationPolicy!.policy.declaredRequestInterceptors,
            mcpServers: registrations.mcpServers,
            mcpDiscoveryProviders: registrations.mcpDiscoveryProviders,
            permissions: activePermissions,
            permissionDeclarations: activePermissionDeclarations,
            requiredPermissions,
            requiredPermissionDeclarations,
            optionalPermissionDeclarations,
            trustedOptionalPermissions,
            trustedOptionalPermissionDeclarations,
            runtimeCapabilities: activationSource.kind === 'bundled'
                ? bundledPolicy!.runtimeCapabilities
                : activationPolicy!.policy.runtimeCapabilities,
            systemTools: activationSource.kind === 'bundled'
                ? bundledPolicy!.systemTools
                : activationPolicy!.policy.systemTools,
            declaredEventIds,
            declaredEventDeclarations,
            declaredActions: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredActions
                : activationPolicy!.policy.declaredActions,
            declaredTools: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredTools
                : activationPolicy!.policy.declaredTools,
            declaredCommands: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredCommands
                : activationPolicy!.policy.declaredCommands,
            hooks: registrations.hooks,
            lifecycleHandlers: registrations.lifecycleHandlers,
            handlerServices,
            dispose: host.dispose,
        });
    }

    let lifecycleState: 'active' | 'disposing' | 'disposed' = 'active';
    const handlerRegistry = createActivatedHandlerRegistry({
        entries: activatedEntries,
        lifetime: {
            isHandlerActive: () => lifecycleState === 'active',
            isLifecycleHandlerActive: () => lifecycleState !== 'disposed',
        },
    });
    await dispatchLifecycleHandlers({
        diagnosticsByPluginId,
        event: 'activated',
        generation: params.generation,
        handlers: handlerRegistry.lifecycleHandlersByEvent.get('activated') ?? [],
    });
    const agentRuntimesByAgentId = new Map<string, Readonly<{
        pluginId: string;
        registration: PluginApiAgentRuntimeRegistration;
    }>>();
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
        registration: PluginApiScmHostingProviderRegistration;
    }>>();
    const scmBackendsById = new Map<string, Readonly<{
        pluginId: string;
        registration: PluginApiScmBackendRegistration;
    }>>();
    const scmBackendRegistrations: Readonly<{
        pluginId: string;
        registration: PluginApiScmBackendRegistration;
    }>[] = [];
    for (const entry of activatedEntries) {
        for (const registration of entry.agentRuntimes) {
            const existing = agentRuntimesByAgentId.get(registration.agentId) ?? null;
            if (existing) {
                appendDiagnostic(diagnosticsByPluginId, entry.pluginId, {
                    code: 'plugin_agent_runtime_duplicate_agent_id',
                    message: `Plugin '${entry.pluginId}' registered an agent runtime for '${registration.agentId}', but it is already registered by plugin '${existing.pluginId}'`,
                });
                appendDiagnostic(diagnosticsByPluginId, existing.pluginId, {
                    code: 'plugin_agent_runtime_duplicate_agent_id',
                    message: `Plugin '${existing.pluginId}' registered an agent runtime for '${registration.agentId}', but it is also registered by plugin '${entry.pluginId}'`,
                });
                continue;
            }

            agentRuntimesByAgentId.set(registration.agentId, Object.freeze({ pluginId: entry.pluginId, registration }));
        }
        for (const registration of entry.daemonAuthBridges) {
            const existing = daemonAuthBridgesByServiceId.get(registration.serviceId) ?? null;
            if (existing) {
                appendDiagnostic(diagnosticsByPluginId, entry.pluginId, {
                    code: 'plugin_daemon_auth_bridge_duplicate_service_id',
                    message: `Plugin '${entry.pluginId}' registered daemon auth bridge for service '${registration.serviceId}', but it is already registered by plugin '${existing.pluginId}'`,
                });
                appendDiagnostic(diagnosticsByPluginId, existing.pluginId, {
                    code: 'plugin_daemon_auth_bridge_duplicate_service_id',
                    message: `Plugin '${existing.pluginId}' registered daemon auth bridge for service '${registration.serviceId}', but it is also registered by plugin '${entry.pluginId}'`,
                });
                continue;
            }

            daemonAuthBridgesByServiceId.set(registration.serviceId, Object.freeze({ pluginId: entry.pluginId, registration }));
        }
        for (const registration of entry.notificationCategories) {
            const existing = notificationCategoriesById.get(registration.id) ?? null;
            if (existing) {
                appendDiagnostic(diagnosticsByPluginId, entry.pluginId, {
                    code: 'plugin_notification_category_duplicate_id',
                    message: `Plugin '${entry.pluginId}' registered notification category '${registration.id}', but it is already registered by plugin '${existing.pluginId}'`,
                });
                appendDiagnostic(diagnosticsByPluginId, existing.pluginId, {
                    code: 'plugin_notification_category_duplicate_id',
                    message: `Plugin '${existing.pluginId}' registered notification category '${registration.id}', but it is also registered by plugin '${entry.pluginId}'`,
                });
                continue;
            }

            notificationCategoriesById.set(registration.id, Object.freeze({ pluginId: entry.pluginId, registration }));
        }
        for (const registration of entry.notificationChannels) {
            const existing = notificationChannelsById.get(registration.id) ?? null;
            if (existing) {
                appendDiagnostic(diagnosticsByPluginId, entry.pluginId, {
                    code: 'plugin_notification_channel_duplicate_id',
                    message: `Plugin '${entry.pluginId}' registered notification channel '${registration.id}', but it is already registered by plugin '${existing.pluginId}'`,
                });
                appendDiagnostic(diagnosticsByPluginId, existing.pluginId, {
                    code: 'plugin_notification_channel_duplicate_id',
                    message: `Plugin '${existing.pluginId}' registered notification channel '${registration.id}', but it is also registered by plugin '${entry.pluginId}'`,
                });
                continue;
            }

            notificationChannelsById.set(registration.id, Object.freeze({ pluginId: entry.pluginId, registration }));
        }
        for (const registration of entry.scmHostingProviders) {
            const existing = scmHostingProvidersById.get(registration.id) ?? null;
            if (existing) {
                appendDiagnostic(diagnosticsByPluginId, entry.pluginId, {
                    code: 'plugin_scm_hosting_provider_duplicate_id',
                    message: `Plugin '${entry.pluginId}' registered SCM hosting provider '${registration.id}', but it is already registered by plugin '${existing.pluginId}'`,
                });
                appendDiagnostic(diagnosticsByPluginId, existing.pluginId, {
                    code: 'plugin_scm_hosting_provider_duplicate_id',
                    message: `Plugin '${existing.pluginId}' registered SCM hosting provider '${registration.id}', but it is also registered by plugin '${entry.pluginId}'`,
                });
                continue;
            }

            scmHostingProvidersById.set(registration.id, Object.freeze({ pluginId: entry.pluginId, registration }));
        }
        for (const registration of entry.scmBackends) {
            const ownerScopedRegistration = Object.freeze({ pluginId: entry.pluginId, registration });
            scmBackendRegistrations.push(ownerScopedRegistration);
            const existing = scmBackendsById.get(registration.id) ?? null;
            if (existing) {
                appendDiagnostic(diagnosticsByPluginId, entry.pluginId, {
                    code: 'plugin_scm_backend_duplicate_id',
                    message: `Plugin '${entry.pluginId}' registered SCM backend '${registration.id}', but it is already registered by plugin '${existing.pluginId}'`,
                });
                appendDiagnostic(diagnosticsByPluginId, existing.pluginId, {
                    code: 'plugin_scm_backend_duplicate_id',
                    message: `Plugin '${existing.pluginId}' registered SCM backend '${registration.id}', but it is also registered by plugin '${entry.pluginId}'`,
                });
                continue;
            }

            scmBackendsById.set(registration.id, ownerScopedRegistration);
        }
    }
    const networkAllowedUrlOriginsByPluginId = new Map(collectScopedPermissionMap(
        activatedEntries,
        'network',
        normalizeNetworkPermissionOrigin,
    ));
    const processSpawnAllowedPathsByPluginId = new Map(collectScopedPermissionMap(
        activatedEntries,
        'process.spawn',
        normalizeProcessSpawnPermissionPath,
    ));
    const envAllowedNamesByPluginId = new Map(collectScopedPermissionMap(
        activatedEntries,
        'env',
        normalizeEnvPermissionName,
    ));
    const filesystemReadAllowedPathsByPluginId = new Map(collectOptionalScopedPermissionMap(
        activatedEntries,
        'filesystem.read',
        normalizeFilesystemPermissionPath,
    ));
    const filesystemWriteAllowedPathsByPluginId = new Map(collectOptionalScopedPermissionMap(
        activatedEntries,
        'filesystem.write',
        normalizeFilesystemPermissionPath,
    ));
    const actionHandlersByActionId = new Map(handlerRegistry.actionHandlersByActionId);
    const hookHandlersByHookId = new Map(handlerRegistry.hookHandlersByHookId);
    const lifecycleHandlersByEvent = new Map(handlerRegistry.lifecycleHandlersByEvent);
    const requestInterceptors = activatedEntries.flatMap((entry) => {
        const contributionsById = new Map(entry.requestInterceptorContributions.map((contribution) => [contribution.id, contribution]));
        return entry.requestInterceptors.flatMap((registration) => {
            const contribution = contributionsById.get(registration.id);
            if (!contribution) {
                return [];
            }
            return [Object.freeze({
                pluginId: entry.pluginId,
                contribution,
                registration,
            })];
        });
    });
    const mcpServers = activatedEntries.flatMap((entry) => entry.mcpServers.map((registration) => Object.freeze({
        pluginId: entry.pluginId,
        registration,
    })));
    const mcpDiscoveryProviders = activatedEntries.flatMap((entry) => entry.mcpDiscoveryProviders.map((registration) => Object.freeze({
        pluginId: entry.pluginId,
        registration,
    })));
    const networkAllowedPluginIds = new Set(activatedEntries.flatMap((entry) => (
        entry.permissions.includes('network') ? [entry.pluginId] : []
    )));
    const systemToolDefinitionsByPluginId = new Map(activatedEntries.map((entry) => [
        entry.pluginId,
        Object.freeze([...entry.systemTools]),
    ]));
    const permissionsByPluginId = new Map(activatedEntries.map((entry) => [
        entry.pluginId,
        new Set(entry.permissions),
    ]));
    const permissionDeclarationsByPluginId = new Map(activatedEntries.map((entry) => [
        entry.pluginId,
        Object.freeze([...entry.permissionDeclarations]),
    ]));
    const requiredPermissionsByPluginId = new Map(activatedEntries.map((entry) => [
        entry.pluginId,
        new Set(entry.requiredPermissions),
    ]));
    const requiredPermissionDeclarationsByPluginId = new Map(activatedEntries.map((entry) => [
        entry.pluginId,
        Object.freeze([...entry.requiredPermissionDeclarations]),
    ]));
    const optionalPermissionDeclarationsByPluginId = new Map(activatedEntries.map((entry) => [
        entry.pluginId,
        Object.freeze([...entry.optionalPermissionDeclarations]),
    ]));
    const trustedOptionalPermissionsByPluginId = new Map(activatedEntries.map((entry) => [
        entry.pluginId,
        new Set(entry.trustedOptionalPermissions),
    ]));
    const trustedOptionalPermissionDeclarationsByPluginId = new Map(activatedEntries.map((entry) => [
        entry.pluginId,
        Object.freeze([...entry.trustedOptionalPermissionDeclarations]),
    ]));
    const runtimeCapabilitiesByPluginId = new Map(activatedEntries.map((entry) => [
        entry.pluginId,
        new Set(entry.runtimeCapabilities),
    ]));
    const eventDeclarationsByPluginId = new Map(activatedEntries.map((entry) => [
        entry.pluginId,
        Object.freeze([...entry.declaredEventDeclarations]),
    ]));
    const eventSubscriptionPermissionsByPluginId = new Map(activatedEntries.map((entry) => [
        entry.pluginId,
        new Set(entry.permissions),
    ]));
    const actions = activatedEntries.flatMap((entry) => {
        const declaredActionsById = new Map(entry.declaredActions.map((definition) => [definition.id, definition]));
        const declaredToolsById = new Map(entry.declaredTools.map((definition) => [definition.id, definition]));
        const declaredCommandsById = new Map(entry.declaredCommands.map((definition) => [definition.id, definition]));
        return [
            ...entry.actions.flatMap((registration) => {
                const declaration = declaredActionsById.get(registration.id);
                return declaration ? [toResolvedActionContribution(entry, declaration)] : [];
            }),
            ...entry.tools.flatMap((registration) => {
                const declaration = declaredToolsById.get(registration.id);
                return declaration ? [toSyntheticActionContributionFromTool(entry, declaration)] : [];
            }),
            ...entry.commands.flatMap((registration) => {
                const declaration = declaredCommandsById.get(registration.id);
                return declaration ? [toSyntheticActionContributionFromCommand(entry, declaration)] : [];
            }),
        ];
    });
    const tools = activatedEntries.flatMap((entry) => {
        const declaredToolsById = new Map(entry.declaredTools.map((definition) => [definition.id, definition]));
        return entry.tools.flatMap((registration) => {
            const declaration = declaredToolsById.get(registration.id);
            return declaration ? [toResolvedToolContribution(entry, declaration)] : [];
        });
    });
    const commands = activatedEntries.flatMap((entry) => {
        const declaredCommandsById = new Map(entry.declaredCommands.map((definition) => [definition.id, definition]));
        return entry.commands.flatMap((registration) => {
            const declaration = declaredCommandsById.get(registration.id);
            return declaration ? [toResolvedCommandContribution(entry, declaration)] : [];
        });
    });
    const lifecycleHandlers = activatedEntries.flatMap((entry) => entry.lifecycleHandlers.map(
        (definition) => toResolvedLifecycleHandlerContribution(entry, definition),
    ));
    const activatedPluginIds = new Set(activatedEntries.map((entry) => entry.pluginId));
    const failedLazyActivationPluginIds = new Set<string>();
    const lazyActivationPromisesByPluginId = new Map<string, Promise<PluginActivationDemandResult>>();
    const lazyActivatedRegistries: ActivatedPluginRuntimeRegistry[] = [];

    const addRuntimeDisposable = (pluginId: string, disposable: PluginDisposable): PluginDisposable => {
        const registry = runtimeDisposableRegistriesByPluginId.get(pluginId) ?? createPluginDisposableRegistry();
        runtimeDisposableRegistriesByPluginId.set(pluginId, registry);
        return registry.add(disposable);
    };

    function mergeHandlerMaps(registry: ActivatedHandlerRegistry): void {
        for (const [actionId, handler] of registry.actionHandlersByActionId.entries()) {
            actionHandlersByActionId.set(actionId, handler);
        }
        for (const [hookId, handlers] of registry.hookHandlersByHookId.entries()) {
            const existing = hookHandlersByHookId.get(hookId) ?? [];
            hookHandlersByHookId.set(
                hookId,
                Object.freeze([...existing, ...handlers].sort((left, right) => (
                    left.priority - right.priority
                    || left.pluginId.localeCompare(right.pluginId)
                    || left.registrationIndex - right.registrationIndex
                    || left.manifestPath.localeCompare(right.manifestPath)
                    || left.exportName.localeCompare(right.exportName)
                    || left.daemonEntryPath.localeCompare(right.daemonEntryPath)
                ))),
            );
        }
        for (const [event, handlers] of registry.lifecycleHandlersByEvent.entries()) {
            const existing = lifecycleHandlersByEvent.get(event) ?? [];
            lifecycleHandlersByEvent.set(
                event,
                Object.freeze([...existing, ...handlers].sort((left, right) => (
                    right.priority - left.priority
                    || left.pluginId.localeCompare(right.pluginId)
                    || left.registrationId.localeCompare(right.registrationId)
                    || left.manifestPath.localeCompare(right.manifestPath)
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
        failedLazyActivationPluginIds.add(pluginId);
    }

    async function mergeActivatedRegistry(registry: ActivatedPluginRuntimeRegistry, pluginId: string): Promise<void> {
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
        mergeMapEntries(optionalPermissionDeclarationsByPluginId, registry.optionalPermissionDeclarationsByPluginId);
        mergeMapEntries(trustedOptionalPermissionsByPluginId, registry.trustedOptionalPermissionsByPluginId);
        mergeMapEntries(trustedOptionalPermissionDeclarationsByPluginId, registry.trustedOptionalPermissionDeclarationsByPluginId);
        mergeMapEntries(runtimeCapabilitiesByPluginId, registry.runtimeCapabilitiesByPluginId);
        mergeMapEntries(eventDeclarationsByPluginId, registry.eventDeclarationsByPluginId);
        mergeMapEntries(eventSubscriptionPermissionsByPluginId, registry.eventSubscriptionPermissionsByPluginId);
        actions.push(...registry.actions);
        tools.push(...registry.tools);
        commands.push(...registry.commands);
        lifecycleHandlers.push(...registry.lifecycleHandlers);
        mergeDiagnosticsFromRegistry(registry, pluginId);
        if (registry.activatedPluginIds.has(pluginId)) {
            activatedPluginIds.add(pluginId);
            lazyActivatedRegistries.push(registry);
        } else {
            failedLazyActivationPluginIds.add(pluginId);
        }
    }

    async function activatePluginIdForDemand(pluginId: string): Promise<PluginActivationDemandResult> {
        if (lifecycleState !== 'active') {
            appendLazyActivationUnavailableDiagnostic(pluginId);
            return {
                pluginId,
                diagnostics: Object.freeze([...(diagnosticsByPluginId[pluginId] ?? [])]),
            };
        }
        if (activatedPluginIds.has(pluginId) || failedLazyActivationPluginIds.has(pluginId)) {
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
                resolveActivationSource: params.resolveActivationSource,
                resolveTrustedOptionalPermissionGrants: params.resolveTrustedOptionalPermissionGrants,
            });
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

    async function activatePluginsByEvent(activationEvent: string): Promise<readonly PluginActivationDemandResult[]> {
        const pluginIds = [...new Set(
            activationTargets
                .filter((target) => activationTargetMatchesEvent(target, activationEvent))
                .map((target) => target.pluginId),
        )].sort();
        return Object.freeze(await Promise.all(pluginIds.map((pluginId) => activatePluginIdForDemand(pluginId))));
    }

    return {
        generation: params.generation,
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
        optionalPermissionDeclarationsByPluginId,
        trustedOptionalPermissionsByPluginId,
        trustedOptionalPermissionDeclarationsByPluginId,
        runtimeCapabilitiesByPluginId,
        eventDeclarationsByPluginId,
        eventSubscriptionPermissionsByPluginId,
        runtimeCoreHandlersByBackendId: new Map(),
        actions,
        tools,
        commands,
        lifecycleHandlers,
        actionHandlersByActionId,
        hookHandlersByHookId,
        lifecycleHandlersByEvent,
        pluginDiagnosticsByPluginId: diagnosticsByPluginId,
        activatedPluginIds,
        activatePluginsByEvent,
        addRuntimeDisposable,
        async dispose(disposeOptions = {}) {
            if (lifecycleState !== 'active') {
                return;
            }
            lifecycleState = 'disposing';
            for (const registry of [...lazyActivatedRegistries].reverse()) {
                await registry.dispose(disposeOptions);
            }
            for (const entry of [...activatedEntries].reverse()) {
                const deactivatingOk = await runPluginDisposalStep({
                    pluginId: entry.pluginId,
                    phase: 'deactivating',
                    options: disposeOptions,
                    operation: async () => {
                        await dispatchLifecycleHandlers({
                            diagnosticsByPluginId,
                            event: 'deactivating',
                            generation: params.generation,
                            handlers: (handlerRegistry.lifecycleHandlersByEvent.get('deactivating') ?? [])
                                .filter((handler) => handler.pluginId === entry.pluginId),
                        });
                    },
                });
                const runtimeDisposableRegistry = runtimeDisposableRegistriesByPluginId.get(entry.pluginId);
                const runtimeDisposablesOk = runtimeDisposableRegistry
                    ? await runPluginDisposalStep({
                        pluginId: entry.pluginId,
                        phase: 'runtime_disposables',
                        options: disposeOptions,
                        operation: async () => {
                            await runtimeDisposableRegistry.dispose();
                        },
                    })
                    : true;
                const registeredDisposablesOk = await runPluginDisposalStep({
                    pluginId: entry.pluginId,
                    phase: 'registered_disposables',
                    options: disposeOptions,
                    operation: entry.dispose,
                });
                if (!deactivatingOk || !runtimeDisposablesOk || !registeredDisposablesOk) {
                    continue;
                }
                await runPluginDisposalStep({
                    pluginId: entry.pluginId,
                    phase: 'deactivated',
                    options: disposeOptions,
                    operation: async () => {
                        await dispatchLifecycleHandlers({
                            diagnosticsByPluginId,
                            event: 'deactivated',
                            generation: params.generation,
                            handlers: (handlerRegistry.lifecycleHandlersByEvent.get('deactivated') ?? [])
                                .filter((handler) => handler.pluginId === entry.pluginId),
                        });
                    },
                });
            }
            lifecycleState = 'disposed';
        },
    };
}
