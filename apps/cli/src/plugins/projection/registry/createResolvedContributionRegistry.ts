import type { AgentCatalogEntry, CatalogAgentId } from '@/backends/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import {
    resolveInstallablesRegistry,
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    getPluginHookDefinitionV1,
    qualifyPluginEventIdV1,
    type InstallableRegistryContribution,
} from '@happier-dev/protocol';

import { resolveBuiltInContributions } from './resolveBuiltInContributions';
import type {
    ResolvedBackendContribution,
    ResolvedBackendSurfaceContribution,
    ResolvedActionContribution,
    ResolvedCommandContribution,
    ResolvedConnectedAccountDescriptorContribution,
    ResolvedContributionInputs,
    ResolvedContributionRegistry,
    ResolvedCatalogEntry,
    ResolvedExecutionRunProfileContribution,
    ResolvedEventContribution,
    ResolvedInstallableContribution,
    ResolvedLifecycleHandlerContribution,
    ResolvedMcpDiscoveryProviderContribution,
    ResolvedMcpServerContribution,
    ResolvedNotificationCategoryContribution,
    ResolvedNotificationChannelContribution,
    ResolvedHostedWebContribution,
    ResolvedReactNativeBundleContribution,
    ResolvedRequestInterceptorContribution,
    ResolvedSettingsContribution,
    ResolvedScmBackendContribution,
    ResolvedScmHostingProviderContribution,
    ResolvedProviderContribution,
    ResolvedResourceContribution,
    ResolvedSessionHeaderActionContribution,
    ResolvedSessionSurfaceContribution,
    ResolvedStructuredMessageContribution,
    ResolvedToolContribution,
    ResolvedUiArtifactContribution,
    ResolvedUiDescriptorContribution,
    ResolvedUiTranslationsContribution,
    ResolvedActivationTarget,
} from './types';

export function createResolvedContributionRegistry(inputs: ResolvedContributionInputs): ResolvedContributionRegistry {
    const providerDefinitionsById = new Map<string, ResolvedProviderContribution>();
    const backendDefinitionsById = new Map<string, ResolvedBackendContribution>();
    const standaloneCatalogEntries = Object.freeze([...(inputs.catalogEntries ?? [])]);
    const actions = Object.freeze([...(inputs.actions ?? [])].sort(compareActionContributes));
    const tools = Object.freeze([...(inputs.tools ?? [])].sort(compareToolContributes));
    const commands = Object.freeze([...(inputs.commands ?? [])].sort(compareCommandContributes));
    const resources = Object.freeze([...(inputs.resources ?? [])].sort(compareResourceContributes));
    const uiDescriptors = Object.freeze([...(inputs.uiDescriptors ?? [])].sort(compareUiDescriptorContributes));
    const uiTranslations = Object.freeze([...(inputs.uiTranslations ?? [])].sort(compareUiTranslationsContributes));
    const structuredMessages = Object.freeze([...(inputs.structuredMessages ?? [])].sort(compareStructuredMessageContributes));
    const sessionSurfaces = Object.freeze([...(inputs.sessionSurfaces ?? [])].sort(compareSessionSurfaceContributes));
    const sessionHeaderActions = Object.freeze([...(inputs.sessionHeaderActions ?? [])].sort(compareSessionHeaderActionContributes));
    const hostedWeb = Object.freeze([...(inputs.hostedWeb ?? [])].sort(compareHostedWebContributes));
    const reactNativeBundles = Object.freeze([...(inputs.reactNativeBundles ?? [])].sort(compareReactNativeBundleContributes));
    const uiArtifacts = Object.freeze([...(inputs.uiArtifacts ?? [])].sort(compareUiArtifactContributes));
    const settings = Object.freeze([...(inputs.settings ?? [])].sort(compareSettingsContributes));
    const notifications = Object.freeze([...(inputs.notifications ?? [])].sort(compareNotificationCategoryContributes));
    const notificationChannels = Object.freeze([...(inputs.notificationChannels ?? [])].sort(compareNotificationChannelContributes));
    const events = Object.freeze([...(inputs.events ?? [])].sort(compareEventContributes));
    const executionRunProfiles = Object.freeze([...(inputs.executionRunProfiles ?? [])].sort(compareExecutionRunProfileContributes));
    const mcpServers = Object.freeze([...(inputs.mcpServers ?? [])].sort(compareMcpServerContributes));
    const mcpDiscoveryProviders = Object.freeze([...(inputs.mcpDiscoveryProviders ?? [])].sort(compareMcpDiscoveryProviderContributes));
    const installablesResult = resolveInstallableContributions(
        inputs.installables ?? [],
        inputs.pluginDiagnosticsByPluginId ?? {},
    );
    const installables = installablesResult.installables;
    const scmHostingProvidersResult = resolveScmHostingProviderContributions(
        inputs.scmHostingProviders ?? [],
        installablesResult.pluginDiagnosticsByPluginId,
    );
    const scmHostingProviders = scmHostingProvidersResult.providers;
    const scmBackendsResult = resolveScmBackendContributions(
        inputs.scmBackends ?? [],
        scmHostingProvidersResult.pluginDiagnosticsByPluginId,
    );
    const scmBackends = scmBackendsResult.backends;
    const connectedAccountDescriptors = Object.freeze([...(inputs.connectedAccountDescriptors ?? [])].sort(compareConnectedAccountDescriptorContributes));
    const requestInterceptors = Object.freeze([...(inputs.requestInterceptors ?? [])].sort(compareRequestInterceptorContributes));
    const activationTargets = Object.freeze([...(inputs.activationTargets ?? [])].sort(compareActivationTargets));
    const lifecycleHandlers = Object.freeze([...(inputs.lifecycleHandlers ?? [])].sort(compareLifecycleHandlerContributes));
    const hookRegistrationsResult = resolveHookRegistrations(
        inputs.hookRegistrations ?? [],
        scmBackendsResult.pluginDiagnosticsByPluginId,
    );
    const hookRegistrations = hookRegistrationsResult.hookRegistrations;
    const actionsById = new Map<string, ResolvedActionContribution>();
    const toolsById = new Map<string, ResolvedToolContribution>();
    const commandsById = new Map<string, ResolvedCommandContribution>();
    const resourcesById = new Map<string, ResolvedResourceContribution>();
    const uiDescriptorsById = new Map<string, ResolvedUiDescriptorContribution>();
    const structuredMessagesById = new Map<string, ResolvedStructuredMessageContribution>();
    const sessionSurfacesById = new Map<string, ResolvedSessionSurfaceContribution>();
    const sessionHeaderActionsById = new Map<string, ResolvedSessionHeaderActionContribution>();
    const hostedWebById = new Map<string, ResolvedHostedWebContribution>();
    const reactNativeBundlesById = new Map<string, ResolvedReactNativeBundleContribution>();
    const uiArtifactsById = new Map<string, ResolvedUiArtifactContribution>();
    const settingsById = new Map<string, ResolvedSettingsContribution>();
    const notificationsById = new Map<string, ResolvedNotificationCategoryContribution>();
    const notificationChannelsById = new Map<string, ResolvedNotificationChannelContribution>();
    const eventsById = new Map<string, ResolvedEventContribution>();
    const executionRunProfilesById = new Map<string, ResolvedExecutionRunProfileContribution>();
    const installablesByKey = new Map<string, ResolvedInstallableContribution>();
    const connectedAccountDescriptorsById = new Map<string, ResolvedConnectedAccountDescriptorContribution>();
    const lifecycleHandlersById = new Map<string, ResolvedLifecycleHandlerContribution>();
    // Host dispatch map keyed by backend id. Backend-surface operation names are
    // stable plugin ABI values; the dispatch map itself remains host-local.
    const surfaceHandlersByBackendId = new Map<string, readonly ResolvedBackendSurfaceContribution[]>();
    // Internal merged projection used by CLI host surfaces; not a public plugin ABI.
    const catalogEntriesById: Record<string, ResolvedCatalogEntry> = {};

    for (const catalogEntry of standaloneCatalogEntries) {
        assertCatalogEntryAligned(catalogEntry);
        if (catalogEntriesById[catalogEntry.id]) {
            throw new Error(`Duplicate catalog entry contribution '${catalogEntry.id}'`);
        }
        catalogEntriesById[catalogEntry.id] = catalogEntry;
    }

    for (const provider of inputs.providers) {
        assertProviderContributionAligned(provider);
        if (providerDefinitionsById.has(provider.id)) {
            throw new Error(`Duplicate provider contribution '${provider.id}'`);
        }

        providerDefinitionsById.set(provider.id, provider);

        if (provider.catalogEntry) {
            if (catalogEntriesById[provider.catalogEntry.id]) {
                throw new Error(`Duplicate catalog entry contribution '${provider.catalogEntry.id}'`);
            }
            catalogEntriesById[provider.id] = provider.catalogEntry;
        }
    }

    for (const backend of inputs.backends) {
        assertBackendContributionAligned(backend);
        if (backendDefinitionsById.has(backend.id)) {
            throw new Error(`Duplicate backend contribution '${backend.id}'`);
        }
        if (!providerDefinitionsById.has(backend.providerId) && !isProviderlessReviewExecutionRunBackend(backend)) {
            throw new Error(`Missing provider contribution '${backend.providerId}' for backend '${backend.id}'`);
        }

        backendDefinitionsById.set(backend.id, backend);

        const surfaceHandlers = backend.surfaceHandlers ?? [];
        if (surfaceHandlers.length > 0) {
            surfaceHandlersByBackendId.set(
                backend.id,
                Object.freeze(surfaceHandlers.map((definition) => ({
                    backendId: backend.id,
                    provenance: backend.provenance,
                    source: backend.source,
                    definition,
                    pluginId: backend.pluginId,
                    manifestPath: backend.manifestPath,
                    manifestDigest: backend.manifestDigest,
                    daemonEntryPath: backend.daemonEntryPath,
                }))),
            );
        }
    }

    for (const action of actions) {
        if (actionsById.has(action.definition.id)) {
            throw new Error(`Duplicate action contribution '${action.definition.id}'`);
        }
        actionsById.set(action.definition.id, action);
    }

    for (const tool of tools) {
        if (toolsById.has(tool.definition.id)) {
            throw new Error(`Duplicate tool contribution '${tool.definition.id}'`);
        }
        toolsById.set(tool.definition.id, tool);
    }

    for (const command of commands) {
        if (commandsById.has(command.definition.id)) {
            throw new Error(`Duplicate command contribution '${command.definition.id}'`);
        }
        commandsById.set(command.definition.id, command);
    }

    for (const resource of resources) {
        if (resourcesById.has(resource.definition.id)) {
            throw new Error(`Duplicate resource contribution '${resource.definition.id}'`);
        }
        resourcesById.set(resource.definition.id, resource);
    }

    for (const uiDescriptor of uiDescriptors) {
        if (uiDescriptorsById.has(uiDescriptor.definition.id)) {
            throw new Error(`Duplicate UI descriptor contribution '${uiDescriptor.definition.id}'`);
        }
        uiDescriptorsById.set(uiDescriptor.definition.id, uiDescriptor);
    }

    for (const message of structuredMessages) {
        const id = resolvePluginUiContributionRegistryId(message);
        if (structuredMessagesById.has(id)) {
            throw new Error(`Duplicate structured message contribution '${id}'`);
        }
        structuredMessagesById.set(id, message);
    }

    for (const surface of sessionSurfaces) {
        const id = resolvePluginUiContributionRegistryId(surface);
        if (sessionSurfacesById.has(id)) {
            throw new Error(`Duplicate session surface contribution '${id}'`);
        }
        sessionSurfacesById.set(id, surface);
    }

    for (const action of sessionHeaderActions) {
        const id = resolvePluginUiContributionRegistryId(action);
        if (sessionHeaderActionsById.has(id)) {
            throw new Error(`Duplicate session header action contribution '${id}'`);
        }
        sessionHeaderActionsById.set(id, action);
    }

    for (const contribution of hostedWeb) {
        const id = resolvePluginUiContributionRegistryId(contribution);
        if (hostedWebById.has(id)) {
            throw new Error(`Duplicate hosted web contribution '${id}'`);
        }
        hostedWebById.set(id, contribution);
    }

    for (const contribution of reactNativeBundles) {
        const id = resolvePluginUiContributionRegistryId(contribution);
        if (reactNativeBundlesById.has(id)) {
            throw new Error(`Duplicate React Native bundle contribution '${id}'`);
        }
        reactNativeBundlesById.set(id, contribution);
    }

    for (const artifact of uiArtifacts) {
        const id = resolvePluginUiContributionRegistryId(artifact);
        if (uiArtifactsById.has(id)) {
            throw new Error(`Duplicate UI artifact contribution '${id}'`);
        }
        uiArtifactsById.set(id, artifact);
    }

    for (const setting of settings) {
        if (settingsById.has(setting.definition.id)) {
            throw new Error(`Duplicate settings contribution '${setting.definition.id}'`);
        }
        settingsById.set(setting.definition.id, setting);
    }

    for (const notification of notifications) {
        if (notificationsById.has(notification.definition.id)) {
            throw new Error(`Duplicate notification category contribution '${notification.definition.id}'`);
        }
        notificationsById.set(notification.definition.id, notification);
    }

    for (const channel of notificationChannels) {
        if (notificationChannelsById.has(channel.definition.id)) {
            throw new Error(`Duplicate notification channel contribution '${channel.definition.id}'`);
        }
        notificationChannelsById.set(channel.definition.id, channel);
    }

    for (const event of events) {
        const eventRegistryId = readEventRegistryId(event);
        if (eventsById.has(eventRegistryId)) {
            throw new Error(`Duplicate event contribution '${eventRegistryId}' from plugin '${event.pluginId ?? '<unknown>'}'`);
        }
        eventsById.set(eventRegistryId, event);
    }

    for (const profile of executionRunProfiles) {
        if (executionRunProfilesById.has(profile.definition.id)) {
            throw new Error(`Duplicate execution-run profile contribution '${profile.definition.id}'`);
        }
        executionRunProfilesById.set(profile.definition.id, profile);
    }

    for (const installable of installables) {
        installablesByKey.set(installable.definition.key, installable);
    }
    for (const descriptor of connectedAccountDescriptors) {
        if (connectedAccountDescriptorsById.has(descriptor.definition.id)) {
            throw new Error(`Duplicate connected account descriptor contribution '${descriptor.definition.id}'`);
        }
        connectedAccountDescriptorsById.set(descriptor.definition.id, descriptor);
    }

    for (const lifecycleHandler of lifecycleHandlers) {
        if (lifecycleHandlersById.has(lifecycleHandler.definition.id)) {
            throw new Error(`Duplicate lifecycle handler contribution '${lifecycleHandler.definition.id}'`);
        }
        lifecycleHandlersById.set(lifecycleHandler.definition.id, lifecycleHandler);
    }

    return Object.freeze({
        generationId: buildRegistryGenerationId({
            providers: inputs.providers,
            backends: inputs.backends,
            catalogEntries: standaloneCatalogEntries,
            actions,
            tools,
            commands,
            resources,
            uiDescriptors,
            uiTranslations,
            structuredMessages,
            sessionSurfaces,
            sessionHeaderActions,
            hostedWeb,
            reactNativeBundles,
            uiArtifacts,
            settings,
            notifications,
            notificationChannels,
            events,
            executionRunProfiles,
            mcpServers,
            mcpDiscoveryProviders,
            installables,
            scmHostingProviders,
            scmBackends,
            connectedAccountDescriptors,
            requestInterceptors,
            activationTargets,
            hookRegistrations,
            lifecycleHandlers,
        }),
        providers: inputs.providers,
        backends: inputs.backends,
        actions,
        tools,
        commands,
        resources,
        uiDescriptors,
        uiTranslations,
        structuredMessages,
        sessionSurfaces,
        sessionHeaderActions,
        hostedWeb,
        reactNativeBundles,
        uiArtifacts,
        settings,
        notifications,
        notificationChannels,
        events,
        executionRunProfiles,
        mcpServers,
        mcpDiscoveryProviders,
        installables,
        scmHostingProviders,
        scmBackends,
        connectedAccountDescriptors,
        requestInterceptors,
        activationTargets,
        hookRegistrations,
        lifecycleHandlers,
        actionsById: Object.freeze(actionsById),
        toolsById: Object.freeze(toolsById),
        commandsById: Object.freeze(commandsById),
        resourcesById: Object.freeze(resourcesById),
        uiDescriptorsById: Object.freeze(uiDescriptorsById),
        structuredMessagesById: Object.freeze(structuredMessagesById),
        sessionSurfacesById: Object.freeze(sessionSurfacesById),
        sessionHeaderActionsById: Object.freeze(sessionHeaderActionsById),
        hostedWebById: Object.freeze(hostedWebById),
        reactNativeBundlesById: Object.freeze(reactNativeBundlesById),
        uiArtifactsById: Object.freeze(uiArtifactsById),
        settingsById: Object.freeze(settingsById),
        notificationsById: Object.freeze(notificationsById),
        notificationChannelsById: Object.freeze(notificationChannelsById),
        eventsById: Object.freeze(eventsById),
        executionRunProfilesById: Object.freeze(executionRunProfilesById),
        installablesByKey: Object.freeze(installablesByKey),
        scmHostingProvidersById: scmHostingProvidersResult.providersById,
        scmBackendsById: scmBackendsResult.backendsById,
        connectedAccountDescriptorsById: Object.freeze(connectedAccountDescriptorsById),
        lifecycleHandlersById: Object.freeze(lifecycleHandlersById),
        surfaceHandlersByBackendId: Object.freeze(surfaceHandlersByBackendId),
        catalogEntriesById: Object.freeze(catalogEntriesById),
        providerDefinitionsById,
        backendDefinitionsById,
        pluginDiagnosticsByPluginId: hookRegistrationsResult.pluginDiagnosticsByPluginId,
    });
}

function readEventRegistryId(event: ResolvedEventContribution): string {
    const pluginId = event.pluginId?.trim();
    const localId = event.definition.localId?.trim();
    if (pluginId && localId) {
        return qualifyPluginEventIdV1(pluginId, localId);
    }
    return event.definition.id;
}

function clonePluginDiagnostics(
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
): Record<string, PluginCompatibilityDiagnostic[]> {
    return Object.fromEntries(
        Object.entries(pluginDiagnosticsByPluginId).map(([pluginId, diagnostics]) => [
            pluginId,
            [...diagnostics],
        ]),
    );
}

function appendScmHostingProviderDiagnostic(
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>,
    pluginId: string | undefined,
    diagnostic: PluginCompatibilityDiagnostic,
): void {
    appendPluginDiagnostic(diagnosticsByPluginId, pluginId, diagnostic);
}

function appendPluginDiagnostic(
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>,
    pluginId: string | undefined,
    diagnostic: PluginCompatibilityDiagnostic,
): void {
    const resolvedPluginId = pluginId?.trim() || 'unknown';
    diagnosticsByPluginId[resolvedPluginId] = diagnosticsByPluginId[resolvedPluginId] ?? [];
    diagnosticsByPluginId[resolvedPluginId]!.push(diagnostic);
}

function freezePluginDiagnostics(
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>,
): Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>> {
    return Object.freeze(
        Object.fromEntries(
            Object.entries(diagnosticsByPluginId).map(([pluginId, diagnostics]) => [
                pluginId,
                Object.freeze([...diagnostics]),
            ]),
        ),
    );
}

function toInstallableRegistryContribution(
    candidate: ResolvedInstallableContribution,
): InstallableRegistryContribution {
    const isHostBuiltIn = candidate.provenance === 'first_party'
        && !candidate.manifestPath
        && !candidate.manifestDigest
        && !candidate.daemonEntryPath
        && !candidate.sourceSpec;
    return {
        owner: {
            provenance: isHostBuiltIn
                ? 'built_in'
                : candidate.provenance === 'first_party'
                    ? 'bundled_first_party_plugin'
                    : 'external_plugin',
            ownerId: candidate.pluginId ?? `${candidate.provenance}:${candidate.definition.key}`,
            ...(candidate.pluginId ? { pluginId: candidate.pluginId } : {}),
            ...(candidate.manifestPath ? { manifestPath: candidate.manifestPath } : {}),
            ...(candidate.manifestDigest ? { manifestDigest: candidate.manifestDigest } : {}),
        },
        descriptor: candidate.definition,
    };
}

function resolveHookRegistrations(
    candidates: readonly NonNullable<ResolvedContributionInputs['hookRegistrations']>[number][],
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
): Readonly<{
    hookRegistrations: readonly NonNullable<ResolvedContributionInputs['hookRegistrations']>[number][];
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}> {
    const diagnosticsByPluginId = clonePluginDiagnostics(pluginDiagnosticsByPluginId);
    const hookRegistrations: NonNullable<ResolvedContributionInputs['hookRegistrations']>[number][] = [];

    for (const candidate of candidates) {
        if (!getPluginHookDefinitionV1(candidate.definition.id)) {
            appendPluginDiagnostic(diagnosticsByPluginId, candidate.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin hook '${candidate.definition.id}' is not in the final public hook catalog`,
            });
            continue;
        }
        hookRegistrations.push(candidate);
    }

    return {
        hookRegistrations: Object.freeze(hookRegistrations),
        pluginDiagnosticsByPluginId: freezePluginDiagnostics(diagnosticsByPluginId),
    };
}

function resolveInstallableContributions(
    candidates: readonly ResolvedInstallableContribution[],
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
): Readonly<{
    installables: readonly ResolvedInstallableContribution[];
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}> {
    const diagnosticsByPluginId = clonePluginDiagnostics(pluginDiagnosticsByPluginId);
    const candidateByOwnerAndKey = new Map<string, ResolvedInstallableContribution>();
    const builtIns: InstallableRegistryContribution[] = [];
    const bundledFirstPartyPlugins: InstallableRegistryContribution[] = [];
    const externalPlugins: InstallableRegistryContribution[] = [];

    for (const candidate of candidates) {
        const contribution = toInstallableRegistryContribution(candidate);
        candidateByOwnerAndKey.set(`${contribution.owner.ownerId}:${contribution.descriptor.key}`, candidate);
        if (contribution.owner.provenance === 'built_in') {
            builtIns.push(contribution);
        } else if (contribution.owner.provenance === 'bundled_first_party_plugin') {
            bundledFirstPartyPlugins.push(contribution);
        } else {
            externalPlugins.push(contribution);
        }
    }

    const resolved = resolveInstallablesRegistry({
        builtIns,
        bundledFirstPartyPlugins,
        externalPlugins,
    });
    for (const diagnostic of resolved.diagnostics) {
        const pluginId = diagnostic.disabledPluginId ?? 'unknown';
        diagnosticsByPluginId[pluginId] = diagnosticsByPluginId[pluginId] ?? [];
        diagnosticsByPluginId[pluginId]!.push({
            code: diagnostic.code,
            message: diagnostic.message,
        });
    }

    return {
        installables: Object.freeze(
            resolved.descriptors.flatMap((entry) => {
                const candidate = candidateByOwnerAndKey.get(`${entry.owner.ownerId}:${entry.descriptor.key}`);
                return candidate ? [candidate] : [];
            }),
        ),
        pluginDiagnosticsByPluginId: freezePluginDiagnostics(diagnosticsByPluginId),
    };
}

function compareScmHostingProviderPriority(
    left: ResolvedScmHostingProviderContribution,
    right: ResolvedScmHostingProviderContribution,
): number {
    if (left.id !== right.id) {
        return left.id.localeCompare(right.id);
    }
    if (left.provenance !== right.provenance) {
        return left.provenance === 'first_party' ? -1 : 1;
    }
    const leftSource = left.source.kind;
    const rightSource = right.source.kind;
    if (leftSource !== rightSource) {
        return leftSource === 'bundled' ? -1 : rightSource === 'bundled' ? 1 : leftSource.localeCompare(rightSource);
    }
    return (left.pluginId ?? '').localeCompare(right.pluginId ?? '')
        || (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '');
}

function withScmHostingProviderIdentity(
    candidate: ResolvedScmHostingProviderContribution,
): ResolvedScmHostingProviderContribution {
    if (candidate.identity || !candidate.pluginId) {
        return candidate;
    }
    return Object.freeze({
        ...candidate,
        identity: createPluginContributionIdentity({
            pluginId: candidate.pluginId,
            family: 'scmHostingProviders',
            contributionId: candidate.id,
            provenance: candidate.provenance,
        }),
    });
}

function formatScmHostingProviderContributionKey(candidate: ResolvedScmHostingProviderContribution): string {
    return candidate.identity
        ? buildQualifiedPluginContributionKey(candidate.identity)
        : `${candidate.pluginId ?? 'unknown'}:scmHostingProviders:${candidate.id}`;
}

function resolveScmHostingProviderContributions(
    candidates: readonly ResolvedScmHostingProviderContribution[],
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
): Readonly<{
    providers: readonly ResolvedScmHostingProviderContribution[];
    providersById: ReadonlyMap<string, ResolvedScmHostingProviderContribution>;
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}> {
    const diagnosticsByPluginId = clonePluginDiagnostics(pluginDiagnosticsByPluginId);
    const providersById = new Map<string, ResolvedScmHostingProviderContribution>();
    const activeProviders: ResolvedScmHostingProviderContribution[] = [];

    for (const candidate of candidates.map(withScmHostingProviderIdentity).sort(compareScmHostingProviderPriority)) {
        const existing = providersById.get(candidate.id);
        if (!existing) {
            providersById.set(candidate.id, candidate);
            activeProviders.push(candidate);
            continue;
        }

        const message = `Duplicate ScmHostingProvider id '${candidate.id}' from '${formatScmHostingProviderContributionKey(candidate)}' conflicts with '${formatScmHostingProviderContributionKey(existing)}'`;
        appendScmHostingProviderDiagnostic(diagnosticsByPluginId, candidate.pluginId, {
            code: 'scm_hosting_provider_duplicate',
            message,
        });
    }

    return {
        providers: Object.freeze(activeProviders),
        providersById: Object.freeze(providersById),
        pluginDiagnosticsByPluginId: freezePluginDiagnostics(diagnosticsByPluginId),
    };
}

function compareScmBackendPriority(
    left: ResolvedScmBackendContribution,
    right: ResolvedScmBackendContribution,
): number {
    if (left.id !== right.id) {
        return left.id.localeCompare(right.id);
    }
    if (left.provenance !== right.provenance) {
        return left.provenance === 'first_party' ? -1 : 1;
    }
    const leftSource = left.source.kind;
    const rightSource = right.source.kind;
    if (leftSource !== rightSource) {
        return leftSource === 'bundled' ? -1 : rightSource === 'bundled' ? 1 : leftSource.localeCompare(rightSource);
    }
    return (left.pluginId ?? '').localeCompare(right.pluginId ?? '')
        || (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '');
}

function withScmBackendIdentity(
    candidate: ResolvedScmBackendContribution,
): ResolvedScmBackendContribution {
    if (candidate.identity || !candidate.pluginId) {
        return candidate;
    }
    return Object.freeze({
        ...candidate,
        identity: createPluginContributionIdentity({
            pluginId: candidate.pluginId,
            family: 'scmBackends',
            contributionId: candidate.id,
            provenance: candidate.provenance,
        }),
    });
}

function formatScmBackendContributionKey(candidate: ResolvedScmBackendContribution): string {
    return candidate.identity
        ? buildQualifiedPluginContributionKey(candidate.identity)
        : `${candidate.pluginId ?? 'unknown'}:scmBackends:${candidate.id}`;
}

function resolveScmBackendContributions(
    candidates: readonly ResolvedScmBackendContribution[],
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
): Readonly<{
    backends: readonly ResolvedScmBackendContribution[];
    backendsById: ReadonlyMap<string, ResolvedScmBackendContribution>;
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}> {
    const diagnosticsByPluginId = clonePluginDiagnostics(pluginDiagnosticsByPluginId);
    const backendsById = new Map<string, ResolvedScmBackendContribution>();
    const activeBackends: ResolvedScmBackendContribution[] = [];

    for (const candidate of candidates.map(withScmBackendIdentity).sort(compareScmBackendPriority)) {
        const existing = backendsById.get(candidate.id);
        if (!existing) {
            backendsById.set(candidate.id, candidate);
            activeBackends.push(candidate);
            continue;
        }

        const message = `Duplicate ScmBackend id '${candidate.id}' from '${formatScmBackendContributionKey(candidate)}' conflicts with '${formatScmBackendContributionKey(existing)}'`;
        appendScmHostingProviderDiagnostic(diagnosticsByPluginId, candidate.pluginId, {
            code: 'scm_backend_duplicate',
            message,
        });
    }

    return {
        backends: Object.freeze(activeBackends),
        backendsById: Object.freeze(backendsById),
        pluginDiagnosticsByPluginId: freezePluginDiagnostics(diagnosticsByPluginId),
    };
}

let cachedResolvedContributionRegistry: ResolvedContributionRegistry | null = null;

export function getResolvedContributionRegistry(): ResolvedContributionRegistry {
    if (cachedResolvedContributionRegistry) {
        return cachedResolvedContributionRegistry;
    }
    cachedResolvedContributionRegistry = createResolvedContributionRegistry(resolveBuiltInContributions());
    return cachedResolvedContributionRegistry;
}

export async function resolveMergedContributionRegistry(
    params?: Readonly<{ happyHomeDir?: string }>,
): Promise<ResolvedContributionRegistry> {
    const builtIn = resolveBuiltInContributions();
    const { resolvePluginContributes } = await import('./resolvePluginContributions');
    const plugin = await resolvePluginContributes({
        happyHomeDir: params?.happyHomeDir,
        existingProviderIds: new Set(builtIn.providers.map((provider) => provider.id)),
        existingBackendIds: new Set(builtIn.backends.map((backend) => backend.id)),
    });

    return createResolvedContributionRegistry({
        providers: Object.freeze([...builtIn.providers, ...plugin.providers]),
        backends: Object.freeze([...builtIn.backends, ...plugin.backends]),
        catalogEntries: Object.freeze([...(builtIn.catalogEntries ?? []), ...(plugin.catalogEntries ?? [])]),
        actions: Object.freeze([...(builtIn.actions ?? []), ...(plugin.actions ?? [])]),
        tools: Object.freeze([...(builtIn.tools ?? []), ...(plugin.tools ?? [])]),
        commands: Object.freeze([...(builtIn.commands ?? []), ...(plugin.commands ?? [])]),
        resources: Object.freeze([...(builtIn.resources ?? []), ...(plugin.resources ?? [])]),
        uiDescriptors: Object.freeze([...(builtIn.uiDescriptors ?? []), ...(plugin.uiDescriptors ?? [])]),
        uiTranslations: Object.freeze([...(builtIn.uiTranslations ?? []), ...(plugin.uiTranslations ?? [])]),
        structuredMessages: Object.freeze([...(builtIn.structuredMessages ?? []), ...(plugin.structuredMessages ?? [])]),
        sessionSurfaces: Object.freeze([...(builtIn.sessionSurfaces ?? []), ...(plugin.sessionSurfaces ?? [])]),
        sessionHeaderActions: Object.freeze([...(builtIn.sessionHeaderActions ?? []), ...(plugin.sessionHeaderActions ?? [])]),
        hostedWeb: Object.freeze([...(builtIn.hostedWeb ?? []), ...(plugin.hostedWeb ?? [])]),
        reactNativeBundles: Object.freeze([...(builtIn.reactNativeBundles ?? []), ...(plugin.reactNativeBundles ?? [])]),
        uiArtifacts: Object.freeze([...(builtIn.uiArtifacts ?? []), ...(plugin.uiArtifacts ?? [])]),
        notifications: Object.freeze([...(builtIn.notifications ?? []), ...(plugin.notifications ?? [])]),
        notificationChannels: Object.freeze([...(builtIn.notificationChannels ?? []), ...(plugin.notificationChannels ?? [])]),
        events: Object.freeze([...(builtIn.events ?? []), ...(plugin.events ?? [])]),
        executionRunProfiles: Object.freeze([...(builtIn.executionRunProfiles ?? []), ...(plugin.executionRunProfiles ?? [])]),
        installables: Object.freeze([...(builtIn.installables ?? []), ...(plugin.installables ?? [])]),
        requestInterceptors: Object.freeze([...(builtIn.requestInterceptors ?? []), ...(plugin.requestInterceptors ?? [])]),
        scmHostingProviders: Object.freeze([...(builtIn.scmHostingProviders ?? []), ...(plugin.scmHostingProviders ?? [])]),
        scmBackends: Object.freeze([...(builtIn.scmBackends ?? []), ...(plugin.scmBackends ?? [])]),
        connectedAccountDescriptors: Object.freeze([...(builtIn.connectedAccountDescriptors ?? []), ...(plugin.connectedAccountDescriptors ?? [])]),
        activationTargets: Object.freeze([...(builtIn.activationTargets ?? []), ...(plugin.activationTargets ?? [])]),
        hookRegistrations: Object.freeze([...(builtIn.hookRegistrations ?? []), ...(plugin.hookRegistrations ?? [])]),
        lifecycleHandlers: Object.freeze([...(builtIn.lifecycleHandlers ?? []), ...(plugin.lifecycleHandlers ?? [])]),
        pluginDiagnosticsByPluginId: Object.freeze({
            ...(builtIn.pluginDiagnosticsByPluginId ?? {}),
            ...(plugin.pluginDiagnosticsByPluginId ?? {}),
        }),
    });
}

export async function primeResolvedContributionRegistry(
    params?: Readonly<{ happyHomeDir?: string }>,
): Promise<ResolvedContributionRegistry> {
    const merged = await resolveMergedContributionRegistry(params);
    cachedResolvedContributionRegistry = merged;
    return merged;
}

function assertProviderContributionAligned(provider: ResolvedProviderContribution): void {
    if (provider.definition.kindVersion !== 1) {
        throw new Error(`Provider definition version mismatch for contribution '${provider.id}'`);
    }
    if (provider.definition.id !== provider.id) {
        throw new Error(`Provider definition id mismatch for contribution '${provider.id}'`);
    }
    if (provider.catalogEntry && provider.catalogEntry.id !== provider.id) {
        throw new Error(`Catalog entry id mismatch for provider contribution '${provider.id}'`);
    }
    if (provider.catalogEntry && provider.catalogEntry.cliSubcommand !== provider.id) {
        throw new Error(`Catalog entry cliSubcommand mismatch for provider contribution '${provider.id}'`);
    }
}

function assertCatalogEntryAligned(catalogEntry: ResolvedCatalogEntry): void {
    if (catalogEntry.id !== catalogEntry.cliSubcommand) {
        throw new Error(`Catalog entry id/cliSubcommand mismatch for catalog entry contribution '${catalogEntry.id}'`);
    }
}

function assertBackendContributionAligned(backend: ResolvedBackendContribution): void {
    if (backend.definition.kindVersion !== 1) {
        throw new Error(`Backend definition version mismatch for contribution '${backend.id}'`);
    }
    if (backend.definition.id !== backend.id) {
        throw new Error(`Backend definition id mismatch for contribution '${backend.id}'`);
    }
    if (backend.definition.providerId !== backend.providerId) {
        throw new Error(`Backend provider id mismatch for contribution '${backend.id}'`);
    }
}

function isProviderlessReviewExecutionRunBackend(backend: ResolvedBackendContribution): boolean {
    const session = backend.capabilities?.session;
    const executionRun = backend.capabilities?.executionRun;
    return Boolean(session)
        && typeof session === 'object'
        && !Array.isArray(session)
        && session.supported === false
        && Boolean(executionRun)
        && typeof executionRun === 'object'
        && !Array.isArray(executionRun)
        && executionRun.supported !== false
        && Boolean(executionRun.review)
        && typeof executionRun.review === 'object'
        && !Array.isArray(executionRun.review);
}

function compareActionContributes(left: ResolvedActionContribution, right: ResolvedActionContribution): number {
    if (left.definition.id !== right.definition.id) {
        return left.definition.id.localeCompare(right.definition.id);
    }
    const leftPluginId = left.pluginId ?? '';
    const rightPluginId = right.pluginId ?? '';
    if (leftPluginId !== rightPluginId) {
        return leftPluginId.localeCompare(rightPluginId);
    }
    return (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '');
}

function compareToolContributes(left: ResolvedToolContribution, right: ResolvedToolContribution): number {
    if (left.definition.id !== right.definition.id) {
        return left.definition.id.localeCompare(right.definition.id);
    }
    const leftPluginId = left.pluginId ?? '';
    const rightPluginId = right.pluginId ?? '';
    if (leftPluginId !== rightPluginId) {
        return leftPluginId.localeCompare(rightPluginId);
    }
    return (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '');
}

function compareCommandContributes(left: ResolvedCommandContribution, right: ResolvedCommandContribution): number {
    if (left.definition.id !== right.definition.id) {
        return left.definition.id.localeCompare(right.definition.id);
    }
    const leftPluginId = left.pluginId ?? '';
    const rightPluginId = right.pluginId ?? '';
    if (leftPluginId !== rightPluginId) {
        return leftPluginId.localeCompare(rightPluginId);
    }
    return (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '');
}

function compareResourceContributes(left: ResolvedResourceContribution, right: ResolvedResourceContribution): number {
    if (left.definition.id !== right.definition.id) {
        return left.definition.id.localeCompare(right.definition.id);
    }
    const leftPluginId = left.pluginId ?? '';
    const rightPluginId = right.pluginId ?? '';
    if (leftPluginId !== rightPluginId) {
        return leftPluginId.localeCompare(rightPluginId);
    }
    return (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '');
}

function compareUiDescriptorContributes(left: ResolvedUiDescriptorContribution, right: ResolvedUiDescriptorContribution): number {
    if (left.definition.id !== right.definition.id) {
        return left.definition.id.localeCompare(right.definition.id);
    }
    const leftPluginId = left.pluginId ?? '';
    const rightPluginId = right.pluginId ?? '';
    if (leftPluginId !== rightPluginId) {
        return leftPluginId.localeCompare(rightPluginId);
    }
    return (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '');
}

function resolvePluginUiContributionRegistryId(
    contribution: Readonly<{
        pluginId?: string;
        definition: Readonly<{ id: string }>;
    }>,
): string {
    return `${contribution.pluginId ?? 'unknown'}:${contribution.definition.id}`;
}

function comparePluginUiContributionById(
    left: Readonly<{ pluginId?: string; manifestPath?: string; definition: Readonly<{ id: string }> }>,
    right: Readonly<{ pluginId?: string; manifestPath?: string; definition: Readonly<{ id: string }> }>,
): number {
    if (left.definition.id !== right.definition.id) {
        return left.definition.id.localeCompare(right.definition.id);
    }
    const leftPluginId = left.pluginId ?? '';
    const rightPluginId = right.pluginId ?? '';
    if (leftPluginId !== rightPluginId) {
        return leftPluginId.localeCompare(rightPluginId);
    }
    return (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '');
}

function compareUiTranslationsContributes(
    left: ResolvedUiTranslationsContribution,
    right: ResolvedUiTranslationsContribution,
): number {
    const leftPluginId = left.pluginId ?? '';
    const rightPluginId = right.pluginId ?? '';
    if (leftPluginId !== rightPluginId) {
        return leftPluginId.localeCompare(rightPluginId);
    }
    return (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '');
}

function compareStructuredMessageContributes(
    left: ResolvedStructuredMessageContribution,
    right: ResolvedStructuredMessageContribution,
): number {
    return comparePluginUiContributionById(left, right);
}

function compareSessionSurfaceContributes(
    left: ResolvedSessionSurfaceContribution,
    right: ResolvedSessionSurfaceContribution,
): number {
    return comparePluginUiContributionById(left, right);
}

function compareSessionHeaderActionContributes(
    left: ResolvedSessionHeaderActionContribution,
    right: ResolvedSessionHeaderActionContribution,
): number {
    return comparePluginUiContributionById(left, right);
}

function compareHostedWebContributes(
    left: ResolvedHostedWebContribution,
    right: ResolvedHostedWebContribution,
): number {
    return comparePluginUiContributionById(left, right);
}

function compareReactNativeBundleContributes(
    left: ResolvedReactNativeBundleContribution,
    right: ResolvedReactNativeBundleContribution,
): number {
    return comparePluginUiContributionById(left, right);
}

function compareUiArtifactContributes(
    left: ResolvedUiArtifactContribution,
    right: ResolvedUiArtifactContribution,
): number {
    return comparePluginUiContributionById(left, right);
}

function compareSettingsContributes(left: ResolvedSettingsContribution, right: ResolvedSettingsContribution): number {
    if (left.definition.id !== right.definition.id) {
        return left.definition.id.localeCompare(right.definition.id);
    }
    const leftPluginId = left.pluginId ?? '';
    const rightPluginId = right.pluginId ?? '';
    if (leftPluginId !== rightPluginId) {
        return leftPluginId.localeCompare(rightPluginId);
    }
    return (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '');
}

function compareNotificationCategoryContributes(left: ResolvedNotificationCategoryContribution, right: ResolvedNotificationCategoryContribution): number {
    if (left.definition.id !== right.definition.id) {
        return left.definition.id.localeCompare(right.definition.id);
    }
    const leftPluginId = left.pluginId ?? '';
    const rightPluginId = right.pluginId ?? '';
    if (leftPluginId !== rightPluginId) {
        return leftPluginId.localeCompare(rightPluginId);
    }
    return (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '');
}

function compareNotificationChannelContributes(left: ResolvedNotificationChannelContribution, right: ResolvedNotificationChannelContribution): number {
    if (left.definition.id !== right.definition.id) {
        return left.definition.id.localeCompare(right.definition.id);
    }
    const leftPluginId = left.pluginId ?? '';
    const rightPluginId = right.pluginId ?? '';
    if (leftPluginId !== rightPluginId) {
        return leftPluginId.localeCompare(rightPluginId);
    }
    return (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '');
}

function compareEventContributes(left: ResolvedEventContribution, right: ResolvedEventContribution): number {
    if (left.definition.id !== right.definition.id) {
        return left.definition.id.localeCompare(right.definition.id);
    }
    const leftPluginId = left.pluginId ?? '';
    const rightPluginId = right.pluginId ?? '';
    if (leftPluginId !== rightPluginId) {
        return leftPluginId.localeCompare(rightPluginId);
    }
    return (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '');
}

function compareRequestInterceptorContributes(
    left: ResolvedRequestInterceptorContribution,
    right: ResolvedRequestInterceptorContribution,
): number {
    const orderDelta = (left.definition.order ?? 0) - (right.definition.order ?? 0);
    if (orderDelta !== 0) {
        return orderDelta;
    }
    const leftPluginId = left.pluginId ?? '';
    const rightPluginId = right.pluginId ?? '';
    if (leftPluginId !== rightPluginId) {
        return leftPluginId.localeCompare(rightPluginId);
    }
    if (left.definition.id !== right.definition.id) {
        return left.definition.id.localeCompare(right.definition.id);
    }
    return (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '');
}

function compareActivationTargets(left: ResolvedActivationTarget, right: ResolvedActivationTarget): number {
    if (left.pluginId !== right.pluginId) {
        return left.pluginId.localeCompare(right.pluginId);
    }
    return left.daemonEntryPath.localeCompare(right.daemonEntryPath);
}

function compareLifecycleHandlerContributes(
    left: ResolvedLifecycleHandlerContribution,
    right: ResolvedLifecycleHandlerContribution,
): number {
    if (left.definition.id !== right.definition.id) {
        return left.definition.id.localeCompare(right.definition.id);
    }
    const priorityDelta = right.definition.priority - left.definition.priority;
    if (priorityDelta !== 0) {
        return priorityDelta;
    }
    const leftPluginId = left.pluginId ?? '';
    const rightPluginId = right.pluginId ?? '';
    if (leftPluginId !== rightPluginId) {
        return leftPluginId.localeCompare(rightPluginId);
    }
    return (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '');
}

function buildRegistryGenerationId(params: Readonly<{
    providers: readonly ResolvedProviderContribution[];
    backends: readonly ResolvedBackendContribution[];
    catalogEntries?: readonly ResolvedCatalogEntry[];
    actions: readonly ResolvedActionContribution[];
    tools: readonly ResolvedToolContribution[];
    commands: readonly ResolvedCommandContribution[];
    resources: readonly ResolvedResourceContribution[];
    uiDescriptors: readonly ResolvedUiDescriptorContribution[];
    uiTranslations: readonly ResolvedUiTranslationsContribution[];
    structuredMessages: readonly ResolvedStructuredMessageContribution[];
    sessionSurfaces: readonly ResolvedSessionSurfaceContribution[];
    sessionHeaderActions: readonly ResolvedSessionHeaderActionContribution[];
    hostedWeb: readonly ResolvedHostedWebContribution[];
    reactNativeBundles: readonly ResolvedReactNativeBundleContribution[];
    uiArtifacts: readonly ResolvedUiArtifactContribution[];
    settings: readonly ResolvedSettingsContribution[];
    notifications: readonly ResolvedNotificationCategoryContribution[];
    notificationChannels: readonly ResolvedNotificationChannelContribution[];
    events: readonly ResolvedEventContribution[];
    executionRunProfiles: readonly ResolvedExecutionRunProfileContribution[];
    mcpServers: readonly ResolvedMcpServerContribution[];
    mcpDiscoveryProviders: readonly ResolvedMcpDiscoveryProviderContribution[];
    installables: readonly ResolvedInstallableContribution[];
    requestInterceptors: readonly ResolvedRequestInterceptorContribution[];
    scmHostingProviders: readonly ResolvedScmHostingProviderContribution[];
    scmBackends: readonly ResolvedScmBackendContribution[];
    connectedAccountDescriptors: readonly ResolvedConnectedAccountDescriptorContribution[];
    activationTargets: readonly ResolvedActivationTarget[];
    hookRegistrations: ResolvedContributionInputs['hookRegistrations'];
    lifecycleHandlers: readonly ResolvedLifecycleHandlerContribution[];
}>): string {
    const parts = [
        ...params.providers.map((provider) => `provider:${provider.provenance}:${provider.source.kind}:${provider.id}:${provider.manifestDigest ?? ''}`),
        ...params.backends.map((backend) => `backend:${backend.provenance}:${backend.source.kind}:${backend.id}:${backend.manifestDigest ?? ''}`),
        ...(params.catalogEntries ?? []).map((catalogEntry) => `catalog:${catalogEntry.id}:${catalogEntry.cliSubcommand}`),
        ...params.actions.map((action) => `action:${action.provenance}:${action.source.kind}:${action.definition.id}:${action.manifestDigest ?? ''}`),
        ...params.tools.map((tool) => `tool:${tool.provenance}:${tool.source.kind}:${tool.definition.id}:${tool.definition.name}:${tool.manifestDigest ?? ''}`),
        ...params.commands.map((command) => `command:${command.provenance}:${command.source.kind}:${command.definition.id}:${command.definition.command}:${command.manifestDigest ?? ''}`),
        ...params.resources.map((resource) => `resource:${resource.provenance}:${resource.source.kind}:${resource.definition.id}:${resource.manifestDigest ?? ''}`),
        ...params.uiDescriptors.map((uiDescriptor) => `ui:${uiDescriptor.provenance}:${uiDescriptor.source.kind}:${uiDescriptor.definition.id}:${uiDescriptor.manifestDigest ?? ''}`),
        ...params.uiTranslations.map((bundle) => `uiTranslations:${bundle.provenance}:${bundle.source.kind}:${bundle.pluginId ?? ''}:${bundle.manifestDigest ?? ''}`),
        ...params.structuredMessages.map((message) => `structuredMessage:${message.provenance}:${message.source.kind}:${message.pluginId ?? ''}:${message.definition.id}:${message.definition.kind}:${message.manifestDigest ?? ''}`),
        ...params.sessionSurfaces.map((surface) => `sessionSurface:${surface.provenance}:${surface.source.kind}:${surface.pluginId ?? ''}:${surface.definition.id}:${surface.definition.surfaceKind}:${surface.manifestDigest ?? ''}`),
        ...params.sessionHeaderActions.map((action) => `sessionHeaderAction:${action.provenance}:${action.source.kind}:${action.pluginId ?? ''}:${action.definition.id}:${action.manifestDigest ?? ''}`),
        ...params.hostedWeb.map((web) => `hostedWeb:${web.provenance}:${web.source.kind}:${web.pluginId ?? ''}:${web.definition.id}:${web.manifestDigest ?? ''}`),
        ...params.reactNativeBundles.map((bundle) => `reactNativeBundle:${bundle.provenance}:${bundle.source.kind}:${bundle.pluginId ?? ''}:${bundle.definition.id}:${bundle.definition.bundle.integrity.digest}:${bundle.manifestDigest ?? ''}`),
        ...params.uiArtifacts.map((artifact) => `uiArtifact:${artifact.provenance}:${artifact.source.kind}:${artifact.pluginId ?? ''}:${artifact.definition.id}:${artifact.definition.integrity.digest}:${artifact.manifestDigest ?? ''}`),
        ...params.settings.map((setting) => `settings:${setting.provenance}:${setting.source.kind}:${setting.definition.id}:${setting.manifestDigest ?? ''}`),
        ...params.notifications.map((notification) => `notification:${notification.provenance}:${notification.source.kind}:${notification.definition.id}:${notification.manifestDigest ?? ''}`),
        ...params.notificationChannels.map((channel) => `notificationChannel:${channel.provenance}:${channel.source.kind}:${channel.definition.id}:${channel.manifestDigest ?? ''}`),
        ...params.events.map((event) => `event:${event.provenance}:${event.source.kind}:${event.definition.id}:${event.manifestDigest ?? ''}`),
        ...params.executionRunProfiles.map((profile) => `executionRunProfile:${profile.provenance}:${profile.source.kind}:${profile.definition.id}:${profile.manifestDigest ?? ''}`),
        ...params.mcpServers.map((server) => `mcpServer:${server.provenance}:${server.source.kind}:${server.definition.id}:${server.definition.name}:${server.manifestDigest ?? ''}`),
        ...params.mcpDiscoveryProviders.map((provider) => `mcpDiscoveryProvider:${provider.provenance}:${provider.source.kind}:${provider.definition.id}:${provider.manifestDigest ?? ''}`),
        ...params.installables.map((installable) => `installable:${installable.provenance}:${installable.source.kind}:${installable.definition.key}:${installable.definition.capabilityId}:${installable.manifestDigest ?? ''}`),
        ...params.requestInterceptors.map((interceptor) => `requestInterceptor:${interceptor.provenance}:${interceptor.source.kind}:${interceptor.definition.id}:${interceptor.definition.order ?? 0}:${interceptor.manifestDigest ?? ''}`),
        ...params.scmHostingProviders.map((provider) => `scmHostingProvider:${provider.provenance}:${provider.source.kind}:${provider.definition.id}:${provider.manifestDigest ?? ''}`),
        ...params.scmBackends.map((backend) => `scmBackend:${backend.provenance}:${backend.source.kind}:${backend.definition.id}:${backend.manifestDigest ?? ''}`),
        ...params.connectedAccountDescriptors.map((descriptor) => `connectedAccount:${descriptor.provenance}:${descriptor.source.kind}:${descriptor.definition.id}:${descriptor.manifestDigest ?? ''}`),
        ...params.activationTargets.map((target) => `activate:${target.provenance}:${target.source.kind}:${target.pluginId}:${target.manifestDigest}:${target.daemonEntryPath}`),
        ...(params.hookRegistrations ?? []).map((hook) => `hook:${hook.provenance}:${hook.source.kind}:${hook.definition.id}:${hook.manifestDigest}`),
        ...params.lifecycleHandlers.map((handler) => `lifecycle:${handler.provenance}:${handler.source.kind}:${handler.definition.id}:${handler.definition.event}:${handler.manifestDigest ?? ''}`),
    ].sort();
    return `registry:${parts.join('|')}`;
}

function compareMcpServerContributes(
    left: ResolvedMcpServerContribution,
    right: ResolvedMcpServerContribution,
): number {
    return left.definition.id.localeCompare(right.definition.id);
}

function compareMcpDiscoveryProviderContributes(
    left: ResolvedMcpDiscoveryProviderContribution,
    right: ResolvedMcpDiscoveryProviderContribution,
): number {
    return left.definition.id.localeCompare(right.definition.id);
}

function compareConnectedAccountDescriptorContributes(
    left: ResolvedConnectedAccountDescriptorContribution,
    right: ResolvedConnectedAccountDescriptorContribution,
): number {
    return left.definition.id.localeCompare(right.definition.id);
}

function compareExecutionRunProfileContributes(
    left: ResolvedExecutionRunProfileContribution,
    right: ResolvedExecutionRunProfileContribution,
): number {
    if (left.definition.intent !== right.definition.intent) {
        return left.definition.intent.localeCompare(right.definition.intent);
    }
    return left.definition.id.localeCompare(right.definition.id);
}

export function getBuiltInCatalogEntries(): Record<CatalogAgentId, AgentCatalogEntry> {
    return createResolvedContributionRegistry(resolveBuiltInContributions()).catalogEntriesById as Record<CatalogAgentId, AgentCatalogEntry>;
}
