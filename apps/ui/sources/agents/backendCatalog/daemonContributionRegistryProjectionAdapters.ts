import type {
    PluginProjectedActionV2,
    PluginProjectedResourceV2,
    PluginProjectedUiDescriptorV2,
    PluginProjectionV2,
} from '@happier-dev/protocol';
import { AGENT_IDS, type AgentId } from '@happier-dev/agents';

import type {
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from './mergedProjectionTypes';

export type PluginProjectionDiagnostic = Readonly<{
    code: string;
    message: string;
    severity?: string | null;
}>;

export type PluginProjectionSurface =
    | 'settings'
    | 'setup'
    | 'status'
    | 'agentSettings'
    | 'providerSettings'
    | 'backendSettings';

export type PluginProjectionFieldKind =
    | 'text'
    | 'boolean'
    | 'enum'
    | 'secret'
    | 'number'
    | 'action'
    | 'unsupported';

export type PluginProjectionFieldOption = Readonly<{
    id: string;
    title: string;
    subtitle?: string | null;
}>;

export type PluginProjectionField = Readonly<{
    key: string;
    kind: PluginProjectionFieldKind;
    title: string;
    subtitle?: string | null;
    order?: number;
    groupId?: string | null;
    featureGate?: string | null;
    actionId?: string | null;
    value?: unknown;
    enumOptions?: readonly PluginProjectionFieldOption[];
}>;

export type PluginProjectionSection = Readonly<{
    id: string;
    title: string;
    footer?: string | null;
    order?: number;
    tone?: string | null;
    featureGate?: string | null;
    helpUrl?: string | null;
    fields: readonly PluginProjectionField[];
}>;

export type PluginProjectionAction = Readonly<{
    id: string;
    title: string;
    description: string | null;
    scopes: readonly string[];
    surfaces: readonly string[];
    placement: string;
    dangerLevel: string;
    available: boolean | null;
}>;

export type PluginProjectionResource = Readonly<{
    id: string;
    resourceKind: string;
    path: string;
    digest: string | null;
    contentType: string | null;
}>;

export type PluginProjectionEntry = Readonly<{
    pluginId: string;
    title: string;
    description: string | null;
    version: string | null;
    enabled: boolean | null;
    generation: number | null;
    generationLabel: string | null;
    status: Readonly<{
        label: string | null;
        detail: string | null;
        tone: string | null;
    }> | null;
    provenance: Readonly<{
        sourceKind: string | null;
        sourceLabel: string | null;
        trustPolicy: string | null;
        manifestDigest: string | null;
    }> | null;
    diagnostics: readonly PluginProjectionDiagnostic[];
    actions: readonly PluginProjectionAction[];
    resources: readonly PluginProjectionResource[];
    settingsSections: readonly PluginProjectionSection[];
    setupSections: readonly PluginProjectionSection[];
    statusSections: readonly PluginProjectionSection[];
    agentSettingsSections: readonly PluginProjectionSection[];
    providerSettingsSections: readonly PluginProjectionSection[];
    backendSettingsSections: readonly PluginProjectionSection[];
}>;

export type DaemonContributionRegistryProjection =
    | DaemonContributionRegistryProjectionV1Like
    | PluginProjectionV2;

export type DaemonContributionRegistryProjectionV1Like = Readonly<{
    v: 1;
    generationId?: string;
    providersById?: Readonly<Record<string, Readonly<{
        id?: string;
        title?: string;
        subtitle?: string;
        channel?: string;
        isBuiltIn?: boolean;
        settingsBackendId?: string;
        providerAgentId?: string;
        iconAgentId?: string;
    }> & Readonly<Record<string, unknown>>>>;
    backendsById?: Readonly<Record<string, Readonly<{
        id?: string;
        providerId: string;
        title?: string;
        subtitle?: string;
        providerAgentId?: string;
        iconAgentId?: string;
    }> & Readonly<Record<string, unknown>>>>;
    actionsById?: Readonly<Record<string, Readonly<{
        id?: string;
        pluginId?: string;
        title?: string;
        description?: string | null;
        safety?: string;
        surfaces?: Readonly<Record<string, boolean>>;
    }> & Readonly<Record<string, unknown>>>>;
    resourcesById?: Readonly<Record<string, Readonly<{
        id?: string;
        pluginId?: string;
        type?: string;
        path?: string;
        digest?: string | null;
        contentType?: string | null;
    }> & Readonly<Record<string, unknown>>>>;
    uiDescriptorsById?: Readonly<Record<string, Readonly<{
        id?: string;
        pluginId?: string;
        surface?: string;
        title?: string;
        description?: string | null;
        fields?: ReadonlyArray<Readonly<{
            id?: string;
            kind?: string;
            title?: string;
            description?: string | null;
            options?: ReadonlyArray<Readonly<{
                value?: string;
                label?: string;
            }>>;
        }>>;
    }> & Readonly<Record<string, unknown>>>>;
}>;

function readOptionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeProjectionFieldKind(kind: string | null): PluginProjectionFieldKind {
    switch (kind) {
    case 'text':
    case 'markdown':
        return 'text';
    case 'boolean':
        return 'boolean';
    case 'select':
    case 'enum':
        return 'enum';
    case 'secret':
        return 'secret';
    case 'number':
        return 'number';
    case 'action':
        return 'action';
    default:
        return 'unsupported';
    }
}

function createDescriptorSurfaceMaps(): Record<PluginProjectionSurface, Map<string, PluginProjectionSection[]>> {
    return {
        settings: new Map<string, PluginProjectionSection[]>(),
        setup: new Map<string, PluginProjectionSection[]>(),
        status: new Map<string, PluginProjectionSection[]>(),
        agentSettings: new Map<string, PluginProjectionSection[]>(),
        providerSettings: new Map<string, PluginProjectionSection[]>(),
        backendSettings: new Map<string, PluginProjectionSection[]>(),
    };
}

function pushDescriptorSection(
    surfaceMaps: Record<PluginProjectionSurface, Map<string, PluginProjectionSection[]>>,
    surface: PluginProjectionSurface,
    pluginId: string,
    section: PluginProjectionSection,
): void {
    const sections = surfaceMaps[surface].get(pluginId) ?? [];
    sections.push(section);
    surfaceMaps[surface].set(pluginId, sections);
}

function readDescriptorSections(
    surfaceMaps: Record<PluginProjectionSurface, Map<string, PluginProjectionSection[]>>,
    surface: PluginProjectionSurface,
    pluginId: string,
): readonly PluginProjectionSection[] {
    return surfaceMaps[surface].get(pluginId) ?? [];
}

function collectPluginIdsFromSurfaceMaps(
    surfaceMaps: Record<PluginProjectionSurface, Map<string, PluginProjectionSection[]>>,
): readonly string[] {
    return [
        ...surfaceMaps.settings.keys(),
        ...surfaceMaps.setup.keys(),
        ...surfaceMaps.status.keys(),
        ...surfaceMaps.agentSettings.keys(),
        ...surfaceMaps.providerSettings.keys(),
        ...surfaceMaps.backendSettings.keys(),
    ];
}

function normalizeV1DescriptorSurface(surface: string | null): PluginProjectionSurface {
    switch (surface) {
    case 'status':
        return 'status';
    case 'setup':
        return 'setup';
    case 'agentSettings':
        return 'agentSettings';
    case 'providerSettings':
        return 'providerSettings';
    case 'backendSettings':
        return 'backendSettings';
    default:
        return 'settings';
    }
}

function isPluginProjectionV2(
    projection: DaemonContributionRegistryProjection,
): projection is PluginProjectionV2 {
    return projection.v === 2;
}

function isProjectedAgentId(value: unknown): value is AgentId {
    return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}

function mapV2Action(action: PluginProjectedActionV2): PluginProjectionAction {
    return {
        id: action.id,
        title: action.title,
        description: action.description ?? null,
        scopes: action.scopes,
        surfaces: action.surfaces,
        placement: action.placement,
        dangerLevel: action.dangerLevel,
        available: typeof action.available === 'boolean' ? action.available : null,
    };
}

function mapV2Resource(resource: PluginProjectedResourceV2): PluginProjectionResource {
    return {
        id: resource.id,
        resourceKind: resource.resourceKind,
        path: resource.path,
        digest: resource.digest ?? null,
        contentType: resource.contentType ?? null,
    };
}

function mapV2DescriptorSection(descriptor: PluginProjectedUiDescriptorV2): PluginProjectionSection {
    const featureGate = descriptor.featureGate === undefined ? undefined : descriptor.featureGate;
    const helpUrl = descriptor.helpUrl === undefined ? undefined : descriptor.helpUrl;
    return {
        id: descriptor.id,
        title: descriptor.title,
        footer: descriptor.description ?? null,
        ...(typeof descriptor.order === 'number' ? { order: descriptor.order } : {}),
        ...(typeof descriptor.tone === 'string' ? { tone: descriptor.tone } : {}),
        ...(featureGate !== undefined ? { featureGate } : {}),
        ...(helpUrl !== undefined ? { helpUrl } : {}),
        fields: descriptor.fields.map((field) => ({
            key: field.id,
            kind: normalizeProjectionFieldKind(field.type),
            title: field.title,
            subtitle: field.description ?? null,
            ...(typeof field.order === 'number' ? { order: field.order } : {}),
            ...(field.groupId !== undefined ? { groupId: field.groupId } : {}),
            ...(field.featureGate !== undefined ? { featureGate: field.featureGate } : {}),
            ...(field.actionId !== undefined ? { actionId: field.actionId } : {}),
            enumOptions: field.options.map((option: { value: string; label: string }) => ({
                id: option.value,
                title: option.label,
            })),
        })),
    };
}

function buildV1PluginProjectionById(
    projection: DaemonContributionRegistryProjectionV1Like,
): Readonly<Record<string, PluginProjectionEntry>> {
    const actionsByPluginId = new Map<string, PluginProjectionAction[]>();
    for (const action of Object.values(projection.actionsById ?? {})) {
        const pluginId = readOptionalString(action.pluginId);
        const actionId = readOptionalString(action.id);
        const title = readOptionalString(action.title);
        if (!pluginId || !actionId || !title) continue;
        const actions = actionsByPluginId.get(pluginId) ?? [];
        actions.push({
            id: actionId,
            title,
            description: readOptionalString(action.description),
            scopes: [],
            surfaces: Object.entries(action.surfaces ?? {})
                .filter((entry): entry is [string, boolean] => entry[1] === true)
                .map(([surface]) => surface),
            placement: 'detailsPanel',
            dangerLevel: readOptionalString(action.safety) ?? 'safe',
            available: null,
        });
        actionsByPluginId.set(pluginId, actions);
    }

    const resourcesByPluginId = new Map<string, PluginProjectionResource[]>();
    for (const resource of Object.values(projection.resourcesById ?? {})) {
        const pluginId = readOptionalString(resource.pluginId);
        const resourceId = readOptionalString(resource.id);
        const resourceKind = readOptionalString(resource.type);
        const path = readOptionalString(resource.path);
        if (!pluginId || !resourceId || !resourceKind || !path) continue;
        const resources = resourcesByPluginId.get(pluginId) ?? [];
        resources.push({
            id: resourceId,
            resourceKind,
            path,
            digest: readOptionalString(resource.digest),
            contentType: readOptionalString(resource.contentType),
        });
        resourcesByPluginId.set(pluginId, resources);
    }

    const surfaceMaps = createDescriptorSurfaceMaps();
    for (const descriptor of Object.values(projection.uiDescriptorsById ?? {})) {
        const pluginId = readOptionalString(descriptor.pluginId);
        const descriptorId = readOptionalString(descriptor.id);
        const title = readOptionalString(descriptor.title);
        if (!pluginId || !descriptorId || !title) continue;
        const section: PluginProjectionSection = {
            id: descriptorId,
            title,
            footer: readOptionalString(descriptor.description),
            fields: Array.isArray(descriptor.fields)
                ? descriptor.fields.flatMap((field) => {
                    const key = readOptionalString(field.id);
                    const kind = normalizeProjectionFieldKind(readOptionalString(field.kind));
                    const fieldTitle = readOptionalString(field.title);
                    if (!key || !fieldTitle) return [];
                    return [{
                        key,
                        kind,
                        title: fieldTitle,
                        subtitle: readOptionalString(field.description),
                        enumOptions: Array.isArray(field.options)
                            ? field.options.flatMap((option: unknown): PluginProjectionFieldOption[] => {
                                const record = option && typeof option === 'object' ? option as { value?: unknown; label?: unknown } : null;
                                const id = readOptionalString(record?.value);
                                const optionTitle = readOptionalString(record?.label);
                                if (!id || !optionTitle) return [];
                                return [{ id, title: optionTitle }];
                            })
                            : [],
                    }];
                })
                : [],
        };
        pushDescriptorSection(surfaceMaps, normalizeV1DescriptorSurface(readOptionalString(descriptor.surface)), pluginId, section);
    }

    const pluginIds = new Set<string>([
        ...actionsByPluginId.keys(),
        ...resourcesByPluginId.keys(),
        ...collectPluginIdsFromSurfaceMaps(surfaceMaps),
    ]);

    const entries: Record<string, PluginProjectionEntry> = {};
    for (const pluginId of pluginIds) {
        entries[pluginId] = {
            pluginId,
            title: pluginId,
            description: null,
            version: null,
            enabled: null,
            generation: null,
            generationLabel: readOptionalString(projection.generationId),
            status: null,
            provenance: null,
            diagnostics: [],
            actions: actionsByPluginId.get(pluginId) ?? [],
            resources: resourcesByPluginId.get(pluginId) ?? [],
            settingsSections: readDescriptorSections(surfaceMaps, 'settings', pluginId),
            setupSections: readDescriptorSections(surfaceMaps, 'setup', pluginId),
            statusSections: readDescriptorSections(surfaceMaps, 'status', pluginId),
            agentSettingsSections: readDescriptorSections(surfaceMaps, 'agentSettings', pluginId),
            providerSettingsSections: readDescriptorSections(surfaceMaps, 'providerSettings', pluginId),
            backendSettingsSections: readDescriptorSections(surfaceMaps, 'backendSettings', pluginId),
        };
    }

    return entries;
}

function buildV2PluginProjectionById(
    projection: PluginProjectionV2,
): Readonly<Record<string, PluginProjectionEntry>> {
    const actionsByPluginId = new Map<string, PluginProjectionAction[]>();
    for (const action of Object.values(projection.actionsById)) {
        const actions = actionsByPluginId.get(action.pluginId) ?? [];
        actions.push(mapV2Action(action));
        actionsByPluginId.set(action.pluginId, actions);
    }

    const resourcesByPluginId = new Map<string, PluginProjectionResource[]>();
    for (const resource of Object.values(projection.resourcesById)) {
        const resources = resourcesByPluginId.get(resource.pluginId) ?? [];
        resources.push(mapV2Resource(resource));
        resourcesByPluginId.set(resource.pluginId, resources);
    }

    const surfaceMaps = createDescriptorSurfaceMaps();
    for (const descriptor of Object.values(projection.uiDescriptorsById)) {
        const section = mapV2DescriptorSection(descriptor);
        pushDescriptorSection(surfaceMaps, descriptor.surface, descriptor.pluginId, section);
    }

    const diagnosticsByPluginId = new Map<string, PluginProjectionDiagnostic[]>();
    for (const diagnostic of projection.diagnostics) {
        if (!diagnostic.pluginId) continue;
        const diagnostics = diagnosticsByPluginId.get(diagnostic.pluginId) ?? [];
        diagnostics.push({
            code: diagnostic.code,
            message: diagnostic.message,
            severity: diagnostic.severity,
        });
        diagnosticsByPluginId.set(diagnostic.pluginId, diagnostics);
    }

    const entries: Record<string, PluginProjectionEntry> = {};
    for (const [pluginId, installedPackage] of Object.entries(projection.installedPackagesById)) {
        entries[pluginId] = {
            pluginId,
            title: installedPackage.displayName,
            description: null,
            version: installedPackage.version ?? null,
            enabled: installedPackage.enabled,
            generation: projection.generation,
            generationLabel: String(projection.generation),
            status: null,
            provenance: {
                sourceKind: installedPackage.source.kind,
                sourceLabel: installedPackage.source.locator,
                trustPolicy: null,
                manifestDigest: installedPackage.digest ?? null,
            },
            diagnostics: diagnosticsByPluginId.get(pluginId) ?? [],
            actions: actionsByPluginId.get(pluginId) ?? [],
            resources: resourcesByPluginId.get(pluginId) ?? [],
            settingsSections: readDescriptorSections(surfaceMaps, 'settings', pluginId),
            setupSections: readDescriptorSections(surfaceMaps, 'setup', pluginId),
            statusSections: readDescriptorSections(surfaceMaps, 'status', pluginId),
            agentSettingsSections: readDescriptorSections(surfaceMaps, 'agentSettings', pluginId),
            providerSettingsSections: readDescriptorSections(surfaceMaps, 'providerSettings', pluginId),
            backendSettingsSections: readDescriptorSections(surfaceMaps, 'backendSettings', pluginId),
        };
    }
    return entries;
}

function readV2RegistryDiagnostics(
    projection: PluginProjectionV2,
): readonly PluginProjectionDiagnostic[] {
    return projection.diagnostics.flatMap((diagnostic) => {
        if (diagnostic.pluginId) return [];
        return [{
            code: diagnostic.code,
            message: diagnostic.message,
            severity: diagnostic.severity,
        }];
    });
}

export function adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(
    projection: DaemonContributionRegistryProjection,
): Readonly<{
    mergedProviderProjectionById: Readonly<Record<string, MergedProviderProjectionEntry>>;
    mergedBackendProjectionById: Readonly<Record<string, MergedBackendProjectionEntry>>;
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
    registryDiagnostics: readonly PluginProjectionDiagnostic[];
}> {
    const mergedProviderProjectionById: Record<string, MergedProviderProjectionEntry> = {};
    const mergedBackendProjectionById: Record<string, MergedBackendProjectionEntry> = {};

    for (const [providerId, entry] of Object.entries(projection.providersById ?? {})) {
        mergedProviderProjectionById[providerId] = {
            providerId,
            title: entry.title ?? null,
            subtitle: entry.subtitle ?? null,
            channel: entry.channel === 'stable' || entry.channel === 'experimental' || entry.channel === 'plugin'
                ? entry.channel
                : null,
            isBuiltIn: entry.isBuiltIn ?? undefined,
            settingsBackendId: typeof entry.settingsBackendId === 'string' && entry.settingsBackendId.trim().length > 0
                ? entry.settingsBackendId.trim()
                : null,
            providerAgentId: isProjectedAgentId(entry.providerAgentId) ? entry.providerAgentId : null,
            iconAgentId: isProjectedAgentId(entry.iconAgentId) ? entry.iconAgentId : null,
        };
    }

    for (const [backendId, entry] of Object.entries(projection.backendsById ?? {})) {
        mergedBackendProjectionById[backendId] = {
            backendId,
            providerId: entry.providerId,
            title: entry.title ?? null,
            subtitle: entry.subtitle ?? null,
            providerAgentId: isProjectedAgentId(entry.providerAgentId) ? entry.providerAgentId : null,
            iconAgentId: isProjectedAgentId(entry.iconAgentId) ? entry.iconAgentId : null,
        };
    }

    return {
        mergedProviderProjectionById,
        mergedBackendProjectionById,
        pluginProjectionById: isPluginProjectionV2(projection)
            ? buildV2PluginProjectionById(projection)
            : buildV1PluginProjectionById(projection),
        registryDiagnostics: isPluginProjectionV2(projection)
            ? readV2RegistryDiagnostics(projection)
            : [],
    };
}
