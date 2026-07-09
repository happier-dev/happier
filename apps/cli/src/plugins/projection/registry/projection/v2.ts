import type {
    PluginHookIdV1,
    PluginProjectionDiagnosticV2,
    PluginProjectionInstalledPackageV2,
    PluginProjectionV2,
} from '@happier-dev/protocol';
import { getPluginHookDefinitionV1, normalizePluginBackendCapabilitiesV1, PluginHookIdV1Schema } from '@happier-dev/protocol';

import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type {
    ResolvedActionContribution,
    ResolvedAgentRuntimeContribution,
    ResolvedContributionRegistry,
    ResolvedContributionProvenance,
    ResolvedContributionSource,
    ResolvedContributionSourceKind,
    ResolvedHookRegistration,
    ResolvedAgentContribution,
    ResolvedUiDescriptorContribution,
} from '../types';
import {
    buildPluginProjectionFamiliesByIdV2,
    type PluginProjectionFamilyDescriptorV2,
} from '@/plugins/projection/families';
import { managedDependenciesProjectionFamily } from '../managedDependencies';
import { mcpProjectionFamily } from '../mcp';
import { scmBackendProjectionFamily } from '../scmBackends';
import { scmHostingProviderProjectionFamily } from '../scmHostingProviders';
import {
    pluginUiProjectionFamily,
    type PluginUiProjectionHostRuntimeContext,
} from '../ui/projection';
import { pluginBrowserProjectionFamily } from '@/plugins/browser/projection';

function readOptionalString(value: unknown): string | undefined {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : undefined;
}

function readProjectedHookEventId(value: unknown): PluginHookIdV1 | null {
    const parsed = PluginHookIdV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function readAgentTitle(provider: ResolvedAgentContribution): string | undefined {
    const rich = provider.richDefinition;
    if (!rich || rich.provenance !== 'external') return undefined;
    return readOptionalString(rich.definition.display?.name);
}

function readAgentSubtitle(provider: ResolvedAgentContribution): string | undefined {
    const rich = provider.richDefinition;
    if (!rich || rich.provenance !== 'external') return undefined;
    return readOptionalString(rich.definition.display?.subtitle);
}

function readAgentProjectionDefinition(
    provider: ResolvedAgentContribution,
): Readonly<Record<string, unknown>> {
    return (provider.richDefinition?.definition ?? provider.definition) as Readonly<Record<string, unknown>>;
}

function readAgentProjectionProviderAgentId(
    definition: Readonly<Record<string, unknown>>,
): string | undefined {
    return readOptionalString(definition.providerAgentId) ?? readOptionalString(definition.catalogAgentId);
}

function resolveActionSurfaces(
    surfaces: Readonly<Record<string, unknown>>,
): ('agent' | 'mcp' | 'cli')[] {
    const projected = new Set<'agent' | 'mcp' | 'cli'>();
    if (surfaces.cli === true) {
        projected.add('cli');
    }
    if (surfaces.mcp === true) {
        projected.add('mcp');
    }
    if (surfaces.agent === true) {
        projected.add('agent');
    }
    if (projected.size === 0) {
        projected.add('cli');
    }
    return [...projected];
}

function resolveActionScopes(
    action: ResolvedActionContribution,
): ('global' | 'settings' | 'session')[] {
    const surfaces = action.definition.surfaces;
    if (surfaces.mcp === true || surfaces.agent === true) {
        return ['session'];
    }
    if (surfaces.ui === true || surfaces.voice === true) {
        return ['settings'];
    }
    return ['global'];
}

function resolveUiDescriptorSurface(
    surface: string,
): 'settings' | 'setup' | 'status' | 'agentSettings' | null {
    switch (surface) {
        case 'setup':
            return 'setup';
        case 'status':
            return 'status';
        case 'agentSettings':
            return 'agentSettings';
        case 'settings':
            return 'settings';
        default:
            return null;
    }
}

function resolveUiFieldType(kind: string): 'text' | 'boolean' | 'select' | 'secret' | 'number' | 'markdown' | 'action' {
    switch (kind) {
        case 'boolean':
        case 'select':
        case 'secret':
        case 'number':
        case 'markdown':
        case 'action':
        case 'text':
            return kind;
        default:
            return 'text';
    }
}

function resolveUiDescriptorTone(value: unknown): 'info' | 'success' | 'neutral' | 'warning' | 'danger' | undefined {
    switch (value) {
        case 'info':
        case 'success':
        case 'neutral':
        case 'warning':
        case 'danger':
            return value;
        default:
            return undefined;
    }
}

function resolveHookExecutionKind(value: unknown): 'integrate' | 'observe' | 'augment' | 'decide' | undefined {
    switch (value) {
        case 'integrate':
        case 'observe':
        case 'augment':
        case 'decide':
            return value;
        case 'decision':
            return 'decide';
        default:
            return undefined;
    }
}

function resolveHookAggregation(
    value: unknown,
): 'none' | 'replace' | 'orderedList' | 'mergeObject' | 'firstDecision' | 'allDecisions' | undefined {
    switch (value) {
        case 'none':
        case 'replace':
        case 'orderedList':
        case 'mergeObject':
        case 'firstDecision':
        case 'allDecisions':
            return value;
        default:
            return undefined;
    }
}

function resolveHookFailureMode(value: unknown): 'bestEffort' | 'failClosed' | undefined {
    switch (value) {
        case 'bestEffort':
        case 'failClosed':
            return value;
        default:
            return undefined;
    }
}

type PluginContributionMetadata = Readonly<{
    pluginId: string;
    provenance?: ResolvedContributionProvenance;
    sourceKind?: ResolvedContributionSourceKind;
    displayName?: string;
    manifestPath?: string;
    manifestDigest?: string;
    sourceSpec?: Readonly<{
        kind?: string;
        locator?: string;
        resolvedVersion?: string;
    }>;
}>;

function collectPluginContributionMetadata(
    registry: ResolvedContributionRegistry,
): ReadonlyMap<string, PluginContributionMetadata> {
    const metadata = new Map<string, PluginContributionMetadata>();

    function upsert(entry: Readonly<{
        provenance?: ResolvedContributionProvenance;
        source?: ResolvedContributionSource;
        pluginId?: string;
        manifestPath?: string;
        manifestDigest?: string;
        sourceSpec?: Readonly<{
            kind?: string;
            locator?: string;
            resolvedVersion?: string;
        }>;
        displayName?: string;
    }>): void {
        const pluginId = readOptionalString(entry.pluginId);
        if (!pluginId) {
            return;
        }
        const existing = metadata.get(pluginId);
        const mergedProvenance = existing?.provenance === 'first_party' || entry.provenance === 'first_party'
            ? 'first_party'
            : existing?.provenance ?? entry.provenance;
        const mergedSourceKind = existing?.sourceKind === 'bundled' || entry.source?.kind === 'bundled'
            ? 'bundled'
            : existing?.sourceKind ?? entry.source?.kind;
        metadata.set(pluginId, {
            pluginId,
            provenance: mergedProvenance,
            sourceKind: mergedSourceKind,
            displayName: readOptionalString(entry.displayName) ?? existing?.displayName,
            manifestPath: readOptionalString(entry.manifestPath) ?? existing?.manifestPath,
            manifestDigest: readOptionalString(entry.manifestDigest) ?? existing?.manifestDigest,
            sourceSpec: entry.sourceSpec ?? existing?.sourceSpec,
        });
    }

    for (const provider of registry.agents) {
        upsert({
            provenance: provider.provenance,
            source: provider.source,
            pluginId: provider.pluginId,
            manifestPath: provider.manifestPath,
            manifestDigest: provider.manifestDigest,
            sourceSpec: provider.sourceSpec,
            displayName: readAgentTitle(provider),
        });
    }
    for (const backend of registry.agentRuntimes) {
        upsert({
            provenance: backend.provenance,
            source: backend.source,
            pluginId: backend.pluginId,
            manifestPath: backend.manifestPath,
            manifestDigest: backend.manifestDigest,
            sourceSpec: backend.sourceSpec,
        });
    }
    for (const action of registry.actions) {
        upsert(action);
    }
    for (const tool of registry.tools ?? []) {
        upsert(tool);
    }
    for (const command of registry.commands ?? []) {
        upsert(command);
    }
    for (const resource of registry.resources) {
        upsert(resource);
    }
    for (const descriptor of registry.uiDescriptors) {
        if (resolveUiDescriptorSurface(descriptor.definition.surface)) {
            upsert(descriptor);
        }
    }
    for (const target of registry.browserTargets ?? []) {
        upsert(target);
    }
    for (const action of registry.browserActions ?? []) {
        upsert(action);
    }
    for (const hook of registry.hookRegistrations) {
        upsert(hook);
    }
    for (const target of registry.activationTargets) {
        upsert(target);
    }
    for (const provider of registry.scmHostingProviders ?? []) {
        upsert({
            provenance: provider.provenance,
            source: provider.source,
            pluginId: provider.pluginId,
            manifestPath: provider.manifestPath,
            manifestDigest: provider.manifestDigest,
            sourceSpec: provider.sourceSpec,
            displayName: provider.definition.displayName,
        });
    }
    for (const dependency of registry.managedDependencies ?? []) {
        upsert({
            provenance: dependency.provenance,
            source: dependency.source,
            pluginId: dependency.pluginId,
            manifestPath: dependency.manifestPath,
            manifestDigest: dependency.manifestDigest,
            sourceSpec: dependency.sourceSpec,
            displayName: dependency.definition.display.name,
        });
    }
    for (const server of registry.mcpServers ?? []) {
        upsert(server);
    }
    for (const provider of registry.mcpDiscoveryProviders ?? []) {
        upsert(provider);
    }

    return metadata;
}

function pushPluginDiagnostics(
    bucket: Map<string, PluginProjectionDiagnosticV2[]>,
    pluginId: string,
    diagnostics: readonly PluginCompatibilityDiagnostic[],
): void {
    if (diagnostics.length === 0) {
        return;
    }
    const existing = bucket.get(pluginId) ?? [];
    const dedupe = new Set(existing.map((diagnostic) => `${diagnostic.code}:${diagnostic.message}`));
    for (const diagnostic of diagnostics) {
        const key = `${diagnostic.code}:${diagnostic.message}`;
        if (dedupe.has(key)) {
            continue;
        }
        dedupe.add(key);
        existing.push({
            severity: 'error',
            code: diagnostic.code,
            message: diagnostic.message,
            pluginId,
        });
    }
    bucket.set(pluginId, existing);
}

function buildDiagnostics(params: Readonly<{
    installedPackages: readonly PluginCatalogEntry[];
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>): PluginProjectionDiagnosticV2[] {
    const diagnosticsByPluginId = new Map<string, PluginProjectionDiagnosticV2[]>();
    for (const entry of params.installedPackages) {
        pushPluginDiagnostics(diagnosticsByPluginId, entry.pluginId, entry.diagnostics);
    }
    for (const [pluginId, diagnostics] of Object.entries(params.pluginDiagnosticsByPluginId)) {
        pushPluginDiagnostics(diagnosticsByPluginId, pluginId, diagnostics);
    }
    return [...diagnosticsByPluginId.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([, diagnostics]) => diagnostics);
}

function toInstalledPackage(
    entry: PluginCatalogEntry,
): PluginProjectionInstalledPackageV2 {
    return {
        id: entry.pluginId,
        displayName: entry.title,
        version: readOptionalString(entry.version),
        enabled: entry.enabled,
        source: {
            kind: readOptionalString(entry.source.kind) ?? 'unknown',
            locator: readOptionalString(entry.source.locator) ?? entry.pluginId,
        },
        digest: readOptionalString(entry.manifestDigest),
    };
}

function buildInstalledPackagesById(params: Readonly<{
    registry: ResolvedContributionRegistry;
    installedPackages: readonly PluginCatalogEntry[];
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>): PluginProjectionV2['installedPackagesById'] {
    const installedPackagesById: PluginProjectionV2['installedPackagesById'] = {};
    const metadataByPluginId = collectPluginContributionMetadata(params.registry);

    for (const entry of params.installedPackages) {
        installedPackagesById[entry.pluginId] = toInstalledPackage(entry);
    }

    const fallbackPluginIds = new Set<string>([
        ...metadataByPluginId.keys(),
        ...Object.keys(params.pluginDiagnosticsByPluginId),
    ]);
    for (const pluginId of fallbackPluginIds) {
        if (installedPackagesById[pluginId]) {
            continue;
        }
        const metadata = metadataByPluginId.get(pluginId);
        const sourceKind = (() => {
            const kind = metadata?.sourceKind ?? readOptionalString(metadata?.sourceSpec?.kind);
            if (kind === 'bundled') {
                return 'bundled';
            }
            // These are legacy placeholders in the packetized model and should not appear in
            // new production data. Preserve them only as unknown so UI doesn't imply a real
            // installed package provenance.
            if (kind === 'package' || kind === 'marketplace') {
                return 'unknown';
            }
            return kind ?? 'unknown';
        })();
        const locator = sourceKind === 'bundled'
            ? pluginId
            : readOptionalString(metadata?.sourceSpec?.locator)
                ?? readOptionalString(metadata?.manifestPath)
                ?? pluginId;
        installedPackagesById[pluginId] = {
            id: pluginId,
            displayName: metadata?.displayName ?? pluginId,
            version: readOptionalString(metadata?.sourceSpec?.resolvedVersion),
            enabled: true,
            source: {
                kind: sourceKind,
                locator,
            },
            digest: readOptionalString(metadata?.manifestDigest),
        };
    }

    return installedPackagesById;
}

function buildProvidersById(
    registry: ResolvedContributionRegistry,
): PluginProjectionV2['providersById'] {
    const providersById: PluginProjectionV2['providersById'] = {};
    for (const provider of registry.agents) {
        const projectionDefinition = readAgentProjectionDefinition(provider);
        providersById[provider.id] = {
            id: provider.id,
            title: readAgentTitle(provider),
            subtitle: readAgentSubtitle(provider),
            channel: provider.provenance === 'external' ? 'plugin' : undefined,
            isBuiltIn: provider.provenance === 'first_party',
            settingsBackendId: readOptionalString(projectionDefinition.settingsBackendId),
            providerAgentId: readAgentProjectionProviderAgentId(projectionDefinition),
            iconAgentId: readOptionalString(projectionDefinition.iconAgentId),
        };
    }
    return providersById;
}

function buildBackendsById(
    registry: ResolvedContributionRegistry,
): PluginProjectionV2['backendsById'] {
    const backendsById: PluginProjectionV2['backendsById'] = {};
    for (const backend of registry.agentRuntimes) {
        const richDefinition = backend.richDefinition?.provenance === 'external' ? backend.richDefinition.definition : null;
        const runtimeOwnerId = backend.agentId;
        backendsById[backend.id] = {
            id: backend.id,
            providerId: runtimeOwnerId,
            title: readOptionalString(richDefinition?.title),
            subtitle: readOptionalString(richDefinition?.subtitle),
            providerAgentId: readOptionalString(richDefinition?.providerAgentId),
            iconAgentId: readOptionalString(richDefinition?.iconAgentId),
            capabilities: cloneProjectedBackendCapabilities(backend.capabilities),
        };
    }
    return backendsById;
}

function cloneProjectedBackendCapabilities(
    capabilities: ResolvedAgentRuntimeContribution['capabilities'],
): NonNullable<PluginProjectionV2['backendsById'][string]>['capabilities'] {
    return normalizePluginBackendCapabilitiesV1({
        ...(capabilities ?? {}),
        executionRun: {
            ...(capabilities?.executionRun ?? {}),
            supported: capabilities?.executionRun?.supported !== false,
        },
    });
}

function buildHooksById(
    registry: ResolvedContributionRegistry,
): NonNullable<PluginProjectionV2['hooksById']> {
    const hooksById: NonNullable<PluginProjectionV2['hooksById']> = {};
    const hookRegistrationCountsByPluginAndEvent = new Map<string, number>();
    const sortedHookRegistrations = [...registry.hookRegistrations].sort((left, right) => (
        left.pluginId.localeCompare(right.pluginId)
        || left.definition.id.localeCompare(right.definition.id)
        || (left.manifestPath ?? '').localeCompare(right.manifestPath ?? '')
        || (left.daemonEntryPath ?? '').localeCompare(right.daemonEntryPath ?? '')
        || (left.definition.priority ?? 0) - (right.definition.priority ?? 0)
        || (left.definition.handler.exportName ?? '').localeCompare(right.definition.handler.exportName ?? '')
        || JSON.stringify(left.definition.filters ?? {}).localeCompare(JSON.stringify(right.definition.filters ?? {}))
    ));

    for (const hook of sortedHookRegistrations) {
        const hookDefinition = getPluginHookDefinitionV1(hook.definition.id);
        const rawDefinition = hook.definition as Readonly<Record<string, unknown>>;
        const eventId = readProjectedHookEventId(
            hookDefinition?.id ?? readOptionalString(rawDefinition.eventId) ?? hook.definition.id,
        );
        if (!eventId) {
            continue;
        }
        const countKey = `${hook.pluginId}:${hook.definition.id}`;
        const ordinal = (hookRegistrationCountsByPluginAndEvent.get(countKey) ?? 0) + 1;
        hookRegistrationCountsByPluginAndEvent.set(countKey, ordinal);
        const projectedHookId = `${hook.pluginId}:${hook.definition.id}:${ordinal}`;
        hooksById[projectedHookId] = {
            id: projectedHookId,
            pluginId: hook.pluginId,
            eventId,
            category: hookDefinition?.category ?? hook.definition.category,
            scope: hookDefinition?.scope ?? hook.definition.scope,
            executionKind: hookDefinition?.executionKind ?? resolveHookExecutionKind(hook.definition.executionKind),
            aggregation: hookDefinition?.aggregation ?? resolveHookAggregation(rawDefinition.aggregation),
            failureMode: hookDefinition?.failureMode ?? resolveHookFailureMode(rawDefinition.failureMode),
            priority: hook.definition.priority,
        };
    }
    return hooksById;
}

function buildActionsById(
    registry: ResolvedContributionRegistry,
): PluginProjectionV2['actionsById'] {
    const actionsById: PluginProjectionV2['actionsById'] = {};
    for (const action of registry.actions) {
        if (!action.pluginId) {
            continue;
        }
        actionsById[action.definition.id] = {
            id: action.definition.id,
            pluginId: action.pluginId,
            title: action.definition.title,
            description: readOptionalString(action.definition.description),
            scopes: resolveActionScopes(action),
            surfaces: resolveActionSurfaces(action.definition.surfaces),
            placement: 'detailsPanel',
            dangerLevel: action.definition.safety === 'safe' ? 'safe' : 'writesLocal',
            available: true,
        };
    }
    return actionsById;
}

function buildToolsById(
    registry: ResolvedContributionRegistry,
): PluginProjectionV2['toolsById'] {
    const toolsById: PluginProjectionV2['toolsById'] = {};
    for (const tool of registry.tools ?? []) {
        if (!tool.pluginId) {
            continue;
        }
        toolsById[tool.definition.id] = {
            id: tool.definition.id,
            pluginId: tool.pluginId,
            title: tool.definition.title,
            description: readOptionalString(tool.definition.description),
            exposesToAgent: tool.definition.surfaces.mcp === true || tool.definition.surfaces.agent === true,
        };
    }
    return toolsById;
}

function buildCommandsById(
    registry: ResolvedContributionRegistry,
): PluginProjectionV2['commandsById'] {
    const commandsById: PluginProjectionV2['commandsById'] = {};
    for (const command of registry.commands ?? []) {
        if (!command.pluginId) {
            continue;
        }
        commandsById[command.definition.id] = {
            id: command.definition.id,
            pluginId: command.pluginId,
            title: command.definition.rootHelpLabel ?? command.definition.command,
            description: readOptionalString(command.definition.rootHelpDescription ?? command.definition.rootHelpDetail),
            surfaces: ['cli'],
            tokens: [command.definition.command],
        };
    }
    return commandsById;
}

function buildResourcesById(
    registry: ResolvedContributionRegistry,
): PluginProjectionV2['resourcesById'] {
    const resourcesById: PluginProjectionV2['resourcesById'] = {};
    for (const resource of registry.resources) {
        if (!resource.pluginId) {
            continue;
        }
        resourcesById[resource.definition.id] = {
            id: resource.definition.id,
            pluginId: resource.pluginId,
            resourceKind: resource.definition.type === 'prompt'
                || resource.definition.type === 'skill'
                || resource.definition.type === 'template'
                || resource.definition.type === 'asset'
                || resource.definition.type === 'config'
                ? resource.definition.type
                : 'asset',
            path: resource.definition.path ?? resource.definition.id,
            digest: readOptionalString(resource.definition.digest),
            contentType: readOptionalString(resource.definition.contentType),
        };
    }
    return resourcesById;
}

function buildUiDescriptorsById(
    registry: ResolvedContributionRegistry,
): PluginProjectionV2['uiDescriptorsById'] {
    const uiDescriptorsById: PluginProjectionV2['uiDescriptorsById'] = {};
    for (const descriptor of registry.uiDescriptors) {
        if (!descriptor.pluginId) {
            continue;
        }
        const surface = resolveUiDescriptorSurface(descriptor.definition.surface);
        if (!surface) {
            continue;
        }
        const tone = resolveUiDescriptorTone(descriptor.definition.tone);
        uiDescriptorsById[descriptor.definition.id] = {
            id: descriptor.definition.id,
            pluginId: descriptor.pluginId,
            title: descriptor.definition.title,
            description: readOptionalString(descriptor.definition.description),
            surface,
            ...(typeof descriptor.definition.order === 'number' ? { order: descriptor.definition.order } : {}),
            ...(tone ? { tone } : {}),
            ...(descriptor.definition.featureGate !== undefined ? { featureGate: descriptor.definition.featureGate } : {}),
            ...(descriptor.definition.helpUrl !== undefined ? { helpUrl: descriptor.definition.helpUrl } : {}),
            fields: descriptor.definition.fields.map((field) => ({
                id: field.id,
                type: resolveUiFieldType(field.kind),
                title: field.title,
                description: readOptionalString(field.description),
                ...(typeof field.order === 'number' ? { order: field.order } : {}),
                ...(field.groupId !== undefined ? { groupId: field.groupId } : {}),
                ...(field.featureGate !== undefined ? { featureGate: field.featureGate } : {}),
                ...(field.actionId !== undefined ? { actionId: field.actionId } : {}),
                options: (field.options ?? []).map((option) => ({
                    value: option.value,
                    label: option.label,
                })),
            })),
        };
    }
    return uiDescriptorsById;
}

function buildSettingsById(
    registry: ResolvedContributionRegistry,
): PluginProjectionV2['settingsById'] {
    const settingsById: PluginProjectionV2['settingsById'] = {};
    for (const settings of registry.settings ?? []) {
        if (!settings.pluginId) {
            continue;
        }
        settingsById[settings.definition.id] = {
            id: settings.definition.id,
            pluginId: settings.pluginId,
            storageScope: 'pluginLocal',
            fields: settings.definition.fields
                .filter((field) => field.hidden !== true)
                .map((field) => ({
                    id: field.id,
                    kind: 'settings.field',
                    version: field.version,
                    valueSchema: { type: field.valueSchema.type },
                    control: field.control,
                    displayKey: field.displayKey,
                    ...(field.descriptionKey !== undefined ? { descriptionKey: field.descriptionKey } : {}),
                    ...(field.groupId !== undefined ? { groupId: field.groupId } : {}),
                    ...(typeof field.order === 'number' ? { order: field.order } : {}),
                    capabilityGates: [...(field.capabilityGates ?? [])],
                    permissionGates: [...(field.permissionGates ?? [])],
                    redaction: field.redaction ?? 'none',
                    clearWhenEmpty: field.clearWhenEmpty ?? 'persist',
                    ...(field.defaultBooleanValue !== undefined
                        ? { defaultBooleanValue: field.defaultBooleanValue }
                        : {}),
                })),
        };
    }
    return settingsById;
}

export function buildPluginProjectionV2(params: Readonly<{
    registry: ResolvedContributionRegistry;
    generation: number;
    installedPackages?: readonly PluginCatalogEntry[];
    pluginDiagnosticsByPluginId?: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    familyDescriptors?: readonly PluginProjectionFamilyDescriptorV2[];
    pluginUiHostRuntime?: PluginUiProjectionHostRuntimeContext;
}>): PluginProjectionV2 {
    const installedPackages = params.installedPackages ?? [];
    const pluginDiagnosticsByPluginId = params.pluginDiagnosticsByPluginId ?? params.registry.pluginDiagnosticsByPluginId;
    const familyDescriptors = [
        scmHostingProviderProjectionFamily,
        scmBackendProjectionFamily,
        managedDependenciesProjectionFamily,
        mcpProjectionFamily,
        pluginUiProjectionFamily,
        pluginBrowserProjectionFamily,
        ...(params.familyDescriptors ?? []),
    ];

    return {
        v: 2,
        generation: params.generation,
        installedPackagesById: buildInstalledPackagesById({
            registry: params.registry,
            installedPackages,
            pluginDiagnosticsByPluginId,
        }),
        providersById: buildProvidersById(params.registry),
        backendsById: buildBackendsById(params.registry),
        actionsById: buildActionsById(params.registry),
        toolsById: buildToolsById(params.registry),
        commandsById: buildCommandsById(params.registry),
        hooksById: buildHooksById(params.registry),
        resourcesById: buildResourcesById(params.registry),
        uiDescriptorsById: buildUiDescriptorsById(params.registry),
        settingsById: buildSettingsById(params.registry),
        familiesById: buildPluginProjectionFamiliesByIdV2({
            registry: params.registry,
            generation: params.generation,
            pluginUiHostRuntime: params.pluginUiHostRuntime,
        }, familyDescriptors),
        diagnostics: buildDiagnostics({
            installedPackages,
            pluginDiagnosticsByPluginId,
        }),
    };
}
