import type {
    PluginDiagnosticRecordV1,
    PluginProjectedSettingsFieldV2,
    PluginProjectionInstalledPackageV2,
    PluginProjectionV2,
    PluginSettingFieldSchemaV2,
    PluginSettingFieldV2,
} from '@happier-dev/protocol';
import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    PluginResourceKindV2Schema,
} from '@happier-dev/protocol';

import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type {
    ResolvedActionContribution,
    ResolvedContributionRegistry,
    ResolvedContributionProvenance,
    ResolvedContributionSource,
    ResolvedContributionSourceKind,
    ResolvedAgentContribution,
} from '../types';
import {
    buildPluginProjectionFamiliesByIdV2,
} from '@/plugins/projection/families';
import { managedDependenciesProjectionFamily } from '../managedDependencies';
import { mcpProjectionFamily } from '../mcp';
import { scmBackendProjectionFamily } from '../scmBackends';
import { scmHostingProviderProjectionFamily } from '../scmHostingProviders';
import {
    pluginUiProjectionFamily,
    type PluginUiProjectionHostRuntimeContext,
} from '../ui/projection';
import { pluginBrowserProjectionFamily } from '../browser';
import { providerProjectionFamily } from '../providers';
import { connectedAccountProjectionFamily } from '../connectedAccounts';
import { voiceModelPackProjectionFamily, voiceProviderProjectionFamily } from '../voiceDeclarations';
import { projectPluginContributionIntrospection } from '@/plugins/projection/introspection/project';
import type { PluginTargetActivationIntrospectionSnapshot } from '@/plugins/projection/introspection/targetActivationFacts';
import {
    PluginLocalSettingsDeclarationError,
    resolveLocalSettingsDeclarations,
} from '@/plugins/settings/localSettingsContributions';
import { resolveNotificationChannelSettingsContributions } from '@/plugins/settings/notificationChannelSettings';

function readOptionalString(value: unknown): string | undefined {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : undefined;
}

function readLocalizedText(value: unknown): string | undefined {
    if (typeof value === 'string') return readOptionalString(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return readOptionalString((value as Readonly<{ fallback?: unknown }>).fallback);
}

function qualifiedProjectionKey(pluginId: string, localId: string): string {
    return buildQualifiedPluginContributionKey(createPluginContributionIdentity({ pluginId, localId }));
}

function readAgentTitle(agent: ResolvedAgentContribution): string | undefined {
    const rich = agent.richDefinition;
    if (!rich || rich.provenance !== 'external') return undefined;
    return readLocalizedText(rich.definition.title);
}

function readAgentSubtitle(agent: ResolvedAgentContribution): string | undefined {
    const rich = agent.richDefinition;
    if (!rich || rich.provenance !== 'external') return undefined;
    return readLocalizedText(rich.definition.description);
}

function readAgentProjectionDefinition(
    agent: ResolvedAgentContribution,
): Readonly<Record<string, unknown>> {
    return (agent.richDefinition?.definition ?? agent.definition) as Readonly<Record<string, unknown>>;
}

function readAgentProjectionCatalogAgentId(
    definition: Readonly<Record<string, unknown>>,
): string | undefined {
    return readOptionalString(definition.catalogAgentId);
}

function readAgentProviderOwnedEnvironmentKeys(
    definition: Readonly<Record<string, unknown>>,
): readonly string[] {
    const providerRequirements = definition.providerRequirements;
    if (!providerRequirements || typeof providerRequirements !== 'object' || Array.isArray(providerRequirements)) return [];
    const authIsolation = Reflect.get(providerRequirements, 'authIsolation');
    if (!authIsolation || typeof authIsolation !== 'object' || Array.isArray(authIsolation)) return [];
    const ownedEnvKeys = Reflect.get(authIsolation, 'ownedEnvKeys');
    return Array.isArray(ownedEnvKeys)
        ? ownedEnvKeys.filter((key): key is string => typeof key === 'string')
        : [];
}

function projectAgentStartupInstructionsCapability(
    agent: ResolvedAgentContribution,
): PluginProjectionV2['agentsById'][string]['capabilities'] {
    const capabilities = agent.richDefinition?.definition.capabilities;
    const sessions = capabilities && 'sessions' in capabilities
        ? capabilities.sessions
        : undefined;
    return sessions?.startupInstructions?.versions[0] === 1
        ? { sessions: { startupInstructions: { versions: [1] } } }
        : undefined;
}

function projectAgentExternalSessions(
    agent: ResolvedAgentContribution,
    generation: number,
): PluginProjectionV2['agentsById'][string]['externalSessions'] {
    const identity = agent.identity;
    const definition = agent.richDefinition?.definition;
    const surfaces = definition?.capabilities.surfaces ?? [];
    const sources = definition?.surfaces?.externalSession?.sources ?? [];
    if (
        !identity
        || !surfaces.includes('externalSessions')
        || sources.length === 0
    ) {
        return undefined;
    }
    return {
        agent: identity,
        generation,
        operations: {
            listCandidates: true,
            resolveLinkIdentity: true,
            pageTranscript: true,
            readAfterTranscript: true,
        },
        sources: sources.map((source) => {
            const { instances, ...declaration } = source;
            return {
                ...declaration,
                schema: {
                    ...source.schema,
                    fields: source.schema.fields.map((field) => ({ ...field })),
                },
                key: {
                    segments: source.key.segments.map((segment) => ({ ...segment })),
                },
                ...(instances
                    ? {
                        instances: instances.map((instance) => (
                            instance.kind === 'connectedServiceProfiles'
                                ? {
                                    kind: instance.kind,
                                    serviceId: instance.serviceId,
                                    constants: { ...(instance.constants ?? {}) },
                                    fields: { ...instance.fields },
                                }
                                : {
                                    kind: instance.kind,
                                    constants: { ...(instance.constants ?? {}) },
                                }
                        )),
                    }
                    : {}),
            };
        }),
    };
}

function resolveActionSurfaces(
    surfaces: Readonly<Record<string, unknown>>,
): ('agent' | 'mcp' | 'cli' | 'ui')[] {
    const projected = new Set<'agent' | 'mcp' | 'cli' | 'ui'>();
    if (surfaces.cli === true) {
        projected.add('cli');
    }
    if (surfaces.mcp === true) {
        projected.add('mcp');
    }
    if (surfaces.agent === true) {
        projected.add('agent');
    }
    if (surfaces.ui === true) {
        projected.add('ui');
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

    for (const agent of registry.agents) {
        upsert({
            provenance: agent.provenance,
            source: agent.source,
            pluginId: agent.pluginId,
            manifestPath: agent.manifestPath,
            manifestDigest: agent.manifestDigest,
            sourceSpec: agent.sourceSpec,
            displayName: readAgentTitle(agent),
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
    for (const target of registry.browserTargets ?? []) {
        upsert(target);
    }
    for (const action of registry.browserActions ?? []) {
        upsert(action);
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
            displayName: readLocalizedText(provider.definition.title),
        });
    }
    for (const dependency of registry.managedDependencies ?? []) {
        const title = 'key' in dependency.definition
            ? dependency.definition.display.name
            : typeof dependency.definition.title === 'string'
                ? dependency.definition.title
                : dependency.definition.title.fallback;
        upsert({
            provenance: dependency.provenance,
            source: dependency.source,
            pluginId: dependency.pluginId,
            manifestPath: dependency.manifestPath,
            manifestDigest: dependency.manifestDigest,
            sourceSpec: dependency.sourceSpec,
            displayName: title,
        });
    }
    for (const systemTool of registry.systemTools ?? []) {
        const title = typeof systemTool.definition.title === 'string'
            ? systemTool.definition.title
            : systemTool.definition.title.fallback;
        upsert({
            provenance: systemTool.provenance,
            source: systemTool.source,
            pluginId: systemTool.pluginId,
            manifestPath: systemTool.manifestPath,
            manifestDigest: systemTool.manifestDigest,
            sourceSpec: systemTool.sourceSpec,
            displayName: title,
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

function buildDiagnostics(params: Readonly<{
    installedPackages: readonly PluginCatalogEntry[];
    diagnosticRecords: readonly PluginDiagnosticRecordV1[];
}>): PluginDiagnosticRecordV1[] {
    return [
        ...params.installedPackages.flatMap((entry) => entry.contributionIntrospection.diagnostics),
        ...params.diagnosticRecords,
    ];
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

function buildAgentsById(
    registry: ResolvedContributionRegistry,
    generation: number,
): PluginProjectionV2['agentsById'] {
    const agentsById: PluginProjectionV2['agentsById'] = {};
    for (const agent of registry.agents) {
        const identity = agent.identity;
        if (!identity) {
            throw new Error(`Agent '${agent.id}' is missing its manifest-qualified identity`);
        }
        const projectionDefinition = readAgentProjectionDefinition(agent);
        const externalSessions = projectAgentExternalSessions(agent, generation);
        const capabilities = projectAgentStartupInstructionsCapability(agent);
        agentsById[agent.id] = {
            id: agent.id,
            identity,
            title: readAgentTitle(agent),
            subtitle: readAgentSubtitle(agent),
            channel: agent.provenance === 'external' ? 'plugin' : undefined,
            isBuiltIn: agent.provenance === 'first_party',
            settingsBackendId: readOptionalString(projectionDefinition.settingsBackendId),
            catalogAgentId: readAgentProjectionCatalogAgentId(projectionDefinition),
            iconAgentId: readOptionalString(projectionDefinition.iconAgentId),
            providerOwnedEnvironmentKeys: [...readAgentProviderOwnedEnvironmentKeys(projectionDefinition)],
            ...(capabilities ? { capabilities } : {}),
            ...(agent.cliMetadata ? { cli: agent.cliMetadata } : {}),
            ...(externalSessions ? { externalSessions } : {}),
        };
    }
    return agentsById;
}

function buildActionsById(
    registry: ResolvedContributionRegistry,
): PluginProjectionV2['actionsById'] {
    const actionsById: PluginProjectionV2['actionsById'] = {};
    for (const action of registry.actions) {
        if (!action.pluginId) {
            continue;
        }
        actionsById[qualifiedProjectionKey(action.pluginId, action.definition.id)] = {
            id: action.definition.id,
            pluginId: action.pluginId,
            title: action.definition.title,
            description: readOptionalString(action.definition.description),
            scopes: resolveActionScopes(action),
            surfaces: resolveActionSurfaces(action.definition.surfaces),
            placement: 'detailsPanel',
            dangerLevel: action.definition.dangerLevel,
            ...(action.definition.confirmation
                ? { confirmation: action.definition.confirmation }
                : {}),
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
        toolsById[qualifiedProjectionKey(tool.pluginId, tool.definition.id)] = {
            id: tool.definition.id,
            pluginId: tool.pluginId,
            title: readLocalizedText(tool.definition.title) ?? tool.definition.id,
            description: readLocalizedText(tool.definition.description),
            exposesToAgent: tool.definition.surfaces.includes('mcp') || tool.definition.surfaces.includes('agent'),
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
        commandsById[qualifiedProjectionKey(command.pluginId, command.definition.id)] = {
            id: command.definition.id,
            pluginId: command.pluginId,
            title: readLocalizedText(command.definition.title) ?? command.definition.id,
            description: readLocalizedText(command.definition.description),
            surfaces: ['cli'],
            tokens: command.definition.path,
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
        const resourceKind = PluginResourceKindV2Schema.safeParse(resource.definition.type);
        if (!resourceKind.success) {
            throw new Error(
                `Invalid resource kind for '${resource.pluginId}/${resource.definition.id}'`,
            );
        }
        const key = qualifiedProjectionKey(resource.pluginId, resource.definition.id);
        resourcesById[key] = {
            id: resource.definition.id,
            pluginId: resource.pluginId,
            resourceKind: resourceKind.data,
            path: resource.definition.path ?? resource.definition.id,
            digest: readOptionalString(resource.definition.digest),
            contentType: readOptionalString(resource.definition.contentType),
        };
    }
    return resourcesById;
}

type ProjectedSettingsValueType = NonNullable<PluginProjectedSettingsFieldV2['valueSchema']['type']>;

const ALL_PROJECTED_SETTINGS_VALUE_TYPES: readonly ProjectedSettingsValueType[] = [
    'null',
    'boolean',
    'number',
    'integer',
    'string',
    'array',
    'object',
];

export class PluginSettingsProjectionError extends Error {
    readonly code = 'PLUGIN_SETTINGS_PROJECTION_INVALID' as const;

    constructor(
        message: string,
        readonly pluginId: string,
        readonly contributionId: string,
        readonly fieldId: string | null,
    ) {
        super(message);
        this.name = 'PluginSettingsProjectionError';
    }
}

function invalidSettingsProjection(params: Readonly<{
    pluginId: string;
    contributionId: string;
    fieldId?: string | null;
    reason: string;
}>): PluginSettingsProjectionError {
    const fieldContext = params.fieldId ? ` field '${params.fieldId}'` : '';
    return new PluginSettingsProjectionError(
        `Cannot project settings contribution '${params.pluginId}/${params.contributionId}'${fieldContext}: ${params.reason}`,
        params.pluginId,
        params.contributionId,
        params.fieldId ?? null,
    );
}

function intersectSettingsValueTypes(
    left: ReadonlySet<ProjectedSettingsValueType>,
    right: ReadonlySet<ProjectedSettingsValueType>,
): Set<ProjectedSettingsValueType> {
    return new Set([...left].filter((type) => right.has(type)));
}

function resolvePossibleSettingsValueTypes(
    schema: PluginSettingFieldSchemaV2,
): Set<ProjectedSettingsValueType> {
    let possibleTypes = new Set<ProjectedSettingsValueType>(
        schema.type ? [schema.type] : ALL_PROJECTED_SETTINGS_VALUE_TYPES,
    );

    if (schema.anyOf) {
        const alternativeTypes = new Set<ProjectedSettingsValueType>();
        for (const alternative of schema.anyOf) {
            for (const type of resolvePossibleSettingsValueTypes(alternative)) {
                alternativeTypes.add(type);
            }
        }
        possibleTypes = intersectSettingsValueTypes(possibleTypes, alternativeTypes);
    }

    if (schema.oneOf) {
        const alternativeTypeCounts = new Map<ProjectedSettingsValueType, number>();
        for (const alternative of schema.oneOf) {
            for (const type of resolvePossibleSettingsValueTypes(alternative)) {
                alternativeTypeCounts.set(type, (alternativeTypeCounts.get(type) ?? 0) + 1);
            }
        }
        const exclusiveAlternativeTypes = new Set<ProjectedSettingsValueType>(
            [...alternativeTypeCounts]
                .filter(([, count]) => count === 1)
                .map(([type]) => type),
        );
        possibleTypes = intersectSettingsValueTypes(possibleTypes, exclusiveAlternativeTypes);
    }

    for (const constraint of schema.allOf ?? []) {
        possibleTypes = intersectSettingsValueTypes(
            possibleTypes,
            resolvePossibleSettingsValueTypes(constraint),
        );
    }

    return possibleTypes;
}

function resolveProjectedSettingsValueType(params: Readonly<{
    pluginId: string;
    contributionId: string;
    fieldId: string;
    schema: PluginSettingFieldSchemaV2;
    control?: 'auto' | 'text' | 'textarea' | 'switch' | 'select' | 'multiSelect' | 'number' | 'json';
}>): ProjectedSettingsValueType {
    const valueTypes = [...resolvePossibleSettingsValueTypes(params.schema)];
    if (valueTypes.length === 1) {
        return valueTypes[0]!;
    }
    if (
        params.control === 'number'
        && valueTypes.every((type) => type === 'number' || type === 'integer' || type === 'null')
    ) {
        return valueTypes.includes('integer') ? 'integer' : 'number';
    }
    if (params.control === 'json') {
        return 'object';
    }

    throw invalidSettingsProjection({
        pluginId: params.pluginId,
        contributionId: params.contributionId,
        fieldId: params.fieldId,
        reason: valueTypes.length === 0
            ? 'schema accepts no declared value types'
            : `schema can accept multiple value types (${valueTypes.sort().join(', ')})`,
    });
}

function projectSettingsField(params: Readonly<{
    pluginId: string;
    contributionId: string;
    field: PluginSettingFieldV2;
}>): PluginProjectedSettingsFieldV2 {
    const valueType = resolveProjectedSettingsValueType({
        pluginId: params.pluginId,
        contributionId: params.contributionId,
        fieldId: params.field.id,
        schema: params.field.schema,
        control: params.field.presentation?.control,
    });
    if (params.field.secret === true && valueType !== 'string') {
        throw invalidSettingsProjection({
            pluginId: params.pluginId,
            contributionId: params.contributionId,
            fieldId: params.field.id,
            reason: `secret fields must resolve to string, received '${valueType}'`,
        });
    }
    const requestedControl = params.field.presentation?.control;
    const control: PluginProjectedSettingsFieldV2['control'] = params.field.secret === true
        ? 'password'
        : requestedControl && requestedControl !== 'auto'
            ? requestedControl
            : valueType === 'boolean'
                ? 'switch'
                : valueType === 'string'
                    ? 'text'
                    : valueType === 'number' || valueType === 'integer'
                        ? 'number'
                        : 'json';
    const displayKey = readLocalizedText(params.field.title);
    if (!displayKey) {
        throw invalidSettingsProjection({
            pluginId: params.pluginId,
            contributionId: params.contributionId,
            fieldId: params.field.id,
            reason: 'title has no displayable text',
        });
    }
    const descriptionKey = readLocalizedText(params.field.description);

    return {
        id: params.field.id,
        kind: 'settings.field',
        version: '1.0.0',
        valueSchema: params.field.schema,
        valueType,
        control,
        displayKey,
        ...(descriptionKey ? { descriptionKey } : {}),
        ...(params.field.presentation ? { presentation: params.field.presentation } : {}),
        ...(params.field.availability ? { availability: params.field.availability } : {}),
        ...(params.field.analytics ? { analytics: params.field.analytics } : {}),
        ...(params.field.presentation?.order !== undefined
            ? { order: params.field.presentation.order }
            : {}),
        capabilityGates: [],
        permissionGates: [],
        redaction: params.field.secret === true ? 'secret' : 'none',
        clearWhenEmpty: params.field.secret === true ? 'omit' : 'persist',
        ...(valueType === 'boolean' && typeof params.field.default === 'boolean'
            ? { defaultBooleanValue: params.field.default }
            : {}),
        ...(params.field.secret !== true && params.field.default !== undefined
            ? { defaultValue: params.field.default }
            : {}),
    };
}

function buildSettingsById(
    registry: ResolvedContributionRegistry,
): PluginProjectionV2['settingsById'] {
    const settingsById: PluginProjectionV2['settingsById'] = {};
    let declarations;
    try {
        declarations = resolveLocalSettingsDeclarations({
            settings: [
                ...(registry.settings ?? []),
                ...resolveNotificationChannelSettingsContributions(registry.notificationChannels ?? []),
            ],
        });
    } catch (error) {
        if (!(error instanceof PluginLocalSettingsDeclarationError)) throw error;
        throw invalidSettingsProjection({
            pluginId: error.pluginId,
            contributionId: error.contributionId,
            ...(error.fieldId ? { fieldId: error.fieldId } : {}),
            reason: error.reason,
        });
    }
    for (const declaration of declarations) {
        settingsById[qualifiedProjectionKey(declaration.pluginId, declaration.definition.id)] = {
            id: declaration.definition.id,
            pluginId: declaration.pluginId,
            version: declaration.definition.version,
            title: readLocalizedText(declaration.definition.title) ?? declaration.definition.id,
            ...(declaration.definition.description
                ? { description: readLocalizedText(declaration.definition.description) }
                : {}),
            storageScope: declaration.definition.scope,
            presentation: declaration.definition.presentation,
            target: declaration.definition.target.kind === 'plugin'
                ? { kind: 'plugin' }
                : {
                    kind: 'agent',
                    agent: typeof declaration.definition.target.agent === 'string'
                        ? { pluginId: declaration.pluginId, localId: declaration.definition.target.agent }
                        : declaration.definition.target.agent,
                },
            fields: declaration.definition.fields.map((field) => {
                const projected = projectSettingsField({
                    pluginId: declaration.pluginId,
                    contributionId: declaration.definition.id,
                    field,
                });
                const groupId = declaration.definition.presentation.sections.find((section) => (
                    section.fields.includes(field.id)
                ))?.id;
                return groupId ? { ...projected, groupId } : projected;
            }),
        };
    }
    return settingsById;
}

export function buildPluginProjectionV2(params: Readonly<{
    registry: ResolvedContributionRegistry;
    generation: number;
    installedPackages?: readonly PluginCatalogEntry[];
    pluginDiagnosticsByPluginId?: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    pluginUiHostRuntime?: PluginUiProjectionHostRuntimeContext;
    introspectionRuntimeSnapshot?: PluginTargetActivationIntrospectionSnapshot;
    scmRuntimeAvailability?: Readonly<{
        backendIds: ReadonlySet<string>;
        hostingProviderIds: ReadonlySet<string>;
    }>;
}>): PluginProjectionV2 {
    const installedPackages = params.installedPackages ?? [];
    const pluginDiagnosticsByPluginId = params.pluginDiagnosticsByPluginId ?? params.registry.pluginDiagnosticsByPluginId;
    if (params.introspectionRuntimeSnapshot && params.introspectionRuntimeSnapshot.generation !== params.generation) {
        throw new Error(
            `Introspection runtime generation '${params.introspectionRuntimeSnapshot.generation}' does not match projection generation '${params.generation}'`,
        );
    }
    const runtimeDiagnosticRecords = params.introspectionRuntimeSnapshot?.diagnosticRecords ?? [];
    const familyDescriptors = [
        providerProjectionFamily,
        connectedAccountProjectionFamily,
        scmHostingProviderProjectionFamily,
        scmBackendProjectionFamily,
        managedDependenciesProjectionFamily,
        mcpProjectionFamily,
        pluginUiProjectionFamily,
        pluginBrowserProjectionFamily,
        voiceModelPackProjectionFamily,
        voiceProviderProjectionFamily,
    ];

    return {
        v: 2,
        generation: params.generation,
        installedPackagesById: buildInstalledPackagesById({
            registry: params.registry,
            installedPackages,
            pluginDiagnosticsByPluginId,
        }),
        agentsById: buildAgentsById(params.registry, params.generation),
        // The V2 wire field remains for mixed-version readers, but the host no
        // longer projects a parallel backend/runtime registry.
        backendsById: {},
        actionsById: buildActionsById(params.registry),
        toolsById: buildToolsById(params.registry),
        commandsById: buildCommandsById(params.registry),
        resourcesById: buildResourcesById(params.registry),
        settingsById: buildSettingsById(params.registry),
        familiesById: buildPluginProjectionFamiliesByIdV2({
            registry: params.registry,
            generation: params.generation,
            pluginUiHostRuntime: params.pluginUiHostRuntime,
            scmRuntimeAvailability: params.scmRuntimeAvailability,
        }, familyDescriptors),
        contributionIntrospection: projectPluginContributionIntrospection({
            generation: params.generation,
            candidates: params.registry.introspectionContributions ?? [],
            diagnostics: buildDiagnostics({
                installedPackages,
                diagnosticRecords: runtimeDiagnosticRecords,
            }),
            runtimeFactsByQualifiedId: params.introspectionRuntimeSnapshot?.runtimeFactsByQualifiedId,
        }),
        diagnostics: buildDiagnostics({
            installedPackages,
            diagnosticRecords: runtimeDiagnosticRecords,
        }),
    };
}
