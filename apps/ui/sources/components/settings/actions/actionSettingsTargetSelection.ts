import {
    ACTION_TOOL_EXPOSURE_SURFACES,
    isActionSettingsOptInPlacement,
    type ActionSettingsActionId,
    type ActionSurfaces,
    type ActionToolExposureMode,
    type ActionToolExposureSurface,
    type ActionUiPlacement,
    type ActionsSettingsV1,
} from '@happier-dev/protocol';

import { normalizeActionsSettings } from './normalizeActionsSettings';
import {
    resolveActionSettingsTargetDefinition,
    type ActionSettingsTargetDefinition,
    type ActionSettingsTargetId,
} from './actionSettingsTargetDefinitions';

type MutableActionSettingsEntry = {
    enabled?: boolean;
    enabledPlacements: ActionUiPlacement[];
    disabledSurfaces: Array<keyof ActionSurfaces>;
    disabledPlacements: ActionUiPlacement[];
    approvalRequiredSurfaces: Array<keyof ActionSurfaces>;
    toolExposureModes: Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>>;
};

export function sortUniqueActionSettingsValues<T extends string>(values: readonly T[]): T[] {
    return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

export function getMutableActionSettingsEntry(settings: ActionsSettingsV1, actionId: ActionSettingsActionId): MutableActionSettingsEntry {
    const entry = settings.actions[actionId];
    return {
        enabled: entry?.enabled,
        enabledPlacements: [...(entry?.enabledPlacements ?? [])],
        disabledSurfaces: [...(entry?.disabledSurfaces ?? [])],
        disabledPlacements: [...(entry?.disabledPlacements ?? [])],
        approvalRequiredSurfaces: [...(entry?.approvalRequiredSurfaces ?? [])],
        toolExposureModes: { ...(entry?.toolExposureModes ?? {}) },
    };
}

function normalizeToolExposureModes(
    modes: Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>>,
): Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>> {
    const normalized: Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>> = {};
    for (const surface of ACTION_TOOL_EXPOSURE_SURFACES) {
        const mode = modes[surface];
        if (mode === 'direct' || mode === 'discoverable_only') {
            normalized[surface] = mode;
        }
    }
    return normalized;
}

function normalizeEntry(entry: MutableActionSettingsEntry) {
    const enabledPlacements = sortUniqueActionSettingsValues(entry.enabledPlacements);
    const disabledSurfaces = sortUniqueActionSettingsValues(entry.disabledSurfaces);
    const disabledPlacements = sortUniqueActionSettingsValues(entry.disabledPlacements);
    const approvalRequiredSurfaces = sortUniqueActionSettingsValues(entry.approvalRequiredSurfaces);
    const toolExposureModes = normalizeToolExposureModes(entry.toolExposureModes);
    const hasToolExposureModes = Object.keys(toolExposureModes).length > 0;

    const normalized = {
        ...(entry.enabled === false ? { enabled: false as const } : {}),
        enabledPlacements,
        disabledSurfaces,
        disabledPlacements,
        approvalRequiredSurfaces,
        ...(hasToolExposureModes ? { toolExposureModes } : {}),
    };

    if (
        normalized.enabled !== false
        && enabledPlacements.length === 0
        && disabledSurfaces.length === 0
        && disabledPlacements.length === 0
        && approvalRequiredSurfaces.length === 0
        && !hasToolExposureModes
    ) {
        return null;
    }

    return normalized;
}

export function writeActionSettingsEntry(settings: ActionsSettingsV1, actionId: ActionSettingsActionId, entry: MutableActionSettingsEntry): ActionsSettingsV1 {
    const normalizedSettings = normalizeActionsSettings(settings);
    const normalizedEntry = normalizeEntry(entry);
    const nextActions: Record<string, unknown> = { ...normalizedSettings.actions };

    if (normalizedEntry) {
        nextActions[actionId] = normalizedEntry;
    } else {
        delete nextActions[actionId];
    }

    return {
        v: 1,
        actions: nextActions as ActionsSettingsV1['actions'],
    };
}

export function getActionSettingsTargetPreferenceSelected(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
}>): boolean {
    const target = resolveActionSettingsTargetDefinition(params);
    const entry = normalizeActionsSettings(params.settings);
    const actionEntry = entry.actions[params.actionId];

    if (target.kind === 'placement') {
        if (isActionSettingsOptInPlacement(target.placement)) {
            return actionEntry?.enabledPlacements.includes(target.placement) === true;
        }
        return actionEntry?.disabledPlacements.includes(target.placement) !== true;
    }

    return actionEntry?.disabledSurfaces.includes(target.surface) !== true;
}

export function getActionSettingsTargetSelected(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
}>): boolean {
    const entry = normalizeActionsSettings(params.settings);
    if (entry.actions[params.actionId]?.enabled === false) {
        return false;
    }

    return getActionSettingsTargetPreferenceSelected(params);
}

export function setActionEnabled(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    enabled: boolean;
}>): ActionsSettingsV1 {
    const normalizedSettings = normalizeActionsSettings(params.settings);
    const entry = getMutableActionSettingsEntry(normalizedSettings, params.actionId);
    entry.enabled = params.enabled ? undefined : false;
    return writeActionSettingsEntry(normalizedSettings, params.actionId, entry);
}

export function setActionTargetSelected(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
    selected: boolean;
}>): ActionsSettingsV1 {
    const normalizedSettings = normalizeActionsSettings(params.settings);
    const entry = getMutableActionSettingsEntry(normalizedSettings, params.actionId);
    const target = resolveActionSettingsTargetDefinition(params);

    if (target.kind === 'placement') {
        if (isActionSettingsOptInPlacement(target.placement)) {
            entry.disabledPlacements = entry.disabledPlacements.filter((placement) => placement !== target.placement);
            entry.enabledPlacements = params.selected
                ? sortUniqueActionSettingsValues([...entry.enabledPlacements, target.placement])
                : entry.enabledPlacements.filter((placement) => placement !== target.placement);
            return writeActionSettingsEntry(normalizedSettings, params.actionId, entry);
        }

        entry.disabledPlacements = params.selected
            ? entry.disabledPlacements.filter((placement) => placement !== target.placement)
            : sortUniqueActionSettingsValues([...entry.disabledPlacements, target.placement]);
        return writeActionSettingsEntry(normalizedSettings, params.actionId, entry);
    }

    entry.disabledSurfaces = params.selected
        ? entry.disabledSurfaces.filter((surface) => surface !== target.surface)
        : sortUniqueActionSettingsValues([...entry.disabledSurfaces, target.surface]);

    return writeActionSettingsEntry(normalizedSettings, params.actionId, entry);
}
