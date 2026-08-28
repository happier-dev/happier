import {
    ActionIdSchema,
    getActionSpec,
    parseQualifiedPluginActionId,
    type ActionId,
    type ActionSettingsActionId,
    type ActionSpec,
    type ActionSurfaces,
    type ActionUiPlacement,
    type ActionsSettingsV1,
} from '@happier-dev/protocol';

import type { TranslationKey } from '@/text';

export type ActionSettingsTargetCategory = 'app' | 'voice' | 'integrations';
export type ActionSettingsTargetId =
    | ActionUiPlacement
    | 'mcp'
    | 'agent'
    | 'voice'
    | 'cli'
    | 'api'
    | 'plugin'
    | 'contextual_ui';

export type ActionSettingsSurface = NonNullable<ActionsSettingsV1['actions'][ActionSettingsActionId]>['disabledSurfaces'][number];

export type ActionSettingsTargetSource = Readonly<{
    surfaces: Partial<ActionSurfaces>;
    placements: readonly ActionUiPlacement[];
    slash?: unknown;
    requiredAuthority?: ActionSpec['requiredAuthority'];
}>;

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

const PLACEMENT_TARGETS: readonly ActionSettingsPlacementTargetDefinition[] = [
    {
        id: 'session_header',
        kind: 'placement',
        placement: 'session_header',
        titleKey: 'settingsActions.targets.session_header.title',
        subtitleKey: 'settingsActions.targets.session_header.subtitle',
        icon: 'stack',
        category: 'app',
    },
    {
        id: 'session_action_menu',
        kind: 'placement',
        placement: 'session_action_menu',
        titleKey: 'settingsActions.targets.session_action_menu.title',
        subtitleKey: 'settingsActions.targets.session_action_menu.subtitle',
        icon: 'dots-three',
        category: 'app',
    },
    {
        id: 'session_info',
        kind: 'placement',
        placement: 'session_info',
        titleKey: 'settingsActions.targets.session_info.title',
        subtitleKey: 'settingsActions.targets.session_info.subtitle',
        icon: 'info',
        category: 'app',
    },
    {
        id: 'pending_messages',
        kind: 'placement',
        placement: 'pending_messages',
        titleKey: 'settingsActions.targets.pending_messages.title',
        subtitleKey: 'settingsActions.targets.pending_messages.subtitle',
        icon: 'chat-circle-dots',
        category: 'app',
    },
    {
        id: 'command_palette',
        kind: 'placement',
        placement: 'command_palette',
        titleKey: 'settingsActions.targets.command_palette.title',
        subtitleKey: 'settingsActions.targets.command_palette.subtitle',
        icon: 'magnifying-glass',
        category: 'app',
    },
    {
        id: 'slash_command',
        kind: 'placement',
        placement: 'slash_command',
        titleKey: 'settingsActions.targets.slash_command.title',
        subtitleKey: 'settingsActions.targets.slash_command.subtitle',
        icon: 'code',
        category: 'app',
    },
    {
        id: 'agent_input_chips',
        kind: 'placement',
        placement: 'agent_input_chips',
        titleKey: 'settingsActions.targets.agent_input_chips.title',
        subtitleKey: 'settingsActions.targets.agent_input_chips.subtitle',
        icon: 'plus-circle',
        category: 'app',
    },
    {
        id: 'voice_panel',
        kind: 'placement',
        placement: 'voice_panel',
        titleKey: 'settingsActions.targets.voice_panel.title',
        subtitleKey: 'settingsActions.targets.voice_panel.subtitle',
        icon: 'microphone',
        category: 'voice',
    },
    {
        id: 'run_list',
        kind: 'placement',
        placement: 'run_list',
        titleKey: 'settingsActions.targets.run_list.title',
        subtitleKey: 'settingsActions.targets.run_list.subtitle',
        icon: 'list',
        category: 'app',
    },
    {
        id: 'run_card',
        kind: 'placement',
        placement: 'run_card',
        titleKey: 'settingsActions.targets.run_card.title',
        subtitleKey: 'settingsActions.targets.run_card.subtitle',
        icon: 'file-text',
        category: 'app',
    },
] as const;

const SURFACE_TARGETS: readonly ActionSettingsSurfaceTargetDefinition[] = [
    {
        id: 'voice',
        kind: 'surface',
        surface: 'voice',
        titleKey: 'settingsActions.targets.voice.title',
        subtitleKey: 'settingsActions.targets.voice.subtitle',
        icon: 'microphone',
        category: 'voice',
    },
    {
        id: 'agent',
        kind: 'surface',
        surface: 'agent',
        titleKey: 'settingsActions.targets.agent.title',
        subtitleKey: 'settingsActions.targets.agent.subtitle',
        icon: 'sparkle',
        category: 'integrations',
    },
    {
        id: 'mcp',
        kind: 'surface',
        surface: 'mcp',
        titleKey: 'settingsActions.targets.mcp.title',
        subtitleKey: 'settingsActions.targets.mcp.subtitle',
        icon: 'cube',
        category: 'integrations',
    },
    {
        id: 'cli',
        kind: 'surface',
        surface: 'cli',
        titleKey: 'settingsActions.targets.cli.title',
        subtitleKey: 'settingsActions.targets.cli.subtitle',
        icon: 'terminal',
        category: 'integrations',
    },
    {
        id: 'api',
        kind: 'surface',
        surface: 'api',
        titleKey: 'settingsActions.targets.api.title',
        subtitleKey: 'settingsActions.targets.api.subtitle',
        icon: 'terminal',
        category: 'integrations',
    },
    {
        id: 'plugin',
        kind: 'surface',
        surface: 'plugin',
        titleKey: 'settingsActions.targets.plugin.title',
        subtitleKey: 'settingsActions.targets.plugin.subtitle',
        icon: 'cube',
        category: 'integrations',
    },
    {
        id: 'contextual_ui',
        kind: 'surface',
        surface: 'ui',
        titleKey: 'settingsActions.targets.contextual_ui.title',
        subtitleKey: 'settingsActions.targets.contextual_ui.subtitle',
        icon: 'lightning',
        category: 'app',
    },
] as const;

function isPlacementSupported(spec: ActionSettingsTargetSource, placement: ActionUiPlacement): boolean {
    return spec.placements.includes(placement);
}

function isSurfaceSupported(spec: ActionSettingsTargetSource, surface: ActionSettingsSurface): boolean {
    return spec.surfaces[surface] === true;
}

function shouldExposeContextualUi(spec: ActionSettingsTargetSource): boolean {
    return spec.surfaces.ui === true && spec.placements.length === 0;
}

function buildSyntheticSlashCommandTarget(spec: ActionSettingsTargetSource): ActionSettingsTargetDefinition | null {
    if (isPlacementSupported(spec, 'slash_command')) {
        return null;
    }
    if (!isSurfaceSupported(spec, 'ui') || !spec.slash) {
        return null;
    }
    return {
        id: 'slash_command',
        kind: 'surface',
        surface: 'ui',
        titleKey: 'settingsActions.targets.slash_command.title',
        subtitleKey: 'settingsActions.targets.slash_command.subtitle',
        icon: 'code',
        category: 'app',
    };
}

export function listActionSettingsTargetDefinitions(spec: ActionSettingsTargetSource): readonly ActionSettingsTargetDefinition[] {
    const placementTargets = PLACEMENT_TARGETS.filter((target) => isPlacementSupported(spec, target.placement));
    const surfaceTargets = SURFACE_TARGETS.filter((target) => target.id !== 'contextual_ui' && isSurfaceSupported(spec, target.surface));
    const syntheticTargets: ActionSettingsTargetDefinition[] = [];

    if (shouldExposeContextualUi(spec)) {
        const contextualUiTarget = SURFACE_TARGETS.find((target) => target.id === 'contextual_ui');
        if (contextualUiTarget) {
            syntheticTargets.push(contextualUiTarget);
        }
    }

    const syntheticSlashCommandTarget = buildSyntheticSlashCommandTarget(spec);
    if (syntheticSlashCommandTarget) {
        syntheticTargets.push(syntheticSlashCommandTarget);
    }

    return [...placementTargets, ...surfaceTargets, ...syntheticTargets];
}

export function getActionSettingsTargetDefinition(actionId: ActionId, targetId: ActionSettingsTargetId): ActionSettingsTargetDefinition {
    const target = listActionSettingsTargetDefinitions(getActionSpec(actionId)).find((entry) => entry.id === targetId);
    if (!target) {
        throw new Error(`Unsupported action settings target: ${actionId}:${targetId}`);
    }
    return target;
}

/**
 * The UI has already resolved a target from its current host or contributed
 * descriptor. Reuse that definition for dynamic contributed ids; only host
 * callers without a descriptor may consult the static Action catalog.
 */
export function resolveActionSettingsTargetDefinition(params: Readonly<{
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
}>): ActionSettingsTargetDefinition {
    if (params.target) return params.target;
    const hostActionId = ActionIdSchema.safeParse(params.actionId);
    if (hostActionId.success) {
        return getActionSettingsTargetDefinition(hostActionId.data, params.targetId);
    }

    // Contributed rows always carry their daemon-derived target definition. The direct API and
    // trusted-plugin surfaces are nevertheless stable broad surfaces, so settings writes for a
    // qualified id can still be restored before that daemon contribution is available again.
    if (parseQualifiedPluginActionId(params.actionId)) {
        const target = SURFACE_TARGETS.find((candidate) => candidate.id === params.targetId);
        if (target) return target;
    }

    throw new Error(`Unsupported action settings target: ${params.actionId}:${params.targetId}`);
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
    return targetId === 'voice_panel' || targetId === 'voice';
}

export function isRunScopedPlacement(targetId: ActionSettingsTargetId): boolean {
    return targetId === 'run_list' || targetId === 'run_card';
}
