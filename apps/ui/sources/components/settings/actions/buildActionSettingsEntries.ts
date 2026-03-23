import {
    listActionSpecs,
    type ActionId,
    type ActionsSettingsV1,
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
} from './actionSettingsTargets';
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

export type ActionSettingsTargetState = 'on' | 'off' | 'unavailable';

export type ActionSettingsTargetEntry = Readonly<{
    id: ActionSettingsTargetId;
    titleKey: ActionSettingsTargetDefinition['titleKey'];
    subtitleKey: ActionSettingsTargetDefinition['subtitleKey'];
    icon: string;
    category: ActionSettingsTargetCategory;
    state: ActionSettingsTargetState;
    selected: boolean;
    reasonKey?: Extract<TranslationKey, `settingsActions.reasons.${string}`>;
}>;

type ActionSettingsReasonKey = Extract<TranslationKey, `settingsActions.reasons.${string}`>;

export type ActionSettingsEntry = Readonly<{
    actionId: ActionId;
    title: string;
    description: string | null;
    enabled: boolean;
    targets: readonly ActionSettingsTargetEntry[];
}>;

type BuildActionSettingsEntriesParams = Readonly<{
    query: string;
    settings: ActionsSettingsV1;
    availability: ActionSettingsAvailability;
    translate?: ((key: TranslationKey) => string) | undefined;
}>;

function normalizeQuery(query: string): string {
    return query.trim().toLowerCase();
}

function matchesSearchText(searchText: string, normalizedQuery: string): boolean {
    if (normalizedQuery.length === 0) {
        return true;
    }
    if (searchText.includes(normalizedQuery)) {
        return true;
    }

    const queryTokens = normalizedQuery.split(/\s+/).filter((token) => token.length > 0);
    return queryTokens.every((token) => searchText.includes(token));
}

function buildSearchText(params: Readonly<{
    actionId: ActionId;
    title: string;
    description: string | null;
    targetDefinitions: readonly ActionSettingsTargetDefinition[];
    translate?: ((key: TranslationKey) => string) | undefined;
}>): string {
    const parts = [
        params.actionId,
        params.title,
        params.description ?? '',
        ...params.targetDefinitions.map((target) => {
            const translate = params.translate ?? ((key: TranslationKey) => key);
            return `${target.id} ${translate(target.titleKey)} ${translate(target.subtitleKey)}`;
        }),
    ];
    return parts.join(' ').trim().toLowerCase();
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
    if (!isActionSettingsTargetSupportedInUiApp(targetId)) {
        return 'settingsActions.reasons.notAvailableInThisApp';
    }
    return null;
}

function getTargetAvailabilityReasonKey(params: Readonly<{
    actionId: ActionId;
    targetId: ActionSettingsTargetId;
    availability: ActionSettingsAvailability;
}>): ActionSettingsReasonKey | null {
    if (isVoiceTargetId(params.targetId)) {
        if (!params.availability.voiceEnabled) {
            return 'settingsActions.reasons.voiceFeature';
        }
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
    actionId: ActionId;
    settings: ActionsSettingsV1;
    availability: ActionSettingsAvailability;
}>): readonly ActionSettingsTargetEntry[] {
    const actionLevelReasonKey = getActionAvailabilityReasonKey(params.actionId, params.availability);

    return listActionSettingsTargetDefinitions(listActionSpecs().find((spec) => spec.id === params.actionId)!)
        .map((target) => {
            const selected = getActionSettingsTargetSelected({
                settings: params.settings,
                actionId: params.actionId,
                targetId: target.id,
            });
            const targetLevelReasonKey = getTargetAvailabilityReasonKey({
                actionId: params.actionId,
                targetId: target.id,
                availability: params.availability,
            });
            const uiClientReasonKey = getUiClientTargetAvailabilityReasonKey(target.id);
            const reasonKey = actionLevelReasonKey ?? uiClientReasonKey ?? targetLevelReasonKey ?? undefined;

            return {
                id: target.id,
                titleKey: target.titleKey,
                subtitleKey: target.subtitleKey,
                icon: target.icon,
                category: target.category,
                state: reasonKey ? 'unavailable' : (selected ? 'on' : 'off'),
                selected,
                reasonKey,
            } satisfies ActionSettingsTargetEntry;
        });
}

export function buildActionSettingsEntries(params: BuildActionSettingsEntriesParams): readonly ActionSettingsEntry[] {
    const normalizedQuery = normalizeQuery(params.query);

    return listActionSpecs()
        .map((spec) => {
            const targetDefinitions = listActionSettingsTargetDefinitions(spec);
            const description = spec.description ?? spec.inputHints?.description ?? null;
            return {
                actionId: spec.id,
                title: spec.title,
                description,
                enabled: params.settings.actions[spec.id]?.enabled !== false,
                searchText: buildSearchText({
                    actionId: spec.id,
                    title: spec.title,
                    description,
                    targetDefinitions,
                    translate: params.translate,
                }),
                targets: buildTargetEntries({
                    actionId: spec.id,
                    settings: params.settings,
                    availability: params.availability,
                }),
            };
        })
        .filter((entry) => matchesSearchText(entry.searchText, normalizedQuery))
        .sort((left, right) => left.title.localeCompare(right.title))
        .map(({ searchText: _searchText, ...entry }) => entry);
}

export function resolveActionSettingsTargetSelections(targets: readonly ActionSettingsTargetEntry[]): Record<ActionSettingsTargetCategory, ActionSettingsTargetId[]> {
    return targets.reduce<Record<ActionSettingsTargetCategory, ActionSettingsTargetId[]>>(
        (accumulator, target) => {
            if (target.selected) {
                accumulator[target.category].push(target.id);
            }
            return accumulator;
        },
        {
            app: [],
            voice: [],
            integrations: [],
        },
    );
}

export function resolveActionSettingsTargetContext(actionId: ActionId, targetId: ActionSettingsTargetId) {
    const target = listActionSettingsTargetDefinitions(listActionSpecs().find((spec) => spec.id === actionId)!)
        .find((entry) => entry.id === targetId);

    if (!target) {
        throw new Error(`Unsupported action settings target context: ${actionId}:${targetId}`);
    }

    return getActionSettingsTargetContext(target);
}
