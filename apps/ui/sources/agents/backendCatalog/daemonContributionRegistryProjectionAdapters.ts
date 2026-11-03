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
    DaemonContributionRegistryProjectionAutomationEligibleEventsV1,
    DaemonPluginUiComposerSurfaceCatalogEntryV1,
    DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1,
} from '@happier-dev/protocol';
import { AGENT_IDS, type AgentId } from '@happier-dev/agents';
import { normalizePluginUiProjection, resolvePluginUiProjectionPlatform, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { preparePluginUiProjectionOrigins } from '@/sync/domains/plugins/ui/projectionOrigins';
import { readConnectedAccountDescriptorProjection, type ConnectedAccountDescriptorMachineProjection } from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginUiPlatformV1 } from '@happier-dev/protocol/plugins/ui';
import { createPluginActionInputSelectionFactsPublication, type PluginActionInputSelectionSnapshot } from '@/components/plugins/surfaces/pluginActionInputSelectionFacts';
import { admitAgentConnectedAccountPurposeDeclarations } from '@happier-dev/protocol/account/settings/connected-services';

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

export type DaemonMergedProjectionInputs = Readonly<{
    mergedProviderProjectionById: Readonly<Record<string, MergedProviderProjectionEntry>>;
    mergedBackendProjectionById: Readonly<Record<string, MergedBackendProjectionEntry>>;
    discoveredBackendIds: readonly string[];
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
    pluginProjectionV2: PluginProjectionV2 | null;
    /** Prepared by acquisition; rendering and sibling readers never normalize raw V2. */
    pluginUiProjection: PluginUiProjectionModel;
    pluginUiProjectionPlatform: PluginUiPlatformV1;
    connectedAccountProjection: ConnectedAccountDescriptorMachineProjection | null;
    composerSurfaceCatalog?: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
    composerSurfaceActionInputSelectionFacts: ReadonlyMap<DaemonPluginUiComposerSurfaceCatalogEntryV1, PluginActionInputSelectionSnapshot>;
    ephemeralInputSurfaceActionInputSelectionFacts: ReadonlyMap<DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1, PluginActionInputSelectionSnapshot>;
    automationEligibleEvents?: DaemonContributionRegistryProjectionAutomationEligibleEventsV1;
    registryDiagnostics: readonly PluginProjectionDiagnostic[];
}>;

const ownedProjectionInput = Symbol('daemonMergedProjectionInput');
type OwnedProjectionInput = Readonly<{
    owner: DaemonMergedProjectionInputs;
    projection: PluginProjectionV2;
    resourceDeclarations?: 'complete';
    composerSurfaceCatalog: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[] | undefined;
    automationEligibleEvents: DaemonContributionRegistryProjectionAutomationEligibleEventsV1 | undefined;
    composerSelections: readonly Readonly<{ row: DaemonPluginUiComposerSurfaceCatalogEntryV1; publication: ReturnType<typeof createPluginActionInputSelectionFactsPublication> }>[];
    setupSelections: readonly Readonly<{ row: DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1; publication: ReturnType<typeof createPluginActionInputSelectionFactsPublication> }>[];
}>;

/** Own only changed wire fields; equality is decided once before deriving presentation. */
function publishProjectionFields<T extends Readonly<Record<string, unknown>>>(input: T, previous?: T): T {
    const fields: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(input).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, previous && Object.hasOwn(previous, key) && sameStrictJsonValue(previous[key], value)
            ? previous[key] : projectNativeJsonValueForTransport(value)]]));
    if (previous && Object.keys(previous).length === Object.keys(fields).length
        && Object.entries(fields).every(([key, value]) => previous[key] === value)) return previous;
    // These are schema-admitted DTO fields. Protocol supplies immutable native
    // JSON ownership; retained children are already owned and are not recopied.
    return projectNativeJsonValueForTransport(fields) as T;
}

function publishPluginProjectionEntries(
    entries: Readonly<Record<string, PluginProjectionEntry>>,
    previous?: Readonly<Record<string, PluginProjectionEntry>>,
): Readonly<Record<string, PluginProjectionEntry>> {
    const published: Readonly<Record<string, PluginProjectionEntry>> = Object.fromEntries(Object.entries(entries).map(([id, row]) => {
        const prior = previous?.[id];
        if (prior && sameStrictJsonValue(prior, row)) return [id, prior];
        const shared = prior ? {
            ...row,
            installedPackage: sameStrictJsonValue(prior.installedPackage, row.installedPackage) ? prior.installedPackage : row.installedPackage,
            provenance: sameStrictJsonValue(prior.provenance, row.provenance) ? prior.provenance : row.provenance,
            diagnostics: sameStrictJsonValue(prior.diagnostics, row.diagnostics) ? prior.diagnostics : row.diagnostics,
            actions: sameStrictJsonValue(prior.actions, row.actions) ? prior.actions : row.actions,
            resources: sameStrictJsonValue(prior.resources, row.resources) ? prior.resources : row.resources,
            editableSettingsGroups: sameStrictJsonValue(prior.editableSettingsGroups, row.editableSettingsGroups) ? prior.editableSettingsGroups : row.editableSettingsGroups,
            contributionKinds: sameStrictJsonValue(prior.contributionKinds, row.contributionKinds) ? prior.contributionKinds : row.contributionKinds,
        } : row;
        // The typed adapter owns this native JSON shape. Its optional members
        // use the canonical transport omission rule; every nested value is copied
        // and frozen by Protocol, never by shallow caller-freeze inference.
        return [id, projectNativeJsonValueForTransport(shared) as PluginProjectionEntry];
    }));
    if (previous && Object.keys(previous).length === Object.keys(published).length
        && Object.entries(published).every(([id, row]) => previous[id] === row)) return previous;
    return projectNativeJsonValueForTransport(published) as Readonly<Record<string, PluginProjectionEntry>>;
}

/** One response-local adapter, shared by full publication and explicitly fresh Action reads.
 * It never writes the full Machine cache, so a selected reply cannot replace a full snapshot. */
export function publishDaemonMergedProjectionInputs(params: Readonly<{
    projection: PluginProjectionV2;
    /** Only the full-describe caller supplies declaration-set coverage. */
    resourceDeclarations?: 'complete';
    composerSurfaceCatalog?: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
    automationEligibleEvents?: DaemonContributionRegistryProjectionAutomationEligibleEventsV1;
}>, previous?: DaemonMergedProjectionInputs): DaemonMergedProjectionInputs {
    const platform = resolvePluginUiProjectionPlatform();
    const candidate = previous ? Object.getOwnPropertyDescriptor(previous, ownedProjectionInput)?.value as OwnedProjectionInput | undefined : undefined;
    const prior = candidate?.owner === previous ? candidate : undefined;
    const ownedPrevious = prior ? previous : undefined;
    // The describe/selected-read transport already used the strict V2 schema.
    // Keep its public raw identity, but never use its mutable graph as our prior
    // comparison authority or lend its aliases to ready descriptive slices.
    const familiesById = publishProjectionFields(Object.fromEntries(Object.entries(params.projection.familiesById).flatMap(([id, family]) => {
        if (!family) return [];
        const before = prior?.projection.familiesById[id as keyof PluginProjectionV2['familiesById']];
        return [[id, publishProjectionFields({ ...family,
            entriesById: publishProjectionFields(family.entriesById, before?.entriesById),
        }, before)]];
    })) as PluginProjectionV2['familiesById'], prior?.projection.familiesById);
    const projection = publishProjectionFields({ ...params.projection,
        installedPackagesById: publishProjectionFields(params.projection.installedPackagesById, prior?.projection.installedPackagesById),
        agentsById: publishProjectionFields(params.projection.agentsById, prior?.projection.agentsById),
        actionsById: publishProjectionFields(params.projection.actionsById, prior?.projection.actionsById),


        resourcesById: publishProjectionFields(params.projection.resourcesById, prior?.projection.resourcesById),
        settingsById: publishProjectionFields(params.projection.settingsById, prior?.projection.settingsById),
        familiesById,
    }, prior?.projection);
    const composerSurfaceCatalog = params.composerSurfaceCatalog === undefined ? undefined
        : prior?.composerSurfaceCatalog && sameStrictJsonValue(prior.composerSurfaceCatalog, params.composerSurfaceCatalog)
            ? prior.composerSurfaceCatalog : projectNativeJsonValueForTransport(params.composerSurfaceCatalog) as readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
    const automationEligibleEvents = params.automationEligibleEvents === undefined ? undefined
        : prior?.automationEligibleEvents && sameStrictJsonValue(prior.automationEligibleEvents, params.automationEligibleEvents)
            ? prior.automationEligibleEvents : projectNativeJsonValueForTransport(params.automationEligibleEvents) as DaemonContributionRegistryProjectionAutomationEligibleEventsV1;
    if (ownedPrevious?.pluginUiProjectionPlatform === platform
        && prior?.resourceDeclarations === params.resourceDeclarations
        && prior?.projection === projection && prior?.composerSurfaceCatalog === composerSurfaceCatalog
        && prior?.automationEligibleEvents === automationEligibleEvents) return ownedPrevious;
    const rawAdapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);
    const adapted = projectNativeJsonValueForTransport({
        ...rawAdapted,
        pluginProjectionById: publishPluginProjectionEntries(rawAdapted.pluginProjectionById, ownedPrevious?.pluginProjectionById),
    }) as ReturnType<typeof adaptDaemonContributionRegistryProjectionToMergedProjectionInputs>;
    const previousUi = ownedPrevious?.pluginUiProjectionPlatform === platform ? ownedPrevious.pluginUiProjection : undefined;
    const pluginUiProjection = preparePluginUiProjectionOrigins(normalizePluginUiProjection(projection, platform, previousUi, {
        resourceDeclarations: params.resourceDeclarations,
        previousResourceDeclarations: prior?.resourceDeclarations,
        previousInput: previousUi ? prior?.projection : undefined,
    }), previousUi);
    const composerSelections = (composerSurfaceCatalog ?? []).map(row => ({ row,
        publication: prior?.composerSelections.find(previous => previous.row.contribution.pluginId === row.contribution.pluginId
            && previous.row.contribution.localId === row.contribution.localId && previous.row.occurrenceId === row.occurrenceId
            && previous.row.role === row.role)?.publication ?? createPluginActionInputSelectionFactsPublication(),
    }));
    // Picker callers consume the row from pluginProjectionV2, while automation
    // callers consume the published event row. Publish facts for those exact
    // identities at the same owner, including picker-only input types.
    const inputSurfaces = [
        ...(automationEligibleEvents ?? []).flatMap(event => event.setupSurface ? [event.setupSurface] : []),
        ...Object.values(params.projection.familiesById.inputTypes?.entriesById ?? {}).flatMap(entry => entry.pickerSurface ? [entry.pickerSurface] : []),
    ];
    const setupSelections = inputSurfaces.map(row => ({ row,
        publication: prior?.setupSelections.find(previous => previous.row.contribution.pluginId === row.contribution.pluginId
            && previous.row.contribution.localId === row.contribution.localId
            && previous.row.occurrenceId === row.occurrenceId)?.publication ?? createPluginActionInputSelectionFactsPublication(),
    }));
    const selection = (row: DaemonPluginUiComposerSurfaceCatalogEntryV1 | DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1,
        publication: ReturnType<typeof createPluginActionInputSelectionFactsPublication>) => publication.publish({
        pluginProjectionById: adapted.pluginProjectionById, translationsByPluginId: pluginUiProjection.translationsByPluginId,
        targetedContributions: row.contributorTargetedContributions, targetPluginId: row.contribution.pluginId,
    });
    const published: DaemonMergedProjectionInputs = {
        ...adapted,
        mergedProviderProjectionById: Object.freeze(Object.fromEntries(Object.entries(adapted.mergedProviderProjectionById).map(([id, agent]) => [id,
            agent.identity && agent.connectedAccounts ? Object.freeze({ ...agent,
                connectedAccounts: admitAgentConnectedAccountPurposeDeclarations(agent.identity, agent.connectedAccounts),
            }) : agent,
        ]))),
        discoveredBackendIds: Object.freeze(Object.keys(adapted.mergedBackendProjectionById)),
        pluginProjectionV2: params.projection,
        pluginUiProjectionPlatform: platform,
        pluginUiProjection,
        connectedAccountProjection: readConnectedAccountDescriptorProjection(projection),
        composerSurfaceActionInputSelectionFacts: new Map(composerSelections.map(({ row, publication }) => [row, selection(row, publication)])),
        ephemeralInputSurfaceActionInputSelectionFacts: new Map(setupSelections.map(({ row, publication }) => [row, selection(row, publication)])),
        ...(composerSurfaceCatalog === undefined ? {} : { composerSurfaceCatalog }),
        ...(automationEligibleEvents === undefined ? {} : { automationEligibleEvents }),
    };
    Object.defineProperty(published, ownedProjectionInput, { value: Object.freeze({ owner: published, projection,
        ...(params.resourceDeclarations ? { resourceDeclarations: params.resourceDeclarations } : {}), composerSurfaceCatalog, automationEligibleEvents,
        composerSelections, setupSelections }) });
    return Object.freeze(published);
}

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
    confirmationWhen?: PluginProjectedActionV2['confirmationWhen'];
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
        ...(action.confirmationWhen === undefined ? {} : { confirmationWhen: action.confirmationWhen }),
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
            acpRegistryIds: entry.acpRegistryIds ?? [],
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
