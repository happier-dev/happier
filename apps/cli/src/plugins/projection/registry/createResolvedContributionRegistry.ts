import type { AgentCatalogEntry, CatalogAgentId } from '@/agent/catalog/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    qualifyPluginEventIdV1,
} from '@happier-dev/protocol';

import { buildPluginContributionIntrospectionQualifiedId } from '@/plugins/projection/introspection/project';
import { resolveBuiltInContributions } from './resolveBuiltInContributions';
import type {
    ResolvedActionContribution,
    ResolvedAccountCollectionContribution,
    ResolvedBrowserActionContribution,
    ResolvedBrowserTargetContribution,
    ResolvedCommandContribution,
    ResolvedConnectedAccountDescriptorContribution,
    ResolvedContributionInputs,
    ResolvedContributionRegistry,
    ResolvedCatalogEntry,
    ResolvedExecutionRunProfileContribution,
    ResolvedAutomationEligibleEvent,
    ResolvedAutomationEligibleEventAction,
    ResolvedEventContribution,
    ResolvedInstallableContribution,
    ResolvedMcpDiscoverySourceContribution,
    ResolvedMcpServerContribution,
    ResolvedNotificationCategoryContribution,
    ResolvedNotificationChannelContribution,
    ResolvedOpenableContentViewerContribution,
    ResolvedProviderContribution,
    ResolvedPromptAssetContribution,
    ResolvedHostedWebContribution,
    ResolvedRequestInterceptorContribution,
    ResolvedSettingsContribution,
    ResolvedScmBackendContribution,
    ResolvedScmHostingProviderContribution,
    ResolvedAgentContribution,
    ResolvedResourceContribution,
    ResolvedSessionHeaderActionContribution,
    ResolvedTranscriptActivityContribution,
    ResolvedStructuredMessageContribution,
    ResolvedSystemToolContribution,
    ResolvedToolContribution,
    ResolvedComposerReferenceContribution,
    ResolvedComposerAttachmentContribution,
    ResolvedComposerControlContribution,
    ResolvedComposerRegionContribution,
    ResolvedUiSettingsGroupV2Contribution,
    ResolvedUiSettingsPageV2Contribution,
    ResolvedUiTranslationBundleV2Contribution,
    ResolvedUiTranslationsContribution,
    ResolvedActivationTarget,
    ResolvedVoiceModelPackContribution,
    ResolvedVoiceProviderContribution,
    ResolvedPluginContributionPointDeclaration,
    ResolvedTargetedPluginContributionDeclaration,
} from './types';
import { resolveAdmittedTargetedContributions } from './targetedContributions';
import { resolveLocalSettingsDeclarations } from '@/plugins/settings/localSettingsContributions';
import {
    isExecutableManagedDependency,
    resolveExecutableManagedDependenciesRegistry,
    toExecutableManagedDependencyRegistryContribution,
    type ResolvedExecutableManagedDependency,
} from './managedDependencyExecutables';

function resolveContributionRegistryKey(contribution: Readonly<{
    pluginId?: string;
    definition: Readonly<{ id: string }>;
}>): string {
    return contribution.pluginId
        ? buildQualifiedPluginContributionKey(createPluginContributionIdentity({
            pluginId: contribution.pluginId,
            localId: contribution.definition.id,
        }))
        : contribution.definition.id;
}

function resolveAccountCollectionContributionRegistryKey(
    contribution: ResolvedAccountCollectionContribution,
): string {
    const { definition, identity, pluginId } = contribution;
    if (
        definition.pluginId !== pluginId
        || identity.pluginId !== pluginId
        || identity.localId !== definition.collectionId
    ) {
        throw new Error(`Account collection contribution identity is inconsistent for '${pluginId}/${definition.collectionId}'`);
    }
    return buildQualifiedPluginContributionKey(identity);
}

type ResolvedComposerContribution = Readonly<{
    pluginId: string;
    identity: Readonly<{ pluginId: string; localId: string }>;
    definition: Readonly<{ id: string }>;
}>;

function resolveComposerContributionRegistryKey(
    contribution: ResolvedComposerContribution,
): string {
    const { definition, identity, pluginId } = contribution;
    if (
        identity.pluginId !== pluginId
        || identity.localId !== definition.id
    ) {
        throw new Error(`Composer contribution identity is inconsistent for '${pluginId}/${definition.id}'`);
    }
    return buildQualifiedPluginContributionKey(identity);
}

function freezeComposerContributions<T extends ResolvedComposerContribution>(
    contributions: readonly T[],
): readonly T[] {
    const seen = new Set<string>();
    const sorted = [...contributions].sort((left, right) => (
        resolveComposerContributionRegistryKey(left)
            .localeCompare(resolveComposerContributionRegistryKey(right))
    ));
    for (const contribution of sorted) {
        const key = resolveComposerContributionRegistryKey(contribution);
        if (seen.has(key)) {
            throw new Error(`Duplicate Composer contribution '${key}'`);
        }
        seen.add(key);
    }
    return Object.freeze(sorted);
}

export function createResolvedContributionRegistry(inputs: ResolvedContributionInputs): ResolvedContributionRegistry {
    const materializationIdsByPluginId = Object.freeze(Object.fromEntries(
        Object.entries(inputs.materializationIdsByPluginId ?? {}).flatMap(([pluginId, materializationId]) => (
            typeof materializationId === 'string' && materializationId.trim().length > 0
                ? [[pluginId, materializationId] as const]
                : []
        )),
    ));
    const immutableGenerationIdsByPluginId = Object.freeze(Object.fromEntries(
        Object.entries(inputs.immutableGenerationIdsByPluginId ?? {}).flatMap(([pluginId, immutableGenerationId]) => (
            typeof immutableGenerationId === 'string' && immutableGenerationId.trim().length > 0
                ? [[pluginId, immutableGenerationId] as const]
                : []
        )),
    ));
    const introspectionContributions = Object.freeze([...(inputs.introspectionContributions ?? [])].sort((left, right) => (
        resolveIntrospectionCandidateSortKey(left).localeCompare(resolveIntrospectionCandidateSortKey(right))
    )));
    const uiViewsV2 = Object.freeze([...(inputs.uiViewsV2 ?? [])]);
    const openableContentViewers: readonly ResolvedOpenableContentViewerContribution[] = Object.freeze([
        ...(inputs.openableContentViewers ?? []),
    ].sort((left, right) => (
        buildQualifiedPluginContributionKey(left.identity).localeCompare(buildQualifiedPluginContributionKey(right.identity))
    )));
    const uiSettingsGroupsV2: readonly ResolvedUiSettingsGroupV2Contribution[] = Object.freeze([
        ...(inputs.uiSettingsGroupsV2 ?? []),
    ]);
    const uiSettingsPagesV2: readonly ResolvedUiSettingsPageV2Contribution[] = Object.freeze([
        ...(inputs.uiSettingsPagesV2 ?? []),
    ]);
    const uiRenderersV2 = Object.freeze([...(inputs.uiRenderersV2 ?? [])]);
    assertUniquePluginUiBindings('destination', [...uiViewsV2, ...uiSettingsPagesV2]);
    assertUniquePluginUiBindings('renderer', uiRenderersV2);
    const uiTranslationsV2 = Object.freeze([...(inputs.uiTranslationsV2 ?? [])].sort(compareUiTranslationsV2Contributes));
    const composerReferences: readonly ResolvedComposerReferenceContribution[] = freezeComposerContributions(
        inputs.composerReferences ?? [],
    );
    const composerAttachments: readonly ResolvedComposerAttachmentContribution[] = freezeComposerContributions(
        inputs.composerAttachments ?? [],
    );
    const composerControls: readonly ResolvedComposerControlContribution[] = freezeComposerContributions(
        inputs.composerControls ?? [],
    );
    const composerRegions: readonly ResolvedComposerRegionContribution[] = freezeComposerContributions(
        inputs.composerRegions ?? [],
    );
    const inputAgents = inputs.agents ?? [];
    const providers = Object.freeze([...(inputs.providers ?? [])].sort((left, right) =>
        buildQualifiedPluginContributionKey(left.identity).localeCompare(buildQualifiedPluginContributionKey(right.identity))
    ));
    const providersByContributionKey = new Map<string, ResolvedProviderContribution>();
    for (const provider of providers) {
        const contributionKey = buildQualifiedPluginContributionKey(provider.identity);
        if (providersByContributionKey.has(contributionKey)) {
            throw new Error(`Duplicate provider contribution '${contributionKey}'`);
        }
        providersByContributionKey.set(contributionKey, provider);
    }
    const agentDefinitionsById = new Map<string, ResolvedAgentContribution>();
    const standaloneCatalogEntries = Object.freeze([...(inputs.catalogEntries ?? [])]);
    const actions = Object.freeze([...(inputs.actions ?? [])].sort(compareActionContributes));
    const tools = Object.freeze([...(inputs.tools ?? [])].sort(compareToolContributes));
    const commands = Object.freeze([...(inputs.commands ?? [])].sort(compareCommandContributes));
    const resources = Object.freeze([...(inputs.resources ?? [])].sort(compareResourceContributes));
    const promptAssets = Object.freeze([...(inputs.promptAssets ?? [])].sort(comparePromptAssetContributes));
    const uiTranslations = Object.freeze([...(inputs.uiTranslations ?? [])].sort(compareUiTranslationsContributes));
    const structuredMessages = Object.freeze([...(inputs.structuredMessages ?? [])].sort(compareStructuredMessageContributes));
    const sessionHeaderActions = Object.freeze([...(inputs.sessionHeaderActions ?? [])].sort(compareSessionHeaderActionContributes));
    const transcriptActivities = Object.freeze([...(inputs.transcriptActivities ?? [])].sort(compareTranscriptActivityContributes));
    const sessionInfoSections = Object.freeze([...(inputs.sessionInfoSections ?? [])].sort(compareTranscriptActivityContributes));
    const hostedWeb = Object.freeze([...(inputs.hostedWeb ?? [])].sort(compareHostedWebContributes));
    const browserTargets = Object.freeze([...(inputs.browserTargets ?? [])].sort(compareBrowserTargetContributes));
    const browserActions = Object.freeze([...(inputs.browserActions ?? [])].sort(compareBrowserActionContributes));
    const settings = Object.freeze([...(inputs.settings ?? [])].sort(compareSettingsContributes));
    const notifications = Object.freeze([...(inputs.notifications ?? [])].sort(compareNotificationCategoryContributes));
    const notificationChannels = Object.freeze([...(inputs.notificationChannels ?? [])].sort(compareNotificationChannelContributes));
    const events = Object.freeze([...(inputs.events ?? [])].sort(compareEventContributes));
    const executionRunProfiles = Object.freeze([...(inputs.executionRunProfiles ?? [])].sort(compareExecutionRunProfileContributes));
    const mcpServers = Object.freeze([...(inputs.mcpServers ?? [])].sort(compareMcpServerContributes));
    const mcpDiscoverySources = Object.freeze([...(inputs.mcpDiscoverySources ?? [])].sort(compareMcpDiscoverySourceContributes));
    const managedDependenciesResult = resolveInstallableContributions(
        inputs.managedDependencies ?? [],
        inputs.pluginDiagnosticsByPluginId ?? {},
    );
    const managedDependencies = managedDependenciesResult.managedDependencies;
    const systemTools = Object.freeze([...(inputs.systemTools ?? [])].sort((left, right) => (
        left.definition.id.localeCompare(right.definition.id)
        || (left.pluginId ?? '').localeCompare(right.pluginId ?? '')
    )));
    const scmHostingProvidersResult = resolveScmHostingProviderContributions(
        inputs.scmHostingProviders ?? [],
        managedDependenciesResult.pluginDiagnosticsByPluginId,
    );
    const scmHostingProviders = scmHostingProvidersResult.providers;
    const scmBackendsResult = resolveScmBackendContributions(
        inputs.scmBackends ?? [],
        scmHostingProvidersResult.pluginDiagnosticsByPluginId,
    );
    const scmBackends = scmBackendsResult.backends;
    const connectedAccountDescriptors = Object.freeze([...(inputs.connectedAccountDescriptors ?? [])].sort(compareConnectedAccountDescriptorContributes));
    const requestInterceptors = Object.freeze([...(inputs.requestInterceptors ?? [])].sort(compareRequestInterceptorContributes));
    const voiceModelPacks = Object.freeze([...(inputs.voiceModelPacks ?? [])].sort(compareVoiceModelPackContributes));
    const voiceProviders = Object.freeze([...(inputs.voiceProviders ?? [])].sort((left, right) => (
        buildQualifiedPluginContributionKey(left.identity).localeCompare(buildQualifiedPluginContributionKey(right.identity))
    )));
    const accountCollections = Object.freeze([...(inputs.accountCollections ?? [])].sort((left, right) => (
        resolveAccountCollectionContributionRegistryKey(left)
            .localeCompare(resolveAccountCollectionContributionRegistryKey(right))
    )));
    const pluginContributionPoints: readonly ResolvedPluginContributionPointDeclaration[] = Object.freeze([
        ...(inputs.pluginContributionPoints ?? []),
    ]);
    const targetedPluginContributions: readonly ResolvedTargetedPluginContributionDeclaration[] = Object.freeze([
        ...(inputs.targetedPluginContributions ?? []),
    ]);
    const targetedAdmission = resolveAdmittedTargetedContributions({
        pluginContributionPoints,
        targetedPluginContributions,
        actions,
        uiRenderersV2,
        immutableGenerationIdsByPluginId,
    });
    const pluginDiagnosticsByPluginId = mergePluginDiagnostics(
        scmBackendsResult.pluginDiagnosticsByPluginId,
        targetedAdmission.diagnosticsByPluginId,
    );
    const accountCollectionKeys = new Set<string>();
    for (const accountCollection of accountCollections) {
        const key = resolveAccountCollectionContributionRegistryKey(accountCollection);
        if (accountCollectionKeys.has(key)) {
            throw new Error(`Duplicate account collection contribution '${key}'`);
        }
        accountCollectionKeys.add(key);
    }
    const activationTargets = Object.freeze([...(inputs.activationTargets ?? [])].sort(compareActivationTargets));
    const actionsById = new Map<string, ResolvedActionContribution>();
    const toolsById = new Map<string, ResolvedToolContribution>();
    const commandsById = new Map<string, ResolvedCommandContribution>();
    const resourcesById = new Map<string, ResolvedResourceContribution>();
    const promptAssetsById = new Map<string, ResolvedPromptAssetContribution>();
    const structuredMessagesById = new Map<string, ResolvedStructuredMessageContribution>();
    const sessionHeaderActionsById = new Map<string, ResolvedSessionHeaderActionContribution>();
    const transcriptActivitiesById = new Map<string, ResolvedTranscriptActivityContribution>();
    const sessionInfoSectionsById = new Map<string, (typeof sessionInfoSections)[number]>();
    const hostedWebById = new Map<string, ResolvedHostedWebContribution>();
    const browserTargetsById = new Map<string, ResolvedBrowserTargetContribution>();
    const browserActionsById = new Map<string, ResolvedBrowserActionContribution>();
    const settingsById = new Map<string, ResolvedSettingsContribution>();
    const notificationsById = new Map<string, ResolvedNotificationCategoryContribution>();
    const notificationChannelsById = new Map<string, ResolvedNotificationChannelContribution>();
    const eventsById = new Map<string, ResolvedEventContribution>();
    const executionRunProfilesById = new Map<string, ResolvedExecutionRunProfileContribution>();
    const managedDependenciesByKey = new Map<string, ResolvedInstallableContribution>();
    const systemToolsById = new Map<string, ResolvedSystemToolContribution>();
    const connectedAccountDescriptorsById = new Map<string, ResolvedConnectedAccountDescriptorContribution>();
    // Internal merged projection used by CLI host surfaces; not a public plugin ABI.
    const catalogEntriesById: Record<string, ResolvedCatalogEntry> = {};

    for (const catalogEntry of standaloneCatalogEntries) {
        assertCatalogEntryAligned(catalogEntry);
        if (catalogEntriesById[catalogEntry.id]) {
            throw new Error(`Duplicate catalog entry contribution '${catalogEntry.id}'`);
        }
        catalogEntriesById[catalogEntry.id] = catalogEntry;
    }

    for (const agent of inputAgents) {
        assertAgentContributionAligned(agent);
        if (agentDefinitionsById.has(agent.id)) {
            throw new Error(`Duplicate agent contribution '${agent.id}'`);
        }

        agentDefinitionsById.set(agent.id, agent);

        if (agent.catalogEntry) {
            if (catalogEntriesById[agent.catalogEntry.id]) {
                throw new Error(`Duplicate catalog entry contribution '${agent.catalogEntry.id}'`);
            }
            catalogEntriesById[agent.id] = agent.catalogEntry;
        }
    }

    for (const action of actions) {
        const key = resolveContributionRegistryKey(action);
        if (actionsById.has(key)) {
            throw new Error(`Duplicate action contribution '${key}'`);
        }
        actionsById.set(key, action);
    }

    for (const tool of tools) {
        const key = resolveContributionRegistryKey(tool);
        if (toolsById.has(key)) {
            throw new Error(`Duplicate tool contribution '${key}'`);
        }
        toolsById.set(key, tool);
    }

    for (const command of commands) {
        const key = resolveContributionRegistryKey(command);
        if (commandsById.has(key)) {
            throw new Error(`Duplicate command contribution '${key}'`);
        }
        commandsById.set(key, command);
    }

    for (const resource of resources) {
        const key = resolveContributionRegistryKey(resource);
        if (resourcesById.has(key)) {
            throw new Error(`Duplicate resource contribution '${key}'`);
        }
        resourcesById.set(key, resource);
    }

    for (const message of structuredMessages) {
        const id = resolvePluginUiContributionRegistryId(message);
        if (structuredMessagesById.has(id)) {
            throw new Error(`Duplicate structured message contribution '${id}'`);
        }
        structuredMessagesById.set(id, message);
    }

    for (const action of sessionHeaderActions) {
        const id = resolvePluginUiContributionRegistryId(action);
        if (sessionHeaderActionsById.has(id)) {
            throw new Error(`Duplicate session header action contribution '${id}'`);
        }
        sessionHeaderActionsById.set(id, action);
    }

    for (const activity of transcriptActivities) {
        const id = resolvePluginUiContributionRegistryId(activity);
        if (transcriptActivitiesById.has(id)) {
            throw new Error(`Duplicate transcript Activity contribution '${id}'`);
        }
        transcriptActivitiesById.set(id, activity);
    }
    for (const section of sessionInfoSections) {
        const id = resolvePluginUiContributionRegistryId(section);
        if (sessionInfoSectionsById.has(id)) {
            throw new Error(`Duplicate Session-info section contribution '${id}'`);
        }
        sessionInfoSectionsById.set(id, section);
    }

    for (const contribution of hostedWeb) {
        const id = resolvePluginUiContributionRegistryId(contribution);
        if (hostedWebById.has(id)) {
            throw new Error(`Duplicate hosted web contribution '${id}'`);
        }
        hostedWebById.set(id, contribution);
    }

    for (const target of browserTargets) {
        const id = resolvePluginUiContributionRegistryId(target);
        if (browserTargetsById.has(id)) {
            throw new Error(`Duplicate browser target contribution '${id}'`);
        }
        browserTargetsById.set(id, target);
    }

    for (const action of browserActions) {
        const id = resolvePluginUiContributionRegistryId(action);
        if (browserActionsById.has(id)) {
            throw new Error(`Duplicate browser action contribution '${id}'`);
        }
        browserActionsById.set(id, action);
    }

    resolveLocalSettingsDeclarations({ settings });
    for (const setting of settings) {
        const key = resolveContributionRegistryKey(setting);
        if (settingsById.has(key)) {
            throw new Error(`Duplicate settings contribution '${key}'`);
        }
        settingsById.set(key, setting);
    }

    for (const notification of notifications) {
        const key = resolveContributionRegistryKey(notification);
        if (notificationsById.has(key)) {
            throw new Error(`Duplicate notification category contribution '${key}'`);
        }
        notificationsById.set(key, notification);
    }

    for (const channel of notificationChannels) {
        const key = resolveContributionRegistryKey(channel);
        if (notificationChannelsById.has(key)) {
            throw new Error(`Duplicate notification channel contribution '${key}'`);
        }
        notificationChannelsById.set(key, channel);
    }

    for (const event of events) {
        const eventRegistryId = readEventRegistryId(event);
        if (eventsById.has(eventRegistryId)) {
            throw new Error(`Duplicate event contribution '${eventRegistryId}' from plugin '${event.pluginId ?? '<unknown>'}'`);
        }
        eventsById.set(eventRegistryId, event);
    }

    const automationEligibleEvents = deriveAutomationEligibleEvents({
        events,
        actionsById,
        immutableGenerationIdsByPluginId,
    });

    for (const profile of executionRunProfiles) {
        const key = resolveContributionRegistryKey(profile);
        if (executionRunProfilesById.has(key)) {
            throw new Error(`Duplicate execution-run profile contribution '${key}'`);
        }
        executionRunProfilesById.set(key, profile);
    }

    for (const installable of managedDependencies) {
        const dependencyId = isExecutableManagedDependency(installable)
            ? installable.definition.id
            : resolveContributionRegistryKey(installable);
        if (managedDependenciesByKey.has(dependencyId)) {
            throw new Error(`Duplicate managed dependency contribution '${dependencyId}'`);
        }
        managedDependenciesByKey.set(dependencyId, installable);
    }
    for (const systemTool of systemTools) {
        const key = resolveContributionRegistryKey(systemTool);
        if (systemToolsById.has(key)) {
            throw new Error(`Duplicate system tool contribution '${key}'`);
        }
        systemToolsById.set(key, systemTool);
    }
    for (const promptAsset of promptAssets) {
        const key = buildQualifiedPluginContributionKey(promptAsset.identity);
        if (promptAssetsById.has(key)) {
            throw new Error(`Duplicate prompt asset contribution '${key}'`);
        }
        promptAssetsById.set(key, promptAsset);
    }
    for (const descriptor of connectedAccountDescriptors) {
        const key = resolveContributionRegistryKey(descriptor);
        if (connectedAccountDescriptorsById.has(key)) {
            throw new Error(`Duplicate connected account descriptor contribution '${key}'`);
        }
        connectedAccountDescriptorsById.set(key, descriptor);
    }
    return Object.freeze({
        introspectionContributions,
        uiViewsV2,
        openableContentViewers,
        uiSettingsGroupsV2,
        uiSettingsPagesV2,
        uiRenderersV2,
        uiTranslationsV2,
        composerReferences,
        composerAttachments,
        composerControls,
        composerRegions,
        agents: inputAgents,
        providers,
        actions,
        tools,
        commands,
        resources,
        promptAssets,
        uiTranslations,
        structuredMessages,
        sessionHeaderActions,
        transcriptActivities,
        sessionInfoSections,
        hostedWeb,
        browserTargets,
        browserActions,
        settings,
        notifications,
        notificationChannels,
        events,
        automationEligibleEvents,
        executionRunProfiles,
        mcpServers,
        mcpDiscoverySources,
        managedDependencies,
        systemTools,
        scmHostingProviders,
        scmBackends,
        connectedAccountDescriptors,
        requestInterceptors,
        voiceModelPacks,
        voiceProviders,
        accountCollections,
        pluginContributionPoints,
        targetedPluginContributions,
        readAdmittedTargetedContributions(request) {
            return targetedAdmission.read(request);
        },
        activationTargets,
        materializationIdsByPluginId,
        immutableGenerationIdsByPluginId,
        actionsById: Object.freeze(actionsById),
        toolsById: Object.freeze(toolsById),
        commandsById: Object.freeze(commandsById),
        resourcesById: Object.freeze(resourcesById),
        promptAssetsById: Object.freeze(promptAssetsById),
        structuredMessagesById: Object.freeze(structuredMessagesById),
        sessionHeaderActionsById: Object.freeze(sessionHeaderActionsById),
        transcriptActivitiesById: Object.freeze(transcriptActivitiesById),
        sessionInfoSectionsById: Object.freeze(sessionInfoSectionsById),
        hostedWebById: Object.freeze(hostedWebById),
        browserTargetsById: Object.freeze(browserTargetsById),
        browserActionsById: Object.freeze(browserActionsById),
        settingsById: Object.freeze(settingsById),
        notificationsById: Object.freeze(notificationsById),
        notificationChannelsById: Object.freeze(notificationChannelsById),
        eventsById: Object.freeze(eventsById),
        executionRunProfilesById: Object.freeze(executionRunProfilesById),
        managedDependenciesByKey: Object.freeze(managedDependenciesByKey),
        systemToolsById: Object.freeze(systemToolsById),
        scmHostingProvidersById: scmHostingProvidersResult.providersById,
        scmBackendsById: scmBackendsResult.backendsById,
        connectedAccountDescriptorsById: Object.freeze(connectedAccountDescriptorsById),
        catalogEntriesById: Object.freeze(catalogEntriesById),
        agentDefinitionsById,
        providersByContributionKey: Object.freeze(providersByContributionKey),
        pluginDiagnosticsByPluginId,
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

function readRequiredContributionString(value: unknown): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : null;
}

function readEventPresentationText(value: unknown): string | null {
    const direct = readRequiredContributionString(value);
    if (direct) return direct;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return readRequiredContributionString((value as Readonly<{ fallback?: unknown }>).fallback);
}

/**
 * Binds one Event-declared plugin Action without any catalog search fallback.
 * Manifest ingestion owns declaration/schema validity; this cold owner only
 * retains an exact, same-generation Action handle while it is still current.
 */
function resolveCurrentAutomationEventAction(params: Readonly<{
    actionRef: Readonly<{ pluginId: string; localId: string }> | undefined;
    pluginId: string;
    immutableGenerationId: string;
    actionsById: ReadonlyMap<string, ResolvedActionContribution>;
    immutableGenerationIdsByPluginId: Readonly<Record<string, string>>;
}>): ResolvedAutomationEligibleEventAction | null {
    const actionRef = params.actionRef;
    if (!actionRef || actionRef.pluginId !== params.pluginId) return null;
    const identity = createPluginContributionIdentity({
        pluginId: actionRef.pluginId,
        localId: actionRef.localId,
    });
    const id = buildQualifiedPluginContributionKey(identity);
    const action = params.actionsById.get(id);
    const actionImmutableGenerationId = action?.pluginId
        ? readRequiredContributionString(params.immutableGenerationIdsByPluginId[action.pluginId])
        : null;
    if (
        !action
        || action.pluginId !== params.pluginId
        || action.definition.surfaces.plugin !== true
        || actionImmutableGenerationId !== params.immutableGenerationId
    ) {
        return null;
    }
    const title = readRequiredContributionString(action.definition.title);
    if (!title) return null;
    return Object.freeze({
        id,
        identity,
        immutableGenerationId: params.immutableGenerationId,
        title,
        description: readRequiredContributionString(action.definition.description),
        inputSchema: action.definition.inputSchema,
        inputHints: action.definition.inputHints,
    });
}

/**
 * The Event composer consumes this single cold registry-derived view. It does
 * not interpret raw manifests, scan Actions by local id, or activate a plugin.
 * Manifest admission owns reference/result-schema semantics; this owner only
 * proves that the exact currently resolved Action and immutable generation
 * still exist together.
 */
function deriveAutomationEligibleEvents(params: Readonly<{
    events: readonly ResolvedEventContribution[];
    actionsById: ReadonlyMap<string, ResolvedActionContribution>;
    immutableGenerationIdsByPluginId: Readonly<Record<string, string>>;
}>): readonly ResolvedAutomationEligibleEvent[] {
    const eligible: ResolvedAutomationEligibleEvent[] = [];
    for (const event of params.events) {
        if (event.definition.kind !== 'event' || event.definition.automation?.eligible !== true) continue;
        const pluginId = readRequiredContributionString(event.pluginId);
        const localId = readRequiredContributionString(event.definition.localId);
        const setupActionRef = event.definition.automation.source.setupActionRef;
        const immutableGenerationId = pluginId
            ? readRequiredContributionString(params.immutableGenerationIdsByPluginId[pluginId])
            : null;
        if (
            !pluginId
            || !localId
            || !setupActionRef
            || setupActionRef.pluginId !== pluginId
            || !immutableGenerationId
        ) {
            continue;
        }
        const eventTitle = readEventPresentationText(event.definition.title);
        const setupAction = resolveCurrentAutomationEventAction({
            actionRef: setupActionRef,
            pluginId,
            immutableGenerationId,
            actionsById: params.actionsById,
            immutableGenerationIdsByPluginId: params.immutableGenerationIdsByPluginId,
        });
        if (!eventTitle || !setupAction) continue;
        const eventIdentity = createPluginContributionIdentity({ pluginId, localId });
        const historyGapResetAction = resolveCurrentAutomationEventAction({
            actionRef: event.definition.automation.source.historyGapResetActionRef,
            pluginId,
            immutableGenerationId,
            actionsById: params.actionsById,
            immutableGenerationIdsByPluginId: params.immutableGenerationIdsByPluginId,
        });
        eligible.push(Object.freeze({
            event: Object.freeze({
                id: readEventRegistryId(event),
                identity: eventIdentity,
                immutableGenerationId,
                title: eventTitle,
                description: readEventPresentationText(event.definition.description),
                ...(event.definition.payloadSchema === undefined
                    ? {}
                    : { payloadSchema: event.definition.payloadSchema }),
                automation: event.definition.automation,
            }),
            setupAction,
            ...(historyGapResetAction === null ? {} : { historyGapResetAction }),
        }));
    }
    return Object.freeze(eligible.sort((left, right) => left.event.id.localeCompare(right.event.id)));
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

function mergePluginDiagnostics(
    ...sources: readonly Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>[]
): Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>> {
    const diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]> = {};
    for (const source of sources) {
        for (const [pluginId, diagnostics] of Object.entries(source).sort(([left], [right]) => (
            left.localeCompare(right)
        ))) {
            diagnosticsByPluginId[pluginId] = diagnosticsByPluginId[pluginId] ?? [];
            diagnosticsByPluginId[pluginId]!.push(...diagnostics);
        }
    }
    return freezePluginDiagnostics(diagnosticsByPluginId);
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

function resolveInstallableContributions(
    candidates: readonly ResolvedInstallableContribution[],
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>,
): Readonly<{
    managedDependencies: readonly ResolvedInstallableContribution[];
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}> {
    const diagnosticsByPluginId = clonePluginDiagnostics(pluginDiagnosticsByPluginId);
    const candidateByOwnerAndKey = new Map<string, ResolvedExecutableManagedDependency>();
    const targetContributions = candidates.filter((candidate) => !isExecutableManagedDependency(candidate));

    for (const candidate of candidates) {
        if (!isExecutableManagedDependency(candidate)) continue;
        const contribution = toExecutableManagedDependencyRegistryContribution(candidate);
        candidateByOwnerAndKey.set(`${contribution.owner.ownerId}:${contribution.descriptor.key}`, candidate);
    }

    const resolved = resolveExecutableManagedDependenciesRegistry(candidates);
    for (const diagnostic of resolved.diagnostics) {
        const pluginId = diagnostic.disabledPluginId ?? 'unknown';
        diagnosticsByPluginId[pluginId] = diagnosticsByPluginId[pluginId] ?? [];
        diagnosticsByPluginId[pluginId]!.push({
            code: diagnostic.code,
            message: diagnostic.message,
        });
    }

    return {
        managedDependencies: Object.freeze([
            ...resolved.descriptors.flatMap((entry) => {
                const candidate = candidateByOwnerAndKey.get(`${entry.owner.ownerId}:${entry.descriptor.key}`);
                return candidate ? [candidate] : [];
            }),
            ...targetContributions,
        ]),
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
            localId: candidate.id,
        }),
    });
}

function formatScmHostingProviderContributionKey(candidate: ResolvedScmHostingProviderContribution): string {
    return candidate.identity
        ? buildQualifiedPluginContributionKey(candidate.identity)
        : `${candidate.pluginId ?? 'unknown'}/${candidate.id}`;
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
        const key = formatScmHostingProviderContributionKey(candidate);
        if (providersById.has(key)) {
            throw new Error(`Duplicate SCM hosting-provider contribution '${key}'`);
        }
        providersById.set(key, candidate);
        activeProviders.push(candidate);
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
            localId: candidate.id,
        }),
    });
}

function formatScmBackendContributionKey(candidate: ResolvedScmBackendContribution): string {
    return candidate.identity
        ? buildQualifiedPluginContributionKey(candidate.identity)
        : `${candidate.pluginId ?? 'unknown'}/${candidate.id}`;
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
        const key = formatScmBackendContributionKey(candidate);
        if (backendsById.has(key)) {
            throw new Error(`Duplicate SCM backend contribution '${key}'`);
        }
        backendsById.set(key, candidate);
        activeBackends.push(candidate);
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
        existingAgentIds: new Set(builtIn.agents.map((agent) => agent.id)),
    });

    return createMergedContributionRegistry(plugin, builtIn);
}

export function createMergedContributionRegistry(
    plugin: ResolvedContributionInputs,
    builtIn: ResolvedContributionInputs = resolveBuiltInContributions(),
): ResolvedContributionRegistry {
    return createResolvedContributionRegistry({
        introspectionContributions: Object.freeze([
            ...(builtIn.introspectionContributions ?? []),
            ...(plugin.introspectionContributions ?? []),
        ]),
        agents: Object.freeze([...(builtIn.agents ?? []), ...(plugin.agents ?? [])]),
        providers: Object.freeze([...(builtIn.providers ?? []), ...(plugin.providers ?? [])]),
        catalogEntries: Object.freeze([...(builtIn.catalogEntries ?? []), ...(plugin.catalogEntries ?? [])]),
        actions: Object.freeze([...(builtIn.actions ?? []), ...(plugin.actions ?? [])]),
        tools: Object.freeze([...(builtIn.tools ?? []), ...(plugin.tools ?? [])]),
        commands: Object.freeze([...(builtIn.commands ?? []), ...(plugin.commands ?? [])]),
        resources: Object.freeze([...(builtIn.resources ?? []), ...(plugin.resources ?? [])]),
        promptAssets: Object.freeze([...(builtIn.promptAssets ?? []), ...(plugin.promptAssets ?? [])]),
        uiViewsV2: Object.freeze([...(builtIn.uiViewsV2 ?? []), ...(plugin.uiViewsV2 ?? [])]),
        openableContentViewers: Object.freeze([
            ...(builtIn.openableContentViewers ?? []),
            ...(plugin.openableContentViewers ?? []),
        ]),
        uiSettingsGroupsV2: Object.freeze([
            ...(builtIn.uiSettingsGroupsV2 ?? []),
            ...(plugin.uiSettingsGroupsV2 ?? []),
        ]),
        uiSettingsPagesV2: Object.freeze([
            ...(builtIn.uiSettingsPagesV2 ?? []),
            ...(plugin.uiSettingsPagesV2 ?? []),
        ]),
        uiRenderersV2: Object.freeze([...(builtIn.uiRenderersV2 ?? []), ...(plugin.uiRenderersV2 ?? [])]),
        uiTranslationsV2: Object.freeze([...(builtIn.uiTranslationsV2 ?? []), ...(plugin.uiTranslationsV2 ?? [])]),
        composerReferences: Object.freeze([
            ...(builtIn.composerReferences ?? []),
            ...(plugin.composerReferences ?? []),
        ]),
        composerAttachments: Object.freeze([
            ...(builtIn.composerAttachments ?? []),
            ...(plugin.composerAttachments ?? []),
        ]),
        composerControls: Object.freeze([
            ...(builtIn.composerControls ?? []),
            ...(plugin.composerControls ?? []),
        ]),
        composerRegions: Object.freeze([
            ...(builtIn.composerRegions ?? []),
            ...(plugin.composerRegions ?? []),
        ]),
        uiTranslations: Object.freeze([...(builtIn.uiTranslations ?? []), ...(plugin.uiTranslations ?? [])]),
        structuredMessages: Object.freeze([...(builtIn.structuredMessages ?? [])]),
        sessionHeaderActions: Object.freeze([...(builtIn.sessionHeaderActions ?? []), ...(plugin.sessionHeaderActions ?? [])]),
        transcriptActivities: Object.freeze([...(builtIn.transcriptActivities ?? []), ...(plugin.transcriptActivities ?? [])]),
        sessionInfoSections: Object.freeze([...(builtIn.sessionInfoSections ?? []), ...(plugin.sessionInfoSections ?? [])]),
        hostedWeb: Object.freeze([...(builtIn.hostedWeb ?? []), ...(plugin.hostedWeb ?? [])]),
        browserTargets: Object.freeze([...(builtIn.browserTargets ?? []), ...(plugin.browserTargets ?? [])]),
        browserActions: Object.freeze([...(builtIn.browserActions ?? []), ...(plugin.browserActions ?? [])]),
        settings: Object.freeze([...(builtIn.settings ?? []), ...(plugin.settings ?? [])]),
        notifications: Object.freeze([...(builtIn.notifications ?? []), ...(plugin.notifications ?? [])]),
        notificationChannels: Object.freeze([...(builtIn.notificationChannels ?? []), ...(plugin.notificationChannels ?? [])]),
        events: Object.freeze([...(builtIn.events ?? []), ...(plugin.events ?? [])]),
        executionRunProfiles: Object.freeze([...(builtIn.executionRunProfiles ?? []), ...(plugin.executionRunProfiles ?? [])]),
        mcpServers: Object.freeze([...(builtIn.mcpServers ?? []), ...(plugin.mcpServers ?? [])]),
        mcpDiscoverySources: Object.freeze([
            ...(builtIn.mcpDiscoverySources ?? []),
            ...(plugin.mcpDiscoverySources ?? []),
        ]),
        managedDependencies: Object.freeze([...(builtIn.managedDependencies ?? []), ...(plugin.managedDependencies ?? [])]),
        systemTools: Object.freeze([...(builtIn.systemTools ?? []), ...(plugin.systemTools ?? [])]),
        requestInterceptors: Object.freeze([...(builtIn.requestInterceptors ?? []), ...(plugin.requestInterceptors ?? [])]),
        scmHostingProviders: Object.freeze([...(builtIn.scmHostingProviders ?? []), ...(plugin.scmHostingProviders ?? [])]),
        scmBackends: Object.freeze([...(builtIn.scmBackends ?? []), ...(plugin.scmBackends ?? [])]),
        connectedAccountDescriptors: Object.freeze([...(builtIn.connectedAccountDescriptors ?? []), ...(plugin.connectedAccountDescriptors ?? [])]),
        voiceModelPacks: Object.freeze([...(builtIn.voiceModelPacks ?? []), ...(plugin.voiceModelPacks ?? [])]),
        voiceProviders: Object.freeze([...(builtIn.voiceProviders ?? []), ...(plugin.voiceProviders ?? [])]),
        accountCollections: Object.freeze([...(builtIn.accountCollections ?? []), ...(plugin.accountCollections ?? [])]),
        pluginContributionPoints: Object.freeze([
            ...(builtIn.pluginContributionPoints ?? []),
            ...(plugin.pluginContributionPoints ?? []),
        ]),
        targetedPluginContributions: Object.freeze([
            ...(builtIn.targetedPluginContributions ?? []),
            ...(plugin.targetedPluginContributions ?? []),
        ]),
        activationTargets: Object.freeze([...(builtIn.activationTargets ?? []), ...(plugin.activationTargets ?? [])]),
        materializationIdsByPluginId: Object.freeze({
            ...(builtIn.materializationIdsByPluginId ?? {}),
            ...(plugin.materializationIdsByPluginId ?? {}),
        }),
        immutableGenerationIdsByPluginId: Object.freeze({
            ...(builtIn.immutableGenerationIdsByPluginId ?? {}),
            ...(plugin.immutableGenerationIdsByPluginId ?? {}),
        }),
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

function assertAgentContributionAligned(agent: ResolvedAgentContribution): void {
    if (agent.definition.kindVersion !== 1) {
        throw new Error(`Agent definition version mismatch for contribution '${agent.id}'`);
    }
    if (agent.definition.id !== agent.id) {
        throw new Error(`Agent definition id mismatch for contribution '${agent.id}'`);
    }
    if (agent.catalogEntry && agent.catalogEntry.id !== agent.id) {
        throw new Error(`catalog entry id mismatch for agent contribution '${agent.id}'`);
    }
    if (agent.catalogEntry && agent.catalogEntry.cliSubcommand !== agent.id) {
        throw new Error(`catalog entry cliSubcommand mismatch for agent contribution '${agent.id}'`);
    }
}

function assertCatalogEntryAligned(catalogEntry: ResolvedCatalogEntry): void {
    if (catalogEntry.id !== catalogEntry.cliSubcommand) {
        throw new Error(`Catalog entry id/cliSubcommand mismatch for catalog entry contribution '${catalogEntry.id}'`);
    }
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

function comparePromptAssetContributes(left: ResolvedPromptAssetContribution, right: ResolvedPromptAssetContribution): number {
    const priority = (left.definition.priority ?? 0) - (right.definition.priority ?? 0);
    if (priority !== 0) return priority;
    return buildQualifiedPluginContributionKey(left.identity).localeCompare(
        buildQualifiedPluginContributionKey(right.identity),
    );
}

function resolvePluginUiContributionRegistryId(
    contribution: Readonly<{
        pluginId?: string;
        definition: Readonly<{ id: string }>;
    }>,
): string {
    return `${contribution.pluginId ?? 'unknown'}:${contribution.definition.id}`;
}

function assertUniquePluginUiBindings(
    kind: 'destination' | 'renderer',
    contributions: readonly Readonly<{
        pluginId?: string;
        definition: Readonly<{ id: string }>;
    }>[],
): void {
    const ids = new Set<string>();
    for (const contribution of contributions) {
        const id = resolvePluginUiContributionRegistryId(contribution);
        if (ids.has(id)) {
            throw new Error(`Duplicate UI ${kind} binding '${id}'`);
        }
        ids.add(id);
    }
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

function compareUiTranslationsV2Contributes(
    left: ResolvedUiTranslationBundleV2Contribution,
    right: ResolvedUiTranslationBundleV2Contribution,
): number {
    if (left.pluginId !== right.pluginId) {
        return left.pluginId.localeCompare(right.pluginId);
    }
    if (left.definition.locale !== right.definition.locale) {
        return left.definition.locale.localeCompare(right.definition.locale);
    }
    const leftOwner = `${left.manifestPath ?? ''}\0${JSON.stringify(left.definition)}`;
    const rightOwner = `${right.manifestPath ?? ''}\0${JSON.stringify(right.definition)}`;
    return leftOwner.localeCompare(rightOwner);
}

function compareStructuredMessageContributes(
    left: ResolvedStructuredMessageContribution,
    right: ResolvedStructuredMessageContribution,
): number {
    return comparePluginUiContributionById(left, right);
}

function compareSessionHeaderActionContributes(
    left: ResolvedSessionHeaderActionContribution,
    right: ResolvedSessionHeaderActionContribution,
): number {
    return comparePluginUiContributionById(left, right);
}

function compareTranscriptActivityContributes(
    left: ResolvedTranscriptActivityContribution,
    right: ResolvedTranscriptActivityContribution,
): number {
    return comparePluginUiContributionById(left, right);
}

function compareHostedWebContributes(
    left: ResolvedHostedWebContribution,
    right: ResolvedHostedWebContribution,
): number {
    return comparePluginUiContributionById(left, right);
}

function compareBrowserTargetContributes(
    left: ResolvedBrowserTargetContribution,
    right: ResolvedBrowserTargetContribution,
): number {
    return comparePluginUiContributionById(left, right);
}

function compareBrowserActionContributes(
    left: ResolvedBrowserActionContribution,
    right: ResolvedBrowserActionContribution,
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
    const orderDelta = (left.definition.priority ?? 0) - (right.definition.priority ?? 0);
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
    return (left.daemonEntryPath ?? '').localeCompare(right.daemonEntryPath ?? '');
}

function resolveIntrospectionCandidateSortKey(candidate: NonNullable<ResolvedContributionInputs['introspectionContributions']>[number]): string {
    return buildPluginContributionIntrospectionQualifiedId(candidate);
}

function compareMcpServerContributes(
    left: ResolvedMcpServerContribution,
    right: ResolvedMcpServerContribution,
): number {
    return left.definition.id.localeCompare(right.definition.id);
}

function compareMcpDiscoverySourceContributes(
    left: ResolvedMcpDiscoverySourceContribution,
    right: ResolvedMcpDiscoverySourceContribution,
): number {
    return left.definition.id.localeCompare(right.definition.id);
}

function compareConnectedAccountDescriptorContributes(
    left: ResolvedConnectedAccountDescriptorContribution,
    right: ResolvedConnectedAccountDescriptorContribution,
): number {
    return left.definition.id.localeCompare(right.definition.id);
}

function compareVoiceModelPackContributes(
    left: ResolvedVoiceModelPackContribution,
    right: ResolvedVoiceModelPackContribution,
): number {
    return buildQualifiedPluginContributionKey(left.identity)
        .localeCompare(buildQualifiedPluginContributionKey(right.identity));
}

function compareExecutionRunProfileContributes(
    left: ResolvedExecutionRunProfileContribution,
    right: ResolvedExecutionRunProfileContribution,
): number {
    return left.definition.id.localeCompare(right.definition.id);
}

export function getBuiltInCatalogEntries(): Record<CatalogAgentId, AgentCatalogEntry> {
    return createResolvedContributionRegistry(resolveBuiltInContributions()).catalogEntriesById as Record<CatalogAgentId, AgentCatalogEntry>;
}
