import type {
    PluginActionConfirmationV2,
    PluginProjectedActionV2,
    PluginProjectedResourceV2,
    PluginProjectedSettingsFieldV2,
    PluginProjectedSettingsV2,
    PluginProjectionV2,
} from '@happier-dev/protocol';
import { AGENT_IDS, type AgentId } from '@happier-dev/agents';

import type {
    MergedBackendCapabilities,
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from './mergedProjectionTypes';

export type PluginProjectionDiagnostic = Readonly<{
    code: string;
    message: string;
    severity?: string | null;
}>;

export type PluginProjectionEditableSettingControl =
    | 'auto'
    | 'text'
    | 'password'
    | 'textarea'
    | 'switch'
    | 'select'
    | 'multiSelect'
    | 'number'
    | 'json';

export type PluginProjectionEditableSettingValueType =
    | 'string'
    | 'boolean'
    | 'number'
    | 'integer'
    | 'object'
    | 'array'
    | 'null';

export type PluginProjectionEditableSettingField = Readonly<{
    key: string;
    control: PluginProjectionEditableSettingControl;
    valueType: PluginProjectionEditableSettingValueType;
    valueSchema: PluginProjectedSettingsFieldV2['valueSchema'];
    title: string;
    subtitle?: string | null;
    order?: number;
    groupId?: string | null;
    redaction: string;
    clearWhenEmpty: string;
    defaultBooleanValue?: boolean;
    defaultValue?: PluginProjectedSettingsFieldV2['defaultValue'];
    presentation?: PluginProjectedSettingsFieldV2['presentation'];
    availability?: PluginProjectedSettingsFieldV2['availability'];
    analytics?: PluginProjectedSettingsFieldV2['analytics'];
}>;

export type PluginProjectionEditableSettingsGroup = Readonly<{
    id: string;
    pluginId: string;
    version: 1;
    title: string;
    description?: string | null;
    storageScope: 'local' | 'synced' | 'project' | 'session';
    presentation: PluginProjectedSettingsV2['presentation'];
    target:
        | Readonly<{ kind: 'plugin' }>
        | Readonly<{ kind: 'agent'; agent: Readonly<{ pluginId: string; localId: string }> }>;
    fields: readonly PluginProjectionEditableSettingField[];
}>;

export type PluginProjectionAction = Readonly<{
    id: string;
    title: string;
    description: string | null;
    scopes: readonly string[];
    surfaces: readonly string[];
    placement: string;
    dangerLevel: PluginProjectedActionV2['dangerLevel'];
    confirmation: PluginActionConfirmationV2 | null;
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
    editableSettingsGroups: readonly PluginProjectionEditableSettingsGroup[];
}>;

export type DaemonContributionRegistryProjection =
    | DaemonContributionRegistryProjectionV1Like
    | PluginProjectionV2;

export type DaemonContributionRegistryProjectionV1Like = Readonly<{
    v: 1;
    generationId?: string;
    agentsById?: Readonly<Record<string, Readonly<{
        id?: string;
        title?: string;
        subtitle?: string;
        channel?: string;
        isBuiltIn?: boolean;
        settingsBackendId?: string;
        catalogAgentId?: string;
        iconAgentId?: string;
    }> & Readonly<Record<string, unknown>>>>;
    backendsById?: Readonly<Record<string, Readonly<{
        id?: string;
        agentId: string;
        title?: string;
        subtitle?: string;
        catalogAgentId?: string;
        iconAgentId?: string;
        capabilities?: MergedBackendCapabilities;
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
}>;

function readOptionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
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
        confirmation: action.confirmation ?? null,
        available: typeof action.available === 'boolean' ? action.available : null,
    };
}

function mapV1ActionDangerLevel(safety: unknown): PluginProjectedActionV2['dangerLevel'] {
    return readOptionalString(safety) === 'safe' ? 'safe' : 'writesLocal';
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

function mapV2EditableSettingsField(field: PluginProjectedSettingsFieldV2): PluginProjectionEditableSettingField {
    return {
        key: field.id,
        control: field.control,
        valueType: field.valueType,
        valueSchema: field.valueSchema,
        title: field.displayKey,
        subtitle: field.descriptionKey ?? null,
        ...(typeof field.order === 'number' ? { order: field.order } : {}),
        ...(field.groupId !== undefined ? { groupId: field.groupId } : {}),
        redaction: field.redaction,
        clearWhenEmpty: field.clearWhenEmpty,
        ...(typeof field.defaultBooleanValue === 'boolean'
            ? { defaultBooleanValue: field.defaultBooleanValue }
            : {}),
        ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
        ...(field.presentation ? { presentation: field.presentation } : {}),
        ...(field.availability ? { availability: field.availability } : {}),
        ...(field.analytics ? { analytics: field.analytics } : {}),
    };
}

function mapV2EditableSettingsGroup(settings: PluginProjectedSettingsV2): PluginProjectionEditableSettingsGroup {
    return {
        id: settings.id,
        pluginId: settings.pluginId,
        version: settings.version,
        title: settings.title,
        ...(settings.description ? { description: settings.description } : {}),
        storageScope: settings.storageScope,
        presentation: settings.presentation,
        target: settings.target,
        fields: settings.fields.map(mapV2EditableSettingsField),
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
            dangerLevel: mapV1ActionDangerLevel(action.safety),
            confirmation: null,
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

    const pluginIds = new Set<string>([
        ...actionsByPluginId.keys(),
        ...resourcesByPluginId.keys(),
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
            editableSettingsGroups: [],
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

    const editableSettingsByPluginId = new Map<string, PluginProjectionEditableSettingsGroup[]>();
    for (const settings of Object.values(projection.settingsById ?? {})) {
        const groups = editableSettingsByPluginId.get(settings.pluginId) ?? [];
        groups.push(mapV2EditableSettingsGroup(settings));
        editableSettingsByPluginId.set(settings.pluginId, groups);
    }

    const diagnosticsByPluginId = new Map<string, PluginProjectionDiagnostic[]>();
    for (const diagnostic of projection.diagnostics) {
        const pluginId = diagnostic.plugin.id;
        const diagnostics = diagnosticsByPluginId.get(pluginId) ?? [];
        diagnostics.push({
            code: diagnostic.data.code,
            message: diagnostic.data.message ?? diagnostic.data.code,
            severity: diagnostic.data.severity,
        });
        diagnosticsByPluginId.set(pluginId, diagnostics);
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
            editableSettingsGroups: editableSettingsByPluginId.get(pluginId) ?? [],
        };
    }
    return entries;
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

    for (const [agentEntryId, entry] of Object.entries(projection.agentsById ?? {})) {
        mergedProviderProjectionById[agentEntryId] = {
            agentId: agentEntryId,
            identity: isPluginProjectionV2(projection)
                ? projection.agentsById[agentEntryId]?.identity ?? null
                : null,
            title: entry.title ?? null,
            subtitle: entry.subtitle ?? null,
            channel: entry.channel === 'stable' || entry.channel === 'experimental' || entry.channel === 'plugin'
                ? entry.channel
                : null,
            isBuiltIn: entry.isBuiltIn ?? undefined,
            settingsBackendId: typeof entry.settingsBackendId === 'string' && entry.settingsBackendId.trim().length > 0
                ? entry.settingsBackendId.trim()
                : null,
            catalogAgentId: isProjectedAgentId(entry.catalogAgentId) ? entry.catalogAgentId : null,
            iconAgentId: isProjectedAgentId(entry.iconAgentId) ? entry.iconAgentId : null,
            cli: isPluginProjectionV2(projection)
                ? projection.agentsById[agentEntryId]?.cli ?? null
                : null,
        };
    }

    for (const [backendId, entry] of Object.entries(projection.backendsById ?? {})) {
        mergedBackendProjectionById[backendId] = {
            backendId,
            agentId: entry.agentId,
            title: entry.title ?? null,
            subtitle: entry.subtitle ?? null,
            catalogAgentId: isProjectedAgentId(entry.catalogAgentId) ? entry.catalogAgentId : null,
            iconAgentId: isProjectedAgentId(entry.iconAgentId) ? entry.iconAgentId : null,
            capabilities: entry.capabilities ?? null,
        };
    }

    return {
        mergedProviderProjectionById,
        mergedBackendProjectionById,
        pluginProjectionById: isPluginProjectionV2(projection)
            ? buildV2PluginProjectionById(projection)
            : buildV1PluginProjectionById(projection),
        registryDiagnostics: [],
    };
}
