import type { ManagedExecutableRef } from '@happier-dev/protocol';
import type { ResolvedPluginExecutable } from '../invocation/services/exec';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { PluginCompatibilityDiagnostic } from '../../validation/diagnostics/types';
import { createResolvedContributionRegistry } from '../../projection/registry/createResolvedContributionRegistry';
import { projectManifestAgentAcpCatalogPreflight } from '../../projection/registry/projectManifestAgentContribution';
import { projectAgentAccountSettingsCatalogEntry, projectAgentCliAuthCatalogEntry, projectAgentCliSessionCommandCatalogEntry, projectAgentConnectedAccountLaunchCatalogEntry, projectAgentDaemonSpawnHooksCatalogEntry, projectAgentExperimentalVendorResumeSupportCatalogEntry, projectAgentPreflightSessionControlsCatalogEntry, projectAgentProviderCliAttachCatalogEntry, projectAgentSessionStartupCatalogEntry, projectAgentTerminalPromptSubmitVerificationCatalogEntry } from '../../projection/registry/agentCatalogEntryHooks';
import type { ResolvedContributionRegistry } from '../../projection/registry/types';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { activatePluginRuntimeRegistry } from '../lifecycle/manager';
import type { ManagedServiceSessionBaseUrlResolver, ManagedServiceSessionClientAccessResolver } from '../invocation/services/managedServiceEndpointProjection';
import { projectTargetProviderRuntimes } from '../lifecycle/contributions/targetProviders';
import type { AgentCliSessionCommandPluginSettingsV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginServices } from '@happier-dev/plugin-sdk';

export function mergePluginDiagnostics(
    left: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
    right: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
): Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>> {
    const merged: Record<string, readonly PluginCompatibilityDiagnostic[]> = {};
    const pluginIds = new Set([
        ...Object.keys(left),
        ...Object.keys(right),
    ]);

    for (const pluginId of pluginIds) {
        merged[pluginId] = Object.freeze([
            ...(left[pluginId] ?? []),
            ...(right[pluginId] ?? []),
        ]);
    }

    return merged;
}

export function projectActivatedAgentContributions(
    base: ResolvedContributionRegistry,
    activated: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>,
    isPluginRuntimeCurrent: (pluginId: string) => boolean,
    resolveManagedServiceSessionBaseUrl?: ManagedServiceSessionBaseUrlResolver,
    resolveManagedServiceSessionClientAccess?: ManagedServiceSessionClientAccessResolver,
    resolveAgentPluginSettings?: (input: Readonly<{
        pluginId: string;
        localAgentId: string;
        includeDefaults?: boolean;
        signal?: AbortSignal;
    }>) => Promise<AgentCliSessionCommandPluginSettingsV1 | null>,
    bindAgentPreflightManagedServices?: (input: Readonly<{
        pluginId: string; localAgentId: string; occurrenceId: string;
        exec: ExecService; signal: AbortSignal; isCurrent(): boolean;
    }>) => PluginServices['managedServices'],
    resolveAgentPreflightManagedExecutable?: (input: Readonly<{
        pluginId: string; executable: Extract<ManagedExecutableRef, { kind: 'managedDependency' }>;
        isCurrent(): boolean;
    }>) => Promise<ResolvedPluginExecutable>,
    resolveAgentPreflightLifecycle?: (pluginId: string) => Readonly<{ retirementSignal: AbortSignal; isCurrent(): boolean }>,
    selectedAgentId?: string,
    agentIsolation?: import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext,
): Readonly<{ agents: ResolvedContributionRegistry["agents"]; registeredAgentRuntimeCatalogHooksProjected: boolean }> {
    const systemToolsByPluginId = new Map<
        string,
        Array<NonNullable<typeof base.systemTools>[number]['definition']>
    >();
    for (const systemTool of base.systemTools ?? []) {
        if (!systemTool.pluginId) continue;
        const existing = systemToolsByPluginId.get(systemTool.pluginId) ?? [];
        systemToolsByPluginId.set(systemTool.pluginId, [...existing, systemTool.definition]);
    }
    let registeredAgentRuntimeCatalogHooksProjected = false;
    const selectedAgents = selectedAgentId === undefined
        ? base.agents
        : base.agents.filter((agent) => agent.id === selectedAgentId);
    const agents = selectedAgents.map((baseAgent) => {
        let agent = baseAgent;
        const pluginId = agent.identity?.pluginId ?? agent.pluginId;
        const nativePreflight = agent.richDefinition && pluginId
            ? projectManifestAgentAcpCatalogPreflight(agent.richDefinition.definition, pluginId) : null;
        if (nativePreflight && pluginId && agent.catalogEntry && resolveAgentPreflightLifecycle
            && activated.readPluginOccurrenceId(pluginId) !== null && isPluginRuntimeCurrent(pluginId)) {
            const lifecycle = resolveAgentPreflightLifecycle(pluginId);
            const preflight = projectAgentPreflightSessionControlsCatalogEntry({
                ...(agentIsolation ? { agentIsolation } : {}),
                agentId: agent.id, preflightSessionControls: nativePreflight.contribution,
                ...(nativePreflight.modelConfigOptionId ? { modelConfigOptionId: nativePreflight.modelConfigOptionId } : {}),
                runtimeSpec: agent.runtimeSpec, systemTools: systemToolsByPluginId.get(pluginId) ?? [],
                agentCliSystemTool: agent.catalogEntry.agentCliSystemTool,
                retirementSignal: lifecycle.retirementSignal, isCurrent: lifecycle.isCurrent,
                ...(nativePreflight.environment ? { nativeEnvironment: nativePreflight.environment } : {}),
                ...(resolveAgentPluginSettings ? { resolvePluginSettings: (options) => resolveAgentPluginSettings({
                    pluginId, localAgentId: agent.identity?.localId ?? agent.id, includeDefaults: false, signal: options?.signal,
                }) } : {}),
                managedExecutableRefs: [...(agent.hostAccess?.required ?? []), ...(agent.hostAccess?.optional ?? [])]
                    .flatMap((request) => request.capability === 'process' ? request.scope.executables ?? [] : [])
                    .filter((ref): ref is Extract<ManagedExecutableRef, { kind: 'managedDependency' }> => ref.kind === 'managedDependency'),
                ...(resolveAgentPreflightManagedExecutable ? { resolveReadyManagedExecutable: (executable) => resolveAgentPreflightManagedExecutable({
                    pluginId, executable, isCurrent: lifecycle.isCurrent,
                }) } : {}),
            });
            registeredAgentRuntimeCatalogHooksProjected = true;
            agent = Object.freeze({ ...agent, catalogEntry: Object.freeze({ ...agent.catalogEntry, ...preflight }) });
        }
        const runtime = activated.agentRuntimesByAgentId.get(agent.id);
        const agentPluginId = agent.identity?.pluginId ?? agent.pluginId;
        if (
            (!runtime?.daemonSpawnHooks
                && !runtime?.providerCliAttach
                && !runtime?.cliSessionCommand
                && !runtime?.cliAuth
                && !runtime?.connectedAccountLaunch
                && !runtime?.preflightSessionControls
                && !runtime?.terminalPromptSubmitVerification
                && !runtime?.sessionStartup
                && !runtime?.vendorResumeSupport)
            || !agent.catalogEntry
            || agentPluginId !== runtime.pluginId
            || !runtime.isCurrent()
            || !isPluginRuntimeCurrent(runtime.pluginId)
            || !activated.activatedPluginIds.has(runtime.pluginId)
        ) {
            return agent;
        }
        if (runtime.daemonSpawnHooks && agent.catalogEntry.getDaemonSpawnHooks) {
            throw new Error(
                `Agent '${agent.id}' has competing declarative and activation-registered daemon spawn hook owners`,
            );
        }
        if (runtime.providerCliAttach && agent.catalogEntry.resolveHostAgentRuntimeSurfaces) {
            throw new Error(
                `Agent '${agent.id}' has competing declarative and activation-registered provider CLI attach owners`,
            );
        }
        if (runtime.sessionStartup && agent.catalogEntry.shouldUseDeferredSessionStartup) {
            throw new Error(
                `Agent '${agent.id}' has competing declarative and activation-registered deferred startup owners`,
            );
        }
        if (runtime.vendorResumeSupport && agent.catalogEntry.getVendorResumeSupport) {
            throw new Error(
                `Agent '${agent.id}' has competing declarative and activation-registered vendor resume owners`,
            );
        }
        if (
            runtime.connectedAccountLaunch
            && (
                agent.catalogEntry.connectedAccountRequestAuthUses
                || agent.catalogEntry.connectedAccountFileEnvironmentUses
                || agent.catalogEntry.connectedAccountEnvironmentUses
                || agent.catalogEntry.connectedAccountSwitchContinuity
                || agent.catalogEntry.getConnectedServiceStateSharingDescriptor
                || agent.catalogEntry.getConnectedServiceRuntimeAuthAdapter
                || agent.catalogEntry.verifyResumeReachable
            )
        ) {
            throw new Error(
                `Agent '${agent.id}' has competing private and activation-registered connected-account launch owners`,
            );
        }
        const switchContinuity = runtime.connectedAccountLaunch?.switchContinuity;
        if (switchContinuity) {
            const declaredServiceIds = agent.catalogEntry.connectedAccountServiceIds ?? [];
            if (declaredServiceIds.length === 0) {
                throw new Error(
                    `Agent '${agent.id}' registers connected-account switch continuity without a manifest-owned Connected Account service`,
                );
            }
            const undeclaredStateSharingServiceId =
                switchContinuity.providerStateSharingRequired?.serviceIds?.find(
                    (serviceId) => !declaredServiceIds.includes(
                        buildQualifiedPluginContributionKey({
                            pluginId: agentPluginId,
                            localId: serviceId,
                        }),
                    ),
                );
            if (undeclaredStateSharingServiceId) {
                throw new Error(
                    `Agent '${agent.id}' connected-account switch continuity requires undeclared service '${undeclaredStateSharingServiceId}'`,
                );
            }
        }
        if (runtime.preflightSessionControls && agent.catalogEntry.getPreflightSessionControlsProbeAdapter) {
            throw new Error(
                `Agent '${agent.id}' has competing declarative and activation-registered preflight probe owners`,
            );
        }
        if (
            runtime.terminalPromptSubmitVerification
            && agent.catalogEntry.getTerminalPromptSubmitVerificationPolicy
        ) {
            throw new Error(
                `Agent '${agent.id}' has competing private and activation-registered terminal prompt owners`,
            );
        }
        registeredAgentRuntimeCatalogHooksProjected = true;
        return Object.freeze({
            ...agent,
            catalogEntry: Object.freeze({
                ...agent.catalogEntry,
                ...(runtime.daemonSpawnHooks
                    ? projectAgentDaemonSpawnHooksCatalogEntry(runtime.daemonSpawnHooks)
                    : {}),
                ...(runtime.providerCliAttach
                    ? projectAgentProviderCliAttachCatalogEntry({
                        agentId: agent.id,
                        pluginId: runtime.pluginId,
                        localAgentId: runtime.localAgentId,
                        providerCliAttach: runtime.providerCliAttach,
                        runtimeSpec: agent.runtimeSpec,
                        systemTools: systemToolsByPluginId.get(runtime.pluginId) ?? [],
                        agentCliSystemTool: agent.catalogEntry.agentCliSystemTool,
                        ...(resolveAgentPluginSettings
                            ? {
                                resolvePluginSettings: () => resolveAgentPluginSettings({
                                    pluginId: runtime.pluginId,
                                    localAgentId: runtime.localAgentId,
                                }),
                            }
                            : {}),
                        ...(resolveManagedServiceSessionBaseUrl
                            ? { resolveManagedServiceSessionBaseUrl }
                            : {}),
                        ...(resolveManagedServiceSessionClientAccess
                            ? { resolveManagedServiceSessionClientAccess }
                            : {}),
                    })
                    : {}),
                ...(runtime.cliSessionCommand
                    ? projectAgentCliSessionCommandCatalogEntry({
                        agentId: agent.id,
                        cliSessionCommand: runtime.cliSessionCommand,
                        isCurrent: runtime.isCurrent,
                        ...(resolveAgentPluginSettings
                            ? {
                                resolvePluginSettings: () => resolveAgentPluginSettings({
                                    pluginId: runtime.pluginId,
                                    localAgentId: runtime.localAgentId,
                                }),
                            }
                            : {}),
                    })
                    : {}),
                ...(runtime.cliAuth && agent.cliMetadata
                    ? projectAgentCliAuthCatalogEntry({
                        ...(agentIsolation ? { agentIsolation } : {}),
                        agentId: agent.id,
                        pluginId: runtime.pluginId,
                        cliAuth: runtime.cliAuth,
                        cli: agent.cliMetadata,
                        retirementSignal: resolveAgentPreflightLifecycle
                            ? AbortSignal.any([runtime.retirementSignal, resolveAgentPreflightLifecycle(runtime.pluginId).retirementSignal])
                            : runtime.retirementSignal,
                        runtimeSpec: agent.runtimeSpec,
                        systemTools: systemToolsByPluginId.get(runtime.pluginId) ?? [],
                        agentCliSystemTool: agent.catalogEntry.agentCliSystemTool,
                        hostAccess: agent.hostAccess,
                        isCurrent: runtime.isCurrent,
                    })
                    : {}),
                ...(runtime.connectedAccountLaunch
                    ? projectAgentConnectedAccountLaunchCatalogEntry({
                        pluginId: runtime.pluginId,
                        agentId: agent.id,
                        connectedAccountLaunch: runtime.connectedAccountLaunch,
                        hostAccess: agent.hostAccess,
                        isCurrent: runtime.isCurrent,
                    })
                    : {}),
                ...(runtime.accountSettings && resolveAgentPluginSettings
                    ? projectAgentAccountSettingsCatalogEntry({
                        accountSettings: runtime.accountSettings,
                        pluginId: runtime.pluginId,
                        localAgentId: runtime.localAgentId,
                        declarations: (base.settings ?? []).filter(entry => entry.pluginId === runtime.pluginId).map(entry => entry.definition),
                        isCurrent: runtime.isCurrent,
                        resolvePluginSettings: () => resolveAgentPluginSettings({
                            pluginId: runtime.pluginId,
                            localAgentId: runtime.localAgentId,
                        }),
                    })
                    : {}),
                ...(runtime.preflightSessionControls
                    ? projectAgentPreflightSessionControlsCatalogEntry({
                        ...(agentIsolation ? { agentIsolation } : {}),
                        agentId: agent.id,
                        preflightSessionControls: runtime.preflightSessionControls,
                        ...(nativePreflight?.modelConfigOptionId ? { modelConfigOptionId: nativePreflight.modelConfigOptionId } : {}),
                        runtimeSpec: agent.runtimeSpec,
                        systemTools: systemToolsByPluginId.get(runtime.pluginId) ?? [],
                        agentCliSystemTool: agent.catalogEntry.agentCliSystemTool,
                        retirementSignal: resolveAgentPreflightLifecycle
                            ? AbortSignal.any([runtime.retirementSignal, resolveAgentPreflightLifecycle(runtime.pluginId).retirementSignal])
                            : runtime.retirementSignal,
                        ...(resolveAgentPluginSettings ? { resolvePluginSettings: (options) => resolveAgentPluginSettings({
                            pluginId: runtime.pluginId, localAgentId: runtime.localAgentId, includeDefaults: false, signal: options?.signal,
                        }) } : {}),
                        managedExecutableRefs: [...(agent.hostAccess?.required ?? []), ...(agent.hostAccess?.optional ?? [])]
                            .flatMap((request) => request.capability === 'process' ? request.scope.executables ?? [] : [])
                            .filter((ref): ref is Extract<ManagedExecutableRef, { kind: 'managedDependency' }> => ref.kind === 'managedDependency'),
                        ...(resolveAgentPreflightManagedExecutable ? { resolveReadyManagedExecutable: (executable) => resolveAgentPreflightManagedExecutable({
                            pluginId: runtime.pluginId, executable, isCurrent: runtime.isCurrent,
                        }) } : {}),
                        ...(bindAgentPreflightManagedServices ? { bindManagedServices: (input) => bindAgentPreflightManagedServices({
                            ...input, pluginId: runtime.pluginId, localAgentId: runtime.localAgentId,
                            occurrenceId: activated.readPluginOccurrenceId(runtime.pluginId) ?? '',
                            isCurrent: runtime.isCurrent,
                        }) } : {}),
                        isCurrent: runtime.isCurrent,
                    })
                    : {}),
                ...(runtime.terminalPromptSubmitVerification
                    ? projectAgentTerminalPromptSubmitVerificationCatalogEntry({
                        terminalPromptSubmitVerification: runtime.terminalPromptSubmitVerification,
                        isCurrent: runtime.isCurrent,
                    })
                    : {}),
                ...(runtime.sessionStartup
                    ? projectAgentSessionStartupCatalogEntry({
                        sessionStartup: runtime.sessionStartup,
                        isCurrent: runtime.isCurrent,
                    })
                    : {}),
                ...(runtime.vendorResumeSupport
                    ? projectAgentExperimentalVendorResumeSupportCatalogEntry({
                        vendorResumeSupport: runtime.vendorResumeSupport,
                        isCurrent: runtime.isCurrent,
                    })
                    : {}),
            }),
        });
    });
    return { agents, registeredAgentRuntimeCatalogHooksProjected };
}

export function mergeActivatedContributes(
    base: ResolvedContributionRegistry,
    activated: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>,
    immutableGenerationIdsByPluginId: ReadonlyMap<string, string>,
    isPluginRuntimeCurrent: (pluginId: string) => boolean,
    resolveManagedServiceSessionBaseUrl?: ManagedServiceSessionBaseUrlResolver,
    resolveManagedServiceSessionClientAccess?: ManagedServiceSessionClientAccessResolver,
    resolveAgentPluginSettings?: (input: Readonly<{
        pluginId: string;
        localAgentId: string;
        includeDefaults?: boolean;
        signal?: AbortSignal;
    }>) => Promise<AgentCliSessionCommandPluginSettingsV1 | null>,
    bindAgentPreflightManagedServices?: (input: Readonly<{
        pluginId: string; localAgentId: string; occurrenceId: string;
        exec: ExecService; signal: AbortSignal; isCurrent(): boolean;
    }>) => PluginServices['managedServices'],
    resolveAgentPreflightManagedExecutable?: (input: Readonly<{
        pluginId: string; executable: Extract<ManagedExecutableRef, { kind: 'managedDependency' }>;
        isCurrent(): boolean;
    }>) => Promise<ResolvedPluginExecutable>,
    resolveAgentPreflightLifecycle?: (pluginId: string) => Readonly<{ retirementSignal: AbortSignal; isCurrent(): boolean }>,
    agentIsolation?: import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext,
): ResolvedContributionRegistry {
    const activationTargets = base.activationTargets ?? Object.freeze([]);
    // Declarative role and workflow sources share the executable occurrence
    // fence while a predecessor registry is retained during publication.
    const withCurrentDeclarativeSources = (registry: ResolvedContributionRegistry): ResolvedContributionRegistry => {
        const roles = registry.roles ?? [];
        const workflows = registry.workflows ?? [];
        const inputTypes = registry.inputTypes ?? [];
        const dragSources = registry.dragSources ?? [];
        const workItems = registry.workItems ?? [];
        const dropTargets = registry.dropTargets ?? [];
        if (roles.length === 0 && workflows.length === 0 && inputTypes.length === 0
            && dragSources.length === 0 && dropTargets.length === 0 && workItems.length === 0) return registry;
        return Object.freeze({
            ...registry,
            get roles() {
                return Object.freeze(roles.filter((role) => isPluginRuntimeCurrent(role.pluginId)));
            },
            get workflows() {
                return Object.freeze(workflows.filter((workflow) => isPluginRuntimeCurrent(workflow.pluginId)));
            },
            get inputTypes() {
                return Object.freeze(inputTypes.filter((type) => isPluginRuntimeCurrent(type.pluginId)));
            },
            get dragSources() {
                return Object.freeze(dragSources.filter((source) => isPluginRuntimeCurrent(source.pluginId)));
            },
            get workItems() {
                return Object.freeze(workItems.filter((source) => isPluginRuntimeCurrent(source.pluginId)));
            },
            get dropTargets() {
                return Object.freeze(dropTargets.filter((target) => isPluginRuntimeCurrent(target.pluginId)));
            },
        });
    };
    const contributionKey = (contribution: Readonly<{ pluginId?: string; definition: Readonly<{ id: string }> }>): string => (
        contribution.pluginId
            ? buildQualifiedPluginContributionKey(createPluginContributionIdentity({
                pluginId: contribution.pluginId,
                localId: contribution.definition.id,
            }))
            : contribution.definition.id
    );
    const baseActionIds = new Set(base.actions.map(contributionKey));
    const activatedActions = activated.actions.filter((action) => !baseActionIds.has(contributionKey(action)));
    const providerRuntimeRegistrations = activated.targetRegistrations.filter((entry) => (
        entry.registration.family === 'providers'
        && activated.isPluginOccurrenceCurrent(entry.pluginId, entry.occurrenceId)
    ));
    const projectedProviders = projectTargetProviderRuntimes({
        providers: base.providers ?? [],
        activationTargets,
        targetRegistrations: providerRuntimeRegistrations,
        sourceCustodiesByPluginId: new Map(
            [...activated.activatedPluginIds].flatMap((pluginId) => {
                const sourceCustody = activated.readPluginSourceCustody(pluginId);
                return sourceCustody ? [[pluginId, sourceCustody] as const] : [];
            }),
        ),
        isRegistrationCurrent: (entry) => (
            isPluginRuntimeCurrent(entry.pluginId)
            && activated.activatedPluginIds.has(entry.pluginId)
            && activated.readPluginOccurrenceId(entry.pluginId) === entry.occurrenceId
        ),
    });
    const providers = projectedProviders.providers;
    const { agents, registeredAgentRuntimeCatalogHooksProjected } = projectActivatedAgentContributions(
        base, activated, isPluginRuntimeCurrent,
        resolveManagedServiceSessionBaseUrl, resolveManagedServiceSessionClientAccess,
        resolveAgentPluginSettings, bindAgentPreflightManagedServices,
        resolveAgentPreflightManagedExecutable, resolveAgentPreflightLifecycle,
        undefined, agentIsolation,
    );

    if (
        activatedActions.length === 0
        && providerRuntimeRegistrations.length === 0
        && !registeredAgentRuntimeCatalogHooksProjected
    ) {
        return withCurrentDeclarativeSources(base.activationTargets === activationTargets
            ? base
            : Object.freeze({ ...base, activationTargets }));
    }

    return withCurrentDeclarativeSources(createResolvedContributionRegistry({
        ...base,
        activationTargets,
        actions: Object.freeze([
            ...base.actions,
            ...activatedActions,
        ]),
        agents: registeredAgentRuntimeCatalogHooksProjected
            ? Object.freeze(agents)
            : base.agents,
        providers,
        pluginDiagnosticsByPluginId: mergePluginDiagnostics(
            base.pluginDiagnosticsByPluginId,
            projectedProviders.diagnosticsByPluginId,
        ),
    }));
}
