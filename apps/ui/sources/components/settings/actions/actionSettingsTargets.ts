import {
    getActionSpec,
    isActionSettingsOptInPlacement,
    type ActionId,
    type ActionSpec,
    type ActionSurfaces,
    type ActionUiPlacement,
    type ActionsSettingsV1,
} from '@happier-dev/protocol';
import type { TranslationKey } from '@/text';
import { isExecutionRunsFeatureAction } from '@/sync/domains/actions/isExecutionRunsFeatureAction';
import { isInventoryPrivacyAction } from '@/sync/domains/settings/actionSettingsPolicy';
import { normalizeActionsSettings } from './normalizeActionsSettings';

export type ActionSettingsTargetCategory = 'app' | 'voice' | 'integrations';
export type ActionSettingsTargetId =
    | ActionUiPlacement
    | 'mcp'
    | 'session_agent'
    | 'voice_tool'
    | 'voice_action_block'
    | 'cli'
    | 'contextual_ui';

type ActionSettingsSurface = keyof ActionSurfaces;

type ActionSettingsTargetBase = Readonly<{
    id: ActionSettingsTargetId;
    titleKey: Extract<TranslationKey, `settingsActions.targets.${string}.title`>;
    subtitleKey: Extract<TranslationKey, `settingsActions.targets.${string}.subtitle`>;
    icon: string;
    category: ActionSettingsTargetCategory;
}>;

type ActionSettingsPlacementTargetDefinition = ActionSettingsTargetBase & Readonly<{
    kind: 'placement';
    placement: ActionUiPlacement;
}>;

type ActionSettingsSurfaceTargetDefinition = ActionSettingsTargetBase & Readonly<{
    kind: 'surface';
    surface: ActionSettingsSurface;
}>;

export type ActionSettingsTargetDefinition =
    | ActionSettingsPlacementTargetDefinition
    | ActionSettingsSurfaceTargetDefinition;

type MutableActionSettingsEntry = {
    enabled?: boolean;
    enabledPlacements: ActionUiPlacement[];
    disabledSurfaces: Array<keyof ActionSurfaces>;
    disabledPlacements: ActionUiPlacement[];
    approvalRequiredSurfaces: Array<keyof ActionSurfaces>;
};

const PLACEMENT_TARGETS: readonly ActionSettingsPlacementTargetDefinition[] = [
    {
        id: 'session_header',
        kind: 'placement',
        placement: 'session_header',
        titleKey: 'settingsActions.targets.session_header.title',
        subtitleKey: 'settingsActions.targets.session_header.subtitle',
        icon: 'albums-outline',
        category: 'app',
    },
    {
        id: 'session_action_menu',
        kind: 'placement',
        placement: 'session_action_menu',
        titleKey: 'settingsActions.targets.session_action_menu.title',
        subtitleKey: 'settingsActions.targets.session_action_menu.subtitle',
        icon: 'ellipsis-horizontal',
        category: 'app',
    },
    {
        id: 'session_info',
        kind: 'placement',
        placement: 'session_info',
        titleKey: 'settingsActions.targets.session_info.title',
        subtitleKey: 'settingsActions.targets.session_info.subtitle',
        icon: 'information-circle-outline',
        category: 'app',
    },
    {
        id: 'command_palette',
        kind: 'placement',
        placement: 'command_palette',
        titleKey: 'settingsActions.targets.command_palette.title',
        subtitleKey: 'settingsActions.targets.command_palette.subtitle',
        icon: 'search-outline',
        category: 'app',
    },
    {
        id: 'slash_command',
        kind: 'placement',
        placement: 'slash_command',
        titleKey: 'settingsActions.targets.slash_command.title',
        subtitleKey: 'settingsActions.targets.slash_command.subtitle',
        icon: 'code-slash-outline',
        category: 'app',
    },
    {
        id: 'agent_input_chips',
        kind: 'placement',
        placement: 'agent_input_chips',
        titleKey: 'settingsActions.targets.agent_input_chips.title',
        subtitleKey: 'settingsActions.targets.agent_input_chips.subtitle',
        icon: 'add-circle-outline',
        category: 'app',
    },
    {
        id: 'voice_panel',
        kind: 'placement',
        placement: 'voice_panel',
        titleKey: 'settingsActions.targets.voice_panel.title',
        subtitleKey: 'settingsActions.targets.voice_panel.subtitle',
        icon: 'mic-outline',
        category: 'voice',
    },
    {
        id: 'run_list',
        kind: 'placement',
        placement: 'run_list',
        titleKey: 'settingsActions.targets.run_list.title',
        subtitleKey: 'settingsActions.targets.run_list.subtitle',
        icon: 'list-outline',
        category: 'app',
    },
    {
        id: 'run_card',
        kind: 'placement',
        placement: 'run_card',
        titleKey: 'settingsActions.targets.run_card.title',
        subtitleKey: 'settingsActions.targets.run_card.subtitle',
        icon: 'document-text-outline',
        category: 'app',
    },
] as const;

const SURFACE_TARGETS: readonly ActionSettingsSurfaceTargetDefinition[] = [
    {
        id: 'voice_tool',
        kind: 'surface',
        surface: 'voice_tool',
        titleKey: 'settingsActions.targets.voice_tool.title',
        subtitleKey: 'settingsActions.targets.voice_tool.subtitle',
        icon: 'mic-circle-outline',
        category: 'voice',
    },
    {
        id: 'voice_action_block',
        kind: 'surface',
        surface: 'voice_action_block',
        titleKey: 'settingsActions.targets.voice_action_block.title',
        subtitleKey: 'settingsActions.targets.voice_action_block.subtitle',
        icon: 'chatbubble-ellipses-outline',
        category: 'voice',
    },
    {
        id: 'session_agent',
        kind: 'surface',
        surface: 'session_agent',
        titleKey: 'settingsActions.targets.session_agent.title',
        subtitleKey: 'settingsActions.targets.session_agent.subtitle',
        icon: 'sparkles-outline',
        category: 'integrations',
    },
    {
        id: 'mcp',
        kind: 'surface',
        surface: 'mcp',
        titleKey: 'settingsActions.targets.mcp.title',
        subtitleKey: 'settingsActions.targets.mcp.subtitle',
        icon: 'cube-outline',
        category: 'integrations',
    },
    {
        id: 'cli',
        kind: 'surface',
        surface: 'cli',
        titleKey: 'settingsActions.targets.cli.title',
        subtitleKey: 'settingsActions.targets.cli.subtitle',
        icon: 'terminal-outline',
        category: 'integrations',
    },
    {
        id: 'contextual_ui',
        kind: 'surface',
        surface: 'ui_button',
        titleKey: 'settingsActions.targets.contextual_ui.title',
        subtitleKey: 'settingsActions.targets.contextual_ui.subtitle',
        icon: 'flash-outline',
        category: 'app',
    },
] as const;

function sortUnique<T extends string>(values: readonly T[]): T[] {
    return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function getMutableEntry(settings: ActionsSettingsV1, actionId: ActionId): MutableActionSettingsEntry {
    const entry = settings.actions[actionId];
    return {
        enabled: entry?.enabled,
        enabledPlacements: [...(entry?.enabledPlacements ?? [])],
        disabledSurfaces: [...(entry?.disabledSurfaces ?? [])],
        disabledPlacements: [...(entry?.disabledPlacements ?? [])],
        approvalRequiredSurfaces: [...(entry?.approvalRequiredSurfaces ?? [])],
    };
}

function normalizeEntry(entry: MutableActionSettingsEntry) {
    const enabledPlacements = sortUnique(entry.enabledPlacements);
    const disabledSurfaces = sortUnique(entry.disabledSurfaces);
    const disabledPlacements = sortUnique(entry.disabledPlacements);
    const approvalRequiredSurfaces = sortUnique(entry.approvalRequiredSurfaces);

    const normalized = {
        ...(entry.enabled === false ? { enabled: false as const } : {}),
        enabledPlacements,
        disabledSurfaces,
        disabledPlacements,
        approvalRequiredSurfaces,
    };

    if (
        normalized.enabled !== false
        && enabledPlacements.length === 0
        && disabledSurfaces.length === 0
        && disabledPlacements.length === 0
        && approvalRequiredSurfaces.length === 0
    ) {
        return null;
    }

    return normalized;
}

function writeEntry(settings: ActionsSettingsV1, actionId: ActionId, entry: MutableActionSettingsEntry): ActionsSettingsV1 {
    const normalizedSettings = normalizeActionsSettings(settings);
    const normalizedEntry = normalizeEntry(entry);
    const nextActions = { ...normalizedSettings.actions };

    if (normalizedEntry) {
        nextActions[actionId] = normalizedEntry;
    } else {
        delete nextActions[actionId];
    }

    return {
        v: 1,
        actions: nextActions,
    };
}

function isPlacementSupported(spec: ActionSpec, placement: ActionUiPlacement): boolean {
    return spec.placements.includes(placement);
}

function isSurfaceSupported(spec: ActionSpec, surface: ActionSettingsSurface): boolean {
    return spec.surfaces[surface] === true;
}

function shouldExposeContextualUi(spec: ActionSpec): boolean {
    return spec.surfaces.ui_button === true && spec.placements.length === 0;
}

function buildSyntheticSlashCommandTarget(spec: ActionSpec): ActionSettingsTargetDefinition | null {
    if (isPlacementSupported(spec, 'slash_command')) {
        return null;
    }
    if (!isSurfaceSupported(spec, 'ui_slash_command')) {
        return null;
    }
    return {
        id: 'slash_command',
        kind: 'surface',
        surface: 'ui_slash_command',
        titleKey: 'settingsActions.targets.slash_command.title',
        subtitleKey: 'settingsActions.targets.slash_command.subtitle',
        icon: 'code-slash-outline',
        category: 'app',
    };
}

export function listActionSettingsTargetDefinitions(spec: ActionSpec): readonly ActionSettingsTargetDefinition[] {
    const placementTargets = PLACEMENT_TARGETS.filter((target) => isPlacementSupported(spec, target.placement));
    const surfaceTargets = SURFACE_TARGETS.filter((target) => target.id !== 'contextual_ui' && isSurfaceSupported(spec, target.surface));
    const syntheticTargets: ActionSettingsTargetDefinition[] = [];

    if (shouldExposeContextualUi(spec)) {
        syntheticTargets.push(SURFACE_TARGETS.find((target) => target.id === 'contextual_ui')!);
    }

    const syntheticSlashCommandTarget = buildSyntheticSlashCommandTarget(spec);
    if (syntheticSlashCommandTarget) {
        syntheticTargets.push(syntheticSlashCommandTarget);
    }

    return [...placementTargets, ...surfaceTargets, ...syntheticTargets];
}

export function getActionSettingsTargetDefinition(actionId: ActionId, targetId: ActionSettingsTargetId): ActionSettingsTargetDefinition {
    const spec = getActionSpec(actionId);
    const target = listActionSettingsTargetDefinitions(spec).find((entry) => entry.id === targetId);
    if (!target) {
        throw new Error(`Unsupported action settings target: ${actionId}:${targetId}`);
    }
    return target;
}

export function getActionSettingsTargetSelected(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    targetId: ActionSettingsTargetId;
}>): boolean {
    const target = getActionSettingsTargetDefinition(params.actionId, params.targetId);
    const entry = normalizeActionsSettings(params.settings);
    const actionEntry = entry.actions[params.actionId];

    if (actionEntry?.enabled === false) {
        return false;
    }

    if (target.kind === 'placement') {
        if (isActionSettingsOptInPlacement(target.placement)) {
            return actionEntry?.enabledPlacements.includes(target.placement) === true;
        }
        return actionEntry?.disabledPlacements.includes(target.placement) !== true;
    }

    return actionEntry?.disabledSurfaces.includes(target.surface) !== true;
}

export function setActionEnabled(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    enabled: boolean;
}>): ActionsSettingsV1 {
    const normalizedSettings = normalizeActionsSettings(params.settings);
    const entry = getMutableEntry(normalizedSettings, params.actionId);
    entry.enabled = params.enabled ? undefined : false;
    return writeEntry(normalizedSettings, params.actionId, entry);
}

export function setActionTargetSelected(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    targetId: ActionSettingsTargetId;
    selected: boolean;
}>): ActionsSettingsV1 {
    const normalizedSettings = normalizeActionsSettings(params.settings);
    const entry = getMutableEntry(normalizedSettings, params.actionId);
    const target = getActionSettingsTargetDefinition(params.actionId, params.targetId);

    if (target.kind === 'placement') {
        if (isActionSettingsOptInPlacement(target.placement)) {
            entry.disabledPlacements = entry.disabledPlacements.filter((placement) => placement !== target.placement);
            entry.enabledPlacements = params.selected
                ? sortUnique([...entry.enabledPlacements, target.placement])
                : entry.enabledPlacements.filter((placement) => placement !== target.placement);
            return writeEntry(normalizedSettings, params.actionId, entry);
        }

        entry.disabledPlacements = params.selected
            ? entry.disabledPlacements.filter((placement) => placement !== target.placement)
            : sortUnique([...entry.disabledPlacements, target.placement]);
        return writeEntry(normalizedSettings, params.actionId, entry);
    }

    entry.disabledSurfaces = params.selected
        ? entry.disabledSurfaces.filter((surface) => surface !== target.surface)
        : sortUnique([...entry.disabledSurfaces, target.surface]);

    return writeEntry(normalizedSettings, params.actionId, entry);
}

export function getActionTargetApprovalRequired(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    targetId: ActionSettingsTargetId;
}>): boolean {
    const normalizedSettings = normalizeActionsSettings(params.settings);
    const entry = normalizedSettings.actions[params.actionId];
    if (!entry) {
        return false;
    }

    const surface = resolveActionSettingsApprovalSurface(params.actionId, params.targetId);
    if (!surface) {
        return false;
    }

    return entry.approvalRequiredSurfaces?.includes(surface) === true;
}

export function resolveActionSettingsApprovalSurface(actionId: ActionId, targetId: ActionSettingsTargetId): keyof ActionSurfaces | null {
    const target = getActionSettingsTargetDefinition(actionId, targetId);
    if (target.kind === 'surface') {
        return target.surface;
    }

    // `slash_command` is modeled as a placement for UI surfacing, but approvals are surface-scoped.
    // Treat the slash command tile as configuring the `ui_slash_command` surface approvals gate.
    if (target.kind === 'placement' && target.placement === 'slash_command') {
        return 'ui_slash_command';
    }

    return null;
}

export function setActionTargetApprovalRequired(params: Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionId;
    targetId: ActionSettingsTargetId;
    approvalRequired: boolean;
}>): ActionsSettingsV1 {
    const normalizedSettings = normalizeActionsSettings(params.settings);
    const entry = getMutableEntry(normalizedSettings, params.actionId);
    const surface = resolveActionSettingsApprovalSurface(params.actionId, params.targetId);
    if (!surface) {
        return normalizedSettings;
    }

    entry.approvalRequiredSurfaces = params.approvalRequired
        ? sortUnique([...entry.approvalRequiredSurfaces, surface])
        : entry.approvalRequiredSurfaces.filter((value) => value !== surface);

    return writeEntry(normalizedSettings, params.actionId, entry);
}

export function getActionSettingsTargetContext(target: ActionSettingsTargetDefinition):
    | Readonly<{ placement: ActionUiPlacement }>
    | Readonly<{ surface: keyof ActionSurfaces }>
{
    if (target.kind === 'placement') {
        return { placement: target.placement };
    }
    return { surface: target.surface };
}

export function isVoiceTargetId(targetId: ActionSettingsTargetId): boolean {
    return targetId === 'voice_panel' || targetId === 'voice_tool' || targetId === 'voice_action_block';
}

export function isRunScopedPlacement(targetId: ActionSettingsTargetId): boolean {
    return targetId === 'run_list' || targetId === 'run_card';
}

export function isMcpTarget(targetId: ActionSettingsTargetId): boolean {
    return targetId === 'mcp';
}
