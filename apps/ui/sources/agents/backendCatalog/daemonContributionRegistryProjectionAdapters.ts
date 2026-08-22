import type {
    ActionInputHints,
    PluginActionConfirmationV2,
    PluginProjectedActionV2,
    PluginProjectedResourceV2,
    PluginProjectedSettingsFieldV2,
    PluginProjectedSettingsV2,
    PluginProjectionV2,
} from '@happier-dev/protocol';
import { AGENT_IDS, type AgentId } from '@happier-dev/agents';

import {
    resolvePluginProjectedActionPresentation,
    type PluginProjectedActionPresentation,
} from '@/sync/domains/plugins/ui/actionPresentation';

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
    /** Canonical secret owner from the daemon projection, never inferred from Settings scope. */
    secretCustody: PluginProjectedSettingsFieldV2['secretCustody'];
    /** Account endpoint relation used only as credential-origin metadata. */
    managedServiceOrigin?: PluginProjectedSettingsFieldV2['managedServiceOrigin'];
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
    /** One declared record owner. Legacy storageScope is intentionally not inferred. */
    scope: PluginProjectedSettingsV2['scope'];
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
    /**
     * The daemon-projected author presentation retained for the one host
     * Action resolver. Legacy consumers continue to receive the fallback
     * string fields above until they join that resolver.
     */
    localizedPresentation?: PluginProjectedActionPresentation;
    /** Manifest-declared icon slug; renderers map only known local icon names. */
    icon: string | null;
    scopes: readonly string[];
    surfaces: readonly string[];
    /**
     * UI-capable Actions carry all Protocol-declared semantic placement
     * bindings. Plugin-only Actions do not invent one while flowing through
     * the shared registry projection.
     */
    placementBindings: readonly string[];
    /** Canonical Action input contract used by host-owned selection validation. */
    inputSchema: PluginProjectedActionV2['inputSchema'] | null;
    /** Protocol-normalized SDK-ACTION-FORM descriptor; no renderer infers a form from schema. */
    inputHints: ActionInputHints | null;
    /** Action-owned composer slash presentation; the picker never parses a manifest itself. */
    slash?: PluginProjectedActionV2['slash'] | null;
    /** Smaller values present before larger values within each semantic placement. */
    priority: number | null;
    dangerLevel: PluginProjectedActionV2['dangerLevel'];
    confirmation: PluginActionConfirmationV2 | null;
    /** Daemon-projected canonical action policy facts; never UI-synthesized. */
    authorization?: PluginProjectedActionV2['authorization'];
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
    /**
     * Current committed plugin generation, when this entry came from the
     * resolved daemon registry. Metadata-only and legacy rows have none.
     */
    immutableGenerationId?: string | null;
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
    const localizedPresentation: PluginProjectedActionPresentation = Object.freeze({
        title: action.title,
        ...(action.description === undefined ? {} : { description: action.description }),
        ...(action.inputHints === undefined ? {} : { inputHints: action.inputHints }),
    });
    const presentation = resolvePluginProjectedActionPresentation({
        pluginId: action.pluginId,
        presentation: localizedPresentation,
        projection: null,
    });
    return {
        id: action.id,
        title: presentation.title,
        description: presentation.description,
        localizedPresentation,
        icon: action.icon ?? null,
        scopes: action.scopes,
        surfaces: action.surfaces,
        placementBindings: action.placementBindings ?? [],
        inputSchema: action.inputSchema ?? null,
        inputHints: presentation.inputHints,
        slash: action.slash ?? null,
        priority: action.priority ?? null,
        dangerLevel: action.dangerLevel,
        confirmation: action.confirmation ?? null,
        ...(action.authorization ? { authorization: action.authorization } : {}),
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
        secretCustody: field.secretCustody,
        ...(field.managedServiceOrigin ? { managedServiceOrigin: field.managedServiceOrigin } : {}),
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

/**
 * The one UI presentation mapping for daemon-projected Settings and
 * activation-independent Account recovery declarations.
 */
export function mapV2EditableSettingsGroup(
    settings: PluginProjectedSettingsV2,
): PluginProjectionEditableSettingsGroup {
    return {
        id: settings.id,
        pluginId: settings.pluginId,
        version: settings.version,
        title: settings.title,
        ...(settings.description ? { description: settings.description } : {}),
        scope: settings.scope,
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
            icon: null,
            scopes: [],
            surfaces: Object.entries(action.surfaces ?? {})
                .filter((entry): entry is [string, boolean] => entry[1] === true)
                .map(([surface]) => surface),
            placementBindings: ['detailsPanel'],
            inputSchema: null,
            inputHints: null,
            slash: null,
            priority: null,
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
            immutableGenerationId: null,
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
            immutableGenerationId: installedPackage.immutableGenerationId ?? null,
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
            },
            diagnostics: diagnosticsByPluginId.get(pluginId) ?? [],
            actions: actionsByPluginId.get(pluginId) ?? [],
            resources: resourcesByPluginId.get(pluginId) ?? [],
            editableSettingsGroups: editableSettingsByPluginId.get(pluginId) ?? [],
        };
    }
    return entries;
}

/**
 * Reads the `plugin.ui.v1` UI-behavior descriptor each projected Agent
 * declared, re-assembled into the envelope the client's single descriptor
 * interpreter consumes. Only Agents that actually declared one appear, so an
 * Agent without a descriptor keeps the neutral fallback rather than an empty
 * projection that would look like a declared one.
 */
export function readProjectedAgentUiBehaviorDescriptors(
    mergedProviderProjectionById: Readonly<Record<string, MergedProviderProjectionEntry>>,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
    const descriptorsByAgentId: Record<string, Readonly<Record<string, unknown>>> = {};
    for (const [agentId, entry] of Object.entries(mergedProviderProjectionById)) {
        const ui = entry.ui;
        if (!ui) continue;
        if (!ui.behavior && !ui.message && !ui.components) continue;
        descriptorsByAgentId[agentId] = {
            kind: 'plugin.ui.v1',
            pluginId: entry.identity?.pluginId ?? agentId,
            agentId,
            version: 1,
            ...(ui.behavior ? { behavior: ui.behavior } : {}),
            ...(ui.message ? { message: ui.message } : {}),
            ...(ui.components ? { components: ui.components } : {}),
        };
    }
    return descriptorsByAgentId;
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
            ui: isPluginProjectionV2(projection)
                ? projection.agentsById[agentEntryId]?.ui ?? null
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
