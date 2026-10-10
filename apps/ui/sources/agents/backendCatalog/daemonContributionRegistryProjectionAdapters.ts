import type {
    ActionInputHints,
    PluginActionConfirmationV2,
    PluginProjectedActionV2,
    PluginLocalizedStringV2,
    PluginProjectedResourceV2,
    PluginProjectedSettingsFieldV2,
    PluginProjectedSettingsV2,
    PluginProjectionV2,
    PluginProjectionInstalledPackageV2,
    PluginContributionIdentityV1,
    PluginDiagnosticDataV1,
} from '@happier-dev/protocol';
import { AGENT_IDS, type AgentId } from '@happier-dev/agents';

import { resolveAgentMarkAgentId } from './resolveAgentMarkAgentId';

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
    details?: PluginDiagnosticDataV1['details'];
    contribution?: PluginContributionIdentityV1;
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

type PluginProjectionEditableSettingPresentation = Readonly<
    Omit<NonNullable<PluginProjectedSettingsFieldV2['presentation']>, 'options'> & {
        options?: readonly NonNullable<
            NonNullable<PluginProjectedSettingsFieldV2['presentation']>['options']
        >[number][];
    }
>;

export type PluginProjectionEditableSettingField = Readonly<{
    key: string;
    control: PluginProjectionEditableSettingControl;
    /** Canonical secret owner from the daemon projection, never inferred from Settings scope. */
    secretCustody: PluginProjectedSettingsFieldV2['secretCustody'];
    /** Account endpoint relation used only as credential-origin metadata. */
    managedServiceOrigin?: PluginProjectedSettingsFieldV2['managedServiceOrigin'];
    valueType: PluginProjectionEditableSettingValueType;
    valueSchema: PluginProjectedSettingsFieldV2['valueSchema'];
    title: PluginProjectedSettingsFieldV2['displayKey'];
    subtitle?: PluginProjectedSettingsFieldV2['descriptionKey'] | null;
    order?: number;
    groupId?: string | null;
    redaction: string;
    clearWhenEmpty: string;
    defaultBooleanValue?: boolean;
    defaultValue?: PluginProjectedSettingsFieldV2['defaultValue'];
    presentation?: PluginProjectionEditableSettingPresentation;
    availability?: PluginProjectedSettingsFieldV2['availability'];
    analytics?: PluginProjectedSettingsFieldV2['analytics'];
}>;

export type PluginProjectionEditableSettingsGroup = Readonly<{
    id: string;
    pluginId: string;
    version: 1;
    title: PluginProjectedSettingsV2['title'];
    description?: PluginProjectedSettingsV2['description'] | null;
    /** One declared record owner. Legacy storageScope is intentionally not inferred. */
    scope: PluginProjectedSettingsV2['scope'];
    presentation: PluginProjectedSettingsV2['presentation'];
    target:
        | Readonly<{ kind: 'plugin' }>
        | Readonly<{ kind: 'agent'; agent: Readonly<{ pluginId: string; localId: string }> }>;
    fields: readonly PluginProjectionEditableSettingField[];
}>;

export type ResolvedPluginProjectionEditableSettingOption = Readonly<
    Omit<NonNullable<PluginProjectionEditableSettingPresentation['options']>[number], 'title' | 'description'> & {
        title: string;
        description?: string;
    }
>;

export type ResolvedPluginProjectionEditableSettingPresentation = Readonly<
    Omit<PluginProjectionEditableSettingPresentation, 'placeholder' | 'options'> & {
        placeholder?: string;
        options?: readonly ResolvedPluginProjectionEditableSettingOption[];
    }
>;

export type ResolvedPluginProjectionEditableSettingField = Readonly<
    Omit<PluginProjectionEditableSettingField, 'title' | 'subtitle' | 'presentation'> & {
        title: string;
        subtitle?: string | null;
        presentation?: ResolvedPluginProjectionEditableSettingPresentation;
    }
>;

export type ResolvedPluginProjectionEditableSettingsGroup = Readonly<
    Omit<PluginProjectionEditableSettingsGroup, 'title' | 'description' | 'fields'> & {
        title: string;
        description?: string | null;
        fields: readonly ResolvedPluginProjectionEditableSettingField[];
    }
>;

export type PluginProjectionAction = Readonly<{
    id: string;
    /** Exact process-local occurrence of this projected Action contribution. */
    occurrenceId: string | null;
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
    path?: string;
    scope?: PluginProjectedResourceV2['scope'];
    digest: string | null;
    contentType: string | null;
}>;

export type PluginProjectionEntry = Readonly<{
    pluginId: string;
    /** The canonical installed-package Resource identity, also used by host brand chrome. */
    installedPackage?: PluginProjectionInstalledPackageV2;
    /** Process-local physical lifetime of this admitted installed package. */
    occurrenceId?: string | null;
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
    /** The mark of the Agent this plugin contributes, when it contributes one with a known mark. */
    iconAgentId?: AgentId | null;
    /**
     * What kinds of things the plugin adds: `agent` first when it contributes an Agent, then each
     * contribution family it has entries in, in projection order. Empty when nothing is projected.
     */
    contributionKinds?: readonly PluginContributionKind[];
}>;

/** A kind of contribution a plugin adds: an Agent, or one of the projected contribution families. */
export type PluginContributionKind = 'agent' | keyof PluginProjectionV2['familiesById'];

export type DaemonContributionRegistryProjection = PluginProjectionV2;

function readOptionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
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
        occurrenceId: action.occurrenceId,
        title: presentation.title,
        description: presentation.description,
        localizedPresentation,
        icon: action.icon ?? null,
        scopes: action.scopes,
        surfaces: action.surfaces,
        placementBindings: action.placementBindings ?? [],
        inputHints: presentation.inputHints,
        slash: action.slash ?? null,
        priority: action.priority ?? null,
        dangerLevel: action.dangerLevel,
        confirmation: action.confirmation ?? null,
        ...(action.authorization ? { authorization: action.authorization } : {}),
        available: typeof action.available === 'boolean' ? action.available : null,
    };
}

function mapV2Resource(resource: PluginProjectedResourceV2): PluginProjectionResource {
    return {
        id: resource.id,
        resourceKind: resource.resourceKind,
        ...(resource.path === undefined ? {} : { path: resource.path }),
        ...(resource.scope === undefined ? {} : { scope: resource.scope }),
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

/**
 * Resolves the author declaration at the UI presentation edge through the
 * existing plugin translation owner. The daemon projection remains locale
 * independent and no Settings-specific translation catalog is introduced.
 */
export function resolvePluginProjectionEditableSettingsGroup(
    group: PluginProjectionEditableSettingsGroup,
    localize: (pluginId: string, value: PluginLocalizedStringV2) => string,
): ResolvedPluginProjectionEditableSettingsGroup {
    return {
        ...group,
        title: localize(group.pluginId, group.title),
        ...(group.description === undefined || group.description === null
            ? { description: group.description }
            : { description: localize(group.pluginId, group.description) }),
        presentation: {
            ...group.presentation,
            sections: group.presentation.sections.map((section) => ({
                ...section,
                title: localize(group.pluginId, section.title),
                ...(section.description === undefined
                    ? {}
                    : { description: localize(group.pluginId, section.description) }),
            })),
            subagentSections: group.presentation.subagentSections.map((section) => ({
                ...section,
                title: localize(group.pluginId, section.title),
                ...(section.description === undefined
                    ? {}
                    : { description: localize(group.pluginId, section.description) }),
                items: section.items.map((item) => ({
                    ...item,
                    title: localize(group.pluginId, item.title),
                    ...(item.description === undefined
                        ? {}
                        : { description: localize(group.pluginId, item.description) }),
                })),
            })),
        },
        fields: group.fields.map(({ title, subtitle, presentation: fieldPresentation, ...fieldRest }) => {
            const availability: PluginProjectionEditableSettingField['availability'] =
                fieldRest.availability?.disabledWhen !== undefined
                ? {
                    ...fieldRest.availability,
                    disabledReason: localize(group.pluginId, fieldRest.availability.disabledReason),
                }
                : fieldRest.availability;
            const presentation: ResolvedPluginProjectionEditableSettingPresentation | undefined = fieldPresentation
                ? (({ placeholder, options, ...presentationRest }) => ({
                    ...presentationRest,
                    ...(placeholder === undefined
                        ? {}
                        : { placeholder: localize(group.pluginId, placeholder) }),
                    ...(options === undefined
                        ? {}
                        : {
                            options: options.map(({ title: optionTitle, description, ...optionRest }) => ({
                                ...optionRest,
                                title: localize(group.pluginId, optionTitle),
                                ...(description === undefined
                                    ? {}
                                    : { description: localize(group.pluginId, description) }),
                            })),
                        }),
                }))(fieldPresentation)
                : undefined;
            return {
                ...fieldRest,
                title: localize(group.pluginId, title),
                ...(subtitle === undefined || subtitle === null
                    ? { subtitle }
                    : { subtitle: localize(group.pluginId, subtitle) }),
                ...(availability === undefined ? {} : { availability }),
                ...(presentation === undefined ? {} : { presentation }),
            };
        }),
    };
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
            ...(diagnostic.data.details === undefined ? {} : { details: diagnostic.data.details }),
            ...(diagnostic.contribution === undefined ? {} : { contribution: diagnostic.contribution }),
        });
        diagnosticsByPluginId.set(pluginId, diagnostics);
    }

    const iconAgentIdByPluginId = new Map<string, AgentId>();
    for (const [agentEntryId, agent] of Object.entries(projection.agentsById)) {
        const pluginId = agent.identity?.pluginId;
        if (!pluginId || iconAgentIdByPluginId.has(pluginId)) continue;
        // The same rule the Agent picker's mark reads (`resolveAgentMarkAgentId`).
        const markAgentId = resolveAgentMarkAgentId({
            agentId: agentEntryId,
            iconAgentId: agent.iconAgentId ?? null,
            catalogAgentId: agent.catalogAgentId ?? null,
        });
        if (markAgentId) iconAgentIdByPluginId.set(pluginId, markAgentId);
    }
    const contributionKindsByPluginId = new Map<string, PluginContributionKind[]>();
    const addKind = (pluginId: string | null | undefined, kind: PluginContributionKind) => {
        if (!pluginId) return;
        const kinds = contributionKindsByPluginId.get(pluginId) ?? [];
        if (!kinds.includes(kind)) kinds.push(kind);
        contributionKindsByPluginId.set(pluginId, kinds);
    };
    for (const agent of Object.values(projection.agentsById)) addKind(agent.identity?.pluginId, 'agent');
    for (const [familyId, family] of Object.entries(projection.familiesById) as [keyof PluginProjectionV2['familiesById'], { entriesById?: Readonly<Record<string, Readonly<{ pluginId?: string | null }>>> } | undefined][]) {
        for (const entry of Object.values(family?.entriesById ?? {})) addKind(entry.pluginId, familyId);
    }
    const entries: Record<string, PluginProjectionEntry> = {};
    for (const [pluginId, installedPackage] of Object.entries(projection.installedPackagesById)) {
        entries[pluginId] = {
            pluginId,
            installedPackage,
            occurrenceId: installedPackage.occurrenceId ?? null,
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
            iconAgentId: iconAgentIdByPluginId.get(pluginId) ?? null,
            contributionKinds: contributionKindsByPluginId.get(pluginId) ?? [],
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
        if (!ui.identityColor && !ui.behavior && !ui.session && !ui.message && !ui.components) continue;
        if (!entry.identity) continue;
        descriptorsByAgentId[agentId] = {
            kind: 'plugin.ui.v1',
            pluginId: entry.identity.pluginId,
            agentId,
            version: 1,
            ...(ui.identityColor ? { identityColor: ui.identityColor } : {}),
            ...(ui.behavior ? { behavior: ui.behavior } : {}),
            ...(ui.session ? { session: ui.session } : {}),
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
    // The daemon projects no backend rows; the map stays empty for its readers.
    const mergedBackendProjectionById: Record<string, MergedBackendProjectionEntry> = {};

    for (const [agentEntryId, entry] of Object.entries(projection.agentsById)) {
        const identity = entry.identity ?? null;
        const installedPackageCandidate = identity
            ? projection.installedPackagesById[identity.pluginId] ?? null
            : null;
        const installedPackage = installedPackageCandidate?.id === identity?.pluginId
            ? installedPackageCandidate
            : null;
        mergedProviderProjectionById[agentEntryId] = {
            agentId: agentEntryId,
            qualifiedId: agentEntryId,
            identity,
            installedPackage,
            projectionGeneration: projection.generation,
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
            cli: entry.cli ?? null,
            connectedAccounts: entry.connectedAccounts ?? null,
            ui: entry.ui ?? null,
        };
    }

    return {
        mergedProviderProjectionById,
        mergedBackendProjectionById,
        pluginProjectionById: buildV2PluginProjectionById(projection),
        registryDiagnostics: [],
    };
}
