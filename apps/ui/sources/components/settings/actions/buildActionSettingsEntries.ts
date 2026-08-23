import {
    ActionSurfaceSchema,
    ActionUiPlacementSchema,
    formatQualifiedPluginActionId,
    listActionSpecs,
    parseQualifiedPluginActionId,
    type ActionId,
    type ActionSettingsActionId,
    type ActionSurfaces,
    type ActionUiPlacement,
    type ActionsSettingsV1,
    type QualifiedPluginActionId,
} from '@happier-dev/protocol';

import {
    getActionSettingsTargetContext,
    getActionSettingsTargetSelected,
    isMcpTarget,
    isRunScopedPlacement,
    isVoiceTargetId,
    listActionSettingsTargetDefinitions,
    type ActionSettingsTargetCategory,
    type ActionSettingsTargetDefinition,
    type ActionSettingsTargetId,
    type ActionSettingsTargetSource,
} from './actionSettingsTargets';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { TranslationKey } from '@/text';
import { isExecutionRunsFeatureAction } from '@/sync/domains/actions/isExecutionRunsFeatureAction';
import { isInventoryPrivacyAction } from '@/sync/domains/settings/actionSettingsPolicy';
import { isActionSettingsTargetSupportedInUiApp } from './actionSettingsTargetSupport';

export type ActionSettingsAvailability = Readonly<{
    executionRunsEnabled: boolean;
    memorySearchEnabled: boolean;
    voiceEnabled: boolean;
    sessionHandoffEnabled: boolean;
    mcpServersEnabled: boolean;
    voiceShareDeviceInventory: boolean;
}>;

/**
 * The selected daemon's presentation projection, reduced to the action facts this screen owns.
 * This stays deliberately projection-shaped: the UI never re-parses plugin manifests or unions
 * contribution lists from machines outside its selected administration target.
 */
export type ActionSettingsContributedAction = Readonly<{
    pluginId: string;
    localId: string;
    title: string;
    description: string | null;
    icon: string | null;
    surfaces: readonly string[];
    placementBindings?: readonly string[];
    slash?: unknown;
}>;

export type ActionSettingsTargetState = 'on' | 'off' | 'unavailable';

export type ActionSettingsTargetEntry = Readonly<{
    id: ActionSettingsTargetId;
    definition: ActionSettingsTargetDefinition;
    titleKey: ActionSettingsTargetDefinition['titleKey'];
    subtitleKey: ActionSettingsTargetDefinition['subtitleKey'];
    icon: string;
    category: ActionSettingsTargetCategory;
    state: ActionSettingsTargetState;
    selected: boolean;
    reasonKey?: Extract<TranslationKey, `settingsActions.reasons.${string}`>;
}>;

type ActionSettingsEntryBase<TKind extends 'host' | 'contributed' | 'retained', TActionId extends ActionSettingsActionId> = Readonly<{
    kind: TKind;
    actionId: TActionId;
    title: string;
    description: string | null;
    enabled: boolean;
    targets: readonly ActionSettingsTargetEntry[];
}>;

/** Host catalog entries are the only rows eligible for host-specific controls. */
export type ActionSettingsEntry =
    | ActionSettingsEntryBase<'host', ActionId>
    | ActionSettingsEntryBase<'contributed' | 'retained', QualifiedPluginActionId>;

type BuildActionSettingsEntriesParams = Readonly<{
    query: string;
    settings: ActionsSettingsV1;
    availability: ActionSettingsAvailability;
    /** Present only for the explicitly selected machine's daemon projection. */
    contributedActions?: readonly ActionSettingsContributedAction[];
    translate?: ((key: TranslationKey) => string) | undefined;
}>;

type ActionSettingsDescriptor = Readonly<{
    kind: ActionSettingsEntry['kind'];
    actionId: ActionSettingsActionId;
    title: string;
    description: string | null;
    source: ActionSettingsTargetSource | null;
}>;

type ActionSettingsReasonKey = Extract<TranslationKey, `settingsActions.reasons.${string}`>;

function normalizeQuery(query: string): string {
    return query.trim().toLowerCase();
}

function matchesSearchText(searchText: string, normalizedQuery: string): boolean {
    if (normalizedQuery.length === 0) return true;
    if (searchText.includes(normalizedQuery)) return true;

    const queryTokens = normalizedQuery.split(/\s+/).filter((token) => token.length > 0);
    return queryTokens.every((token) => searchText.includes(token));
}

function buildSearchText(params: Readonly<{
    actionId: ActionSettingsActionId;
    title: string;
    description: string | null;
    targetDefinitions: readonly ActionSettingsTargetDefinition[];
    translate?: ((key: TranslationKey) => string) | undefined;
}>): string {
    const translate = params.translate ?? ((key: TranslationKey) => key);
    return [
        params.actionId,
        params.title,
        params.description ?? '',
        ...params.targetDefinitions.map((target) => `${target.id} ${translate(target.titleKey)} ${translate(target.subtitleKey)}`),
    ].join(' ').trim().toLowerCase();
}

function getActionAvailabilityReasonKey(
    actionId: ActionId,
    availability: ActionSettingsAvailability,
): ActionSettingsReasonKey | null {
    if (!availability.executionRunsEnabled && isExecutionRunsFeatureAction(actionId)) {
        return 'settingsActions.reasons.executionRunsFeature';
    }
    if (!availability.memorySearchEnabled && actionId === 'memory.search') {
        return 'settingsActions.reasons.memorySearchFeature';
    }
    if (!availability.sessionHandoffEnabled && actionId === 'session.handoff') {
        return 'settingsActions.reasons.sessionHandoffFeature';
    }
    return null;
}

function getUiClientTargetAvailabilityReasonKey(targetId: ActionSettingsTargetId): ActionSettingsReasonKey | null {
    return isActionSettingsTargetSupportedInUiApp(targetId)
        ? null
        : 'settingsActions.reasons.notAvailableInThisApp';
}

function getTargetAvailabilityReasonKey(params: Readonly<{
    actionId: ActionId;
    targetId: ActionSettingsTargetId;
    availability: ActionSettingsAvailability;
}>): ActionSettingsReasonKey | null {
    if (isVoiceTargetId(params.targetId)) {
        if (!params.availability.voiceEnabled) return 'settingsActions.reasons.voiceFeature';
        if (!params.availability.voiceShareDeviceInventory && isInventoryPrivacyAction(params.actionId)) {
            return 'settingsActions.reasons.voiceInventoryPrivacy';
        }
    }
    if (isMcpTarget(params.targetId) && !params.availability.mcpServersEnabled) {
        return 'settingsActions.reasons.mcpFeature';
    }
    if (isRunScopedPlacement(params.targetId) && !params.availability.executionRunsEnabled) {
        return 'settingsActions.reasons.executionRunsFeature';
    }
    return null;
}

function buildTargetEntries(params: Readonly<{
    descriptor: ActionSettingsDescriptor;
    settings: ActionsSettingsV1;
    availability: ActionSettingsAvailability;
    targetDefinitions: readonly ActionSettingsTargetDefinition[];
}>): readonly ActionSettingsTargetEntry[] {
    const hostActionId = params.descriptor.kind === 'host' ? params.descriptor.actionId as ActionId : null;
    const actionLevelReasonKey = hostActionId
        ? getActionAvailabilityReasonKey(hostActionId, params.availability)
        : null;

    return params.targetDefinitions.map((definition) => {
        const selected = getActionSettingsTargetSelected({
            settings: params.settings,
            actionId: params.descriptor.actionId,
            targetId: definition.id,
            target: definition,
        });
        const targetLevelReasonKey = hostActionId
            ? getTargetAvailabilityReasonKey({
                actionId: hostActionId,
                targetId: definition.id,
                availability: params.availability,
            })
            : null;
        const reasonKey = actionLevelReasonKey
            ?? getUiClientTargetAvailabilityReasonKey(definition.id)
            ?? targetLevelReasonKey
            ?? undefined;

        return {
            id: definition.id,
            definition,
            titleKey: definition.titleKey,
            subtitleKey: definition.subtitleKey,
            icon: definition.icon,
            category: definition.category,
            state: reasonKey ? 'unavailable' : (selected ? 'on' : 'off'),
            selected,
            reasonKey,
        } satisfies ActionSettingsTargetEntry;
    });
}

function contributionTargetSource(action: ActionSettingsContributedAction): ActionSettingsTargetSource {
    const surfaces: Partial<ActionSurfaces> = { api: true };
    const supportedSurfaces = new Set<keyof ActionSurfaces>(Object.keys(ActionSurfaceSchema.shape) as Array<keyof ActionSurfaces>);
    for (const surface of action.surfaces) {
        if (supportedSurfaces.has(surface as keyof ActionSurfaces)) {
            surfaces[surface as keyof ActionSurfaces] = true;
        }
    }

    const placements: ActionUiPlacement[] = [];
    for (const placement of action.placementBindings ?? []) {
        const parsed = ActionUiPlacementSchema.safeParse(placement);
        if (parsed.success) placements.push(parsed.data);
    }

    return { surfaces, placements, slash: action.slash };
}

/**
 * Extract current action declarations from one daemon projection. Projection provenance already
 * encodes built-in versus external plugins, so both receive the identical settings path here.
 */
export function buildActionSettingsContributedActions(
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>,
): readonly ActionSettingsContributedAction[] {
    return Object.values(pluginProjectionById).flatMap((plugin) => plugin.actions.map((action) => ({
        pluginId: plugin.pluginId,
        localId: action.id,
        title: action.title,
        description: action.description,
        icon: action.icon,
        surfaces: action.surfaces,
        placementBindings: action.placementBindings,
        slash: action.slash,
    })));
}

function buildHostDescriptors(): readonly ActionSettingsDescriptor[] {
    return listActionSpecs().map((spec) => ({
        kind: 'host' as const,
        actionId: spec.id,
        title: spec.title,
        description: spec.description ?? spec.inputHints?.description ?? null,
        source: spec,
    }));
}

function buildContributedDescriptors(
    contributedActions: readonly ActionSettingsContributedAction[],
): readonly ActionSettingsDescriptor[] {
    const descriptors = new Map<ActionSettingsActionId, ActionSettingsDescriptor>();
    for (const action of contributedActions) {
        const actionId = formatQualifiedPluginActionId({ pluginId: action.pluginId, localId: action.localId });
        descriptors.set(actionId, {
            kind: 'contributed',
            actionId,
            title: action.title,
            description: action.description,
            source: contributionTargetSource(action),
        });
    }
    return [...descriptors.values()];
}

function buildRetainedDescriptors(params: Readonly<{
    settings: ActionsSettingsV1;
    currentDescriptors: readonly ActionSettingsDescriptor[];
    translate?: ((key: TranslationKey) => string) | undefined;
}>): readonly ActionSettingsDescriptor[] {
    const currentActionIds = new Set(params.currentDescriptors.map((descriptor) => descriptor.actionId));
    const description = (params.translate ?? ((key: TranslationKey) => key))('settingsActions.contributed.removedDescription');
    return Object.keys(params.settings.actions)
        .filter((actionId): actionId is ActionSettingsActionId => parseQualifiedPluginActionId(actionId) !== null)
        .filter((actionId) => !currentActionIds.has(actionId))
        .map((actionId) => ({
            kind: 'retained' as const,
            actionId,
            title: actionId,
            description,
            source: null,
        }));
}

export function buildActionSettingsEntries(params: BuildActionSettingsEntriesParams): readonly ActionSettingsEntry[] {
    const normalizedQuery = normalizeQuery(params.query);
    const currentDescriptors = [
        ...buildHostDescriptors(),
        ...buildContributedDescriptors(params.contributedActions ?? []),
    ];
    const descriptors = [
        ...currentDescriptors,
        ...buildRetainedDescriptors({
            settings: params.settings,
            currentDescriptors,
            translate: params.translate,
        }),
    ];

    return descriptors.flatMap((descriptor) => {
        const targetDefinitions = descriptor.source
            ? listActionSettingsTargetDefinitions(descriptor.source)
            : [];
        if (descriptor.kind !== 'retained' && targetDefinitions.length === 0) return [];

        const searchText = buildSearchText({
            actionId: descriptor.actionId,
            title: descriptor.title,
            description: descriptor.description,
            targetDefinitions,
            translate: params.translate,
        });
        if (!matchesSearchText(searchText, normalizedQuery)) return [];

        return [{
            kind: descriptor.kind,
            actionId: descriptor.actionId,
            title: descriptor.title,
            description: descriptor.description,
            enabled: params.settings.actions[descriptor.actionId]?.enabled !== false,
            targets: buildTargetEntries({
                descriptor,
                settings: params.settings,
                availability: params.availability,
                targetDefinitions,
            }),
        } as ActionSettingsEntry];
    }).sort((left, right) => left.title.localeCompare(right.title));
}

export function resolveActionSettingsTargetSelections(targets: readonly ActionSettingsTargetEntry[]): Record<ActionSettingsTargetCategory, ActionSettingsTargetId[]> {
    return targets.reduce<Record<ActionSettingsTargetCategory, ActionSettingsTargetId[]>>(
        (accumulator, target) => {
            if (target.selected) accumulator[target.category].push(target.id);
            return accumulator;
        },
        { app: [], voice: [], integrations: [] },
    );
}

/** Legacy host-only helper retained for its existing public call sites. */
export function resolveActionSettingsTargetContext(actionId: ActionId, targetId: ActionSettingsTargetId) {
    const target = listActionSettingsTargetDefinitions(listActionSpecs().find((spec) => spec.id === actionId)!)
        .find((entry) => entry.id === targetId);
    if (!target) throw new Error(`Unsupported action settings target context: ${actionId}:${targetId}`);
    return getActionSettingsTargetContext(target);
}
