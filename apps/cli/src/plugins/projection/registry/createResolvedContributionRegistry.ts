import type { AgentCatalogEntry, CatalogAgentId } from '@/backends/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

import { resolveBuiltInContributions } from './resolveBuiltInContributions';
import { resolvePluginContributes } from './resolvePluginContributions';
import type {
    ResolvedBackendContribution,
    ResolvedBackendRuntimeAdapterContribution,
    ResolvedActionContribution,
    ResolvedCommandContribution,
    ResolvedContributionInputs,
    ResolvedContributionRegistry,
    ResolvedCatalogEntry,
    ResolvedLifecycleHandlerContribution,
    ResolvedNotificationCategoryContribution,
    ResolvedNotificationChannelContribution,
    ResolvedSettingsContribution,
    ResolvedScmHostingProviderContribution,
    ResolvedProviderContribution,
    ResolvedResourceContribution,
    ResolvedToolContribution,
    ResolvedUiDescriptorContribution,
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
    const settings = Object.freeze([...(inputs.settings ?? [])].sort(compareSettingsContributes));
    const notifications = Object.freeze([...(inputs.notifications ?? [])].sort(compareNotificationCategoryContributes));
    const notificationChannels = Object.freeze([...(inputs.notificationChannels ?? [])].sort(compareNotificationChannelContributes));
    const scmHostingProvidersResult = resolveScmHostingProviderContributions(
        inputs.scmHostingProviders ?? [],
        inputs.pluginDiagnosticsByPluginId ?? {},
    );
    const scmHostingProviders = scmHostingProvidersResult.providers;
    const activationTargets = Object.freeze([...(inputs.activationTargets ?? [])].sort(compareActivationTargets));
    const lifecycleHandlers = Object.freeze([...(inputs.lifecycleHandlers ?? [])].sort(compareLifecycleHandlerContributes));
    const actionsById = new Map<string, ResolvedActionContribution>();
    const toolsById = new Map<string, ResolvedToolContribution>();
    const commandsById = new Map<string, ResolvedCommandContribution>();
    const resourcesById = new Map<string, ResolvedResourceContribution>();
    const uiDescriptorsById = new Map<string, ResolvedUiDescriptorContribution>();
    const settingsById = new Map<string, ResolvedSettingsContribution>();
    const notificationsById = new Map<string, ResolvedNotificationCategoryContribution>();
    const notificationChannelsById = new Map<string, ResolvedNotificationChannelContribution>();
    const lifecycleHandlersById = new Map<string, ResolvedLifecycleHandlerContribution>();
    // Host dispatch map keyed by backend id. Runtime-adapter operation names are
    // stable plugin ABI values; the dispatch map itself remains host-local.
    const runtimeCoreHooksByBackendId = new Map<string, readonly ResolvedBackendRuntimeAdapterContribution[]>();
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
        if (!providerDefinitionsById.has(backend.providerId)) {
            throw new Error(`Missing provider contribution '${backend.providerId}' for backend '${backend.id}'`);
        }

        backendDefinitionsById.set(backend.id, backend);

        const runtimeCoreHooks = backend.runtimeCoreHooks ?? [];
        if (runtimeCoreHooks.length > 0) {
            runtimeCoreHooksByBackendId.set(
                backend.id,
                Object.freeze(runtimeCoreHooks.map((definition) => ({
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
            settings,
            notifications,
            notificationChannels,
            scmHostingProviders,
            activationTargets,
            hookRegistrations: inputs.hookRegistrations ?? [],
            lifecycleHandlers,
        }),
        providers: inputs.providers,
        backends: inputs.backends,
        actions,
        tools,
        commands,
        resources,
        uiDescriptors,
        settings,
        notifications,
        notificationChannels,
        scmHostingProviders,
        activationTargets,
        hookRegistrations: Object.freeze([...(inputs.hookRegistrations ?? [])]),
        lifecycleHandlers,
        actionsById: Object.freeze(actionsById),
        toolsById: Object.freeze(toolsById),
        commandsById: Object.freeze(commandsById),
        resourcesById: Object.freeze(resourcesById),
        uiDescriptorsById: Object.freeze(uiDescriptorsById),
        settingsById: Object.freeze(settingsById),
        notificationsById: Object.freeze(notificationsById),
        notificationChannelsById: Object.freeze(notificationChannelsById),
        scmHostingProvidersById: scmHostingProvidersResult.providersById,
        lifecycleHandlersById: Object.freeze(lifecycleHandlersById),
        runtimeCoreHooksByBackendId: Object.freeze(runtimeCoreHooksByBackendId),
        catalogEntriesById: Object.freeze(catalogEntriesById),
        providerDefinitionsById,
        backendDefinitionsById,
        pluginDiagnosticsByPluginId: scmHostingProvidersResult.pluginDiagnosticsByPluginId,
    });
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

    for (const candidate of [...candidates].sort(compareScmHostingProviderPriority)) {
        const existing = providersById.get(candidate.id);
        if (!existing) {
            providersById.set(candidate.id, candidate);
            activeProviders.push(candidate);
            continue;
        }

        const message = `Duplicate ScmHostingProvider id '${candidate.id}' from plugin '${candidate.pluginId ?? 'unknown'}' conflicts with plugin '${existing.pluginId ?? 'unknown'}'`;
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
        notifications: Object.freeze([...(builtIn.notifications ?? []), ...(plugin.notifications ?? [])]),
        notificationChannels: Object.freeze([...(builtIn.notificationChannels ?? []), ...(plugin.notificationChannels ?? [])]),
        scmHostingProviders: Object.freeze([...(builtIn.scmHostingProviders ?? []), ...(plugin.scmHostingProviders ?? [])]),
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
    settings: readonly ResolvedSettingsContribution[];
    notifications: readonly ResolvedNotificationCategoryContribution[];
    notificationChannels: readonly ResolvedNotificationChannelContribution[];
    scmHostingProviders: readonly ResolvedScmHostingProviderContribution[];
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
        ...params.settings.map((setting) => `settings:${setting.provenance}:${setting.source.kind}:${setting.definition.id}:${setting.manifestDigest ?? ''}`),
        ...params.notifications.map((notification) => `notification:${notification.provenance}:${notification.source.kind}:${notification.definition.id}:${notification.manifestDigest ?? ''}`),
        ...params.notificationChannels.map((channel) => `notificationChannel:${channel.provenance}:${channel.source.kind}:${channel.definition.id}:${channel.manifestDigest ?? ''}`),
        ...params.scmHostingProviders.map((provider) => `scmHostingProvider:${provider.provenance}:${provider.source.kind}:${provider.definition.id}:${provider.manifestDigest ?? ''}`),
        ...params.activationTargets.map((target) => `activate:${target.provenance}:${target.source.kind}:${target.pluginId}:${target.manifestDigest}:${target.daemonEntryPath}`),
        ...(params.hookRegistrations ?? []).map((hook) => `hook:${hook.provenance}:${hook.source.kind}:${hook.definition.id}:${hook.manifestDigest}`),
        ...params.lifecycleHandlers.map((handler) => `lifecycle:${handler.provenance}:${handler.source.kind}:${handler.definition.id}:${handler.definition.event}:${handler.manifestDigest ?? ''}`),
    ].sort();
    return `registry:${parts.join('|')}`;
}

export function getBuiltInCatalogEntries(): Record<CatalogAgentId, AgentCatalogEntry> {
    return createResolvedContributionRegistry(resolveBuiltInContributions()).catalogEntriesById as Record<CatalogAgentId, AgentCatalogEntry>;
}
