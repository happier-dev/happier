import {
    ACTION_TOOL_EXPOSURE_SURFACES,
    getActionSpec,
    resolveActionToolExposureMode,
    type ActionId,
    type ActionToolExposureMode,
    type ActionToolExposureSurface,
    type ActionsSettingsV1,
} from '@happier-dev/protocol';

import {
    getActionSettingsTargetDefinition,
    type ActionSettingsTargetId,
} from './actionSettingsTargetDefinitions';
import {
    getActionSettingsTargetPreferenceSelected,
    getMutableActionSettingsEntry,
    writeActionSettingsEntry,
} from './actionSettingsTargetSelection';

export type ActionSettingsToolExposureControlValue = 'default' | ActionToolExposureMode;

export type ActionSettingsToolExposureState =
    | Readonly<{
        kind: 'visible';
        value: ActionSettingsToolExposureControlValue;
        defaultMode: ActionToolExposureMode;
        resolvedMode: ActionToolExposureMode;
        explicit: boolean;
        disabled: boolean;
        surface: ActionToolExposureSurface;
    }>
    | Readonly<{ kind: 'hidden' }>;

const TOOL_EXPOSURE_SURFACE_SET = new Set<ActionToolExposureSurface>(ACTION_TOOL_EXPOSURE_SURFACES);

function isToolExposureSurface(surface: string): surface is ActionToolExposureSurface {
    return TOOL_EXPOSURE_SURFACE_SET.has(surface as ActionToolExposureSurface);
}

function resolveToolExposureTarget(params: Readonly<{
    actionId: ActionId;
    targetId: ActionSettingsTargetId;
}>): Readonly<{
    surface: ActionToolExposureSurface;
}> | null {
    const target = getActionSettingsTargetDefinition(params.actionId, params.targetId);
    if (target.kind !== 'surface' || !isToolExposureSurface(target.surface)) {
        return null;
    }
    return { surface: target.surface };
}

function getExplicitToolExposureMode(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    surface: ActionToolExposureSurface;
}>): ActionToolExposureMode | null {
    return params.settings.actions[params.actionId]?.toolExposureModes?.[params.surface] ?? null;
}

export function resolveActionSettingsToolExposureState(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    targetId: ActionSettingsTargetId;
    available?: boolean;
}>): ActionSettingsToolExposureState {
    const resolvedTarget = resolveToolExposureTarget(params);
    if (!resolvedTarget) {
        return { kind: 'hidden' };
    }

    const spec = getActionSpec(params.actionId);
    if (!spec.bindings?.mcpToolName || spec.surfaces[resolvedTarget.surface] !== true) {
        return { kind: 'hidden' };
    }

    const defaultMode = resolveActionToolExposureMode(spec, resolvedTarget.surface);
    const explicitMode = getExplicitToolExposureMode({
        settings: params.settings,
        actionId: params.actionId,
        surface: resolvedTarget.surface,
    });
    const resolvedMode = resolveActionToolExposureMode(spec, resolvedTarget.surface, {
        settings: params.settings,
    });
    const targetSelected = getActionSettingsTargetPreferenceSelected({
        settings: params.settings,
        actionId: params.actionId,
        targetId: params.targetId,
    });

    return {
        kind: 'visible',
        value: explicitMode ?? 'default',
        defaultMode,
        resolvedMode,
        explicit: explicitMode !== null,
        disabled: params.available === false || !targetSelected,
        surface: resolvedTarget.surface,
    };
}

export function setActionSettingsToolExposureMode(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    targetId: ActionSettingsTargetId;
    value: ActionSettingsToolExposureControlValue;
}>): ActionsSettingsV1 {
    const resolvedTarget = resolveToolExposureTarget(params);
    if (!resolvedTarget) {
        return params.settings;
    }

    const spec = getActionSpec(params.actionId);
    if (!spec.bindings?.mcpToolName || spec.surfaces[resolvedTarget.surface] !== true) {
        return params.settings;
    }

    const entry = getMutableActionSettingsEntry(params.settings, params.actionId);
    if (params.value === 'default') {
        delete entry.toolExposureModes[resolvedTarget.surface];
    } else {
        entry.toolExposureModes[resolvedTarget.surface] = params.value;
    }

    return writeActionSettingsEntry(params.settings, params.actionId, entry);
}
