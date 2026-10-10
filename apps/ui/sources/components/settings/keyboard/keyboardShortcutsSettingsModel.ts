import { defaultKeyboardCommands } from '@/keyboard/commands';
import { browserShortcutConflicts, formatKeybindingLabel, keybindingRulesAreSemanticallyEqual, parseKeybindingRule } from '@/keyboard/bindings';
import { isKeybindingRuleAvailable } from '@/keyboard/runtime';
import type {
    KeyboardCommandId,
    KeyboardCommandSettingsTitleKey,
    KeyboardPlatform,
    KeyboardSurface,
    KeybindingRule,
} from '@/keyboard/types';
import type { Settings } from '@/sync/domains/settings/settings';

export type KeyboardShortcutSettingsConflict = Readonly<{
    id: string;
    kind: 'browser-reserved' | 'duplicate';
    commandIds: readonly KeyboardCommandId[];
}>;

export type KeyboardShortcutSettingsCommandRow = Readonly<{
    commandId: KeyboardCommandId;
    titleKey: KeyboardCommandSettingsTitleKey;
    bindingValue: string | null;
    /** The shortcut that runs the command now (a custom one when set, else the registry default). */
    defaultLabel: string | null;
    /** The registry default, which reset restores. */
    registryDefaultLabel: string | null;
    disabled: boolean;
    hasOverride: boolean;
}>;

/** The part of the app a command acts on; settings list commands under these headings. */
export type KeyboardShortcutCommandGroupId = 'general' | 'sessions' | 'composer' | 'transcript' | 'splitView' | 'browser';

export type KeyboardShortcutSettingsCommandGroup = Readonly<{
    id: KeyboardShortcutCommandGroupId;
    rows: readonly KeyboardShortcutSettingsCommandRow[];
}>;

export const KEYBOARD_SHORTCUT_COMMAND_GROUP_ORDER: readonly KeyboardShortcutCommandGroupId[] = [
    'general', 'sessions', 'composer', 'transcript', 'splitView', 'browser',
];

/** Commands are grouped by their id's area; anything new and unrecognised lands under General. */
export function resolveKeyboardShortcutCommandGroupId(commandId: KeyboardCommandId): KeyboardShortcutCommandGroupId {
    const area = commandId.split('.')[0];
    switch (area) {
        case 'session':
        case 'sessions':
            return 'sessions';
        case 'composer':
        case 'mode':
        case 'permission':
            return 'composer';
        case 'transcript':
            return 'transcript';
        case 'workspace':
            return 'splitView';
        case 'browser':
            return 'browser';
        default:
            return 'general';
    }
}

export type KeyboardShortcutSettingsModel = Readonly<{
    shortcutsEnabled: boolean;
    singleKeyShortcutsEnabled: boolean;
    commandRows: readonly KeyboardShortcutSettingsCommandRow[];
    commandGroups: readonly KeyboardShortcutSettingsCommandGroup[];
    conflicts: readonly KeyboardShortcutSettingsConflict[];
}>;

type ShortcutSettingsSubset = Pick<
    Settings,
    | 'commandPaletteEnabled'
    | 'keyboardShortcutsV2Enabled'
    | 'keyboardSingleKeyShortcutsEnabled'
    | 'keyboardShortcutDisabledCommandIdsV1'
    | 'keyboardShortcutOverridesV1'
>;


function commandIdSort(left: KeyboardCommandId, right: KeyboardCommandId): number {
    return left.localeCompare(right);
}

function getEffectiveBindings(
    commandId: KeyboardCommandId,
    overrides: Readonly<Record<string, readonly KeybindingRule[]>>,
): readonly KeybindingRule[] {
    const override = overrides[commandId];
    const command = defaultKeyboardCommands.find((entry) => entry.id === commandId);
    if (override && override.length > 0) {
        const defaultAllowInEditable = command?.defaultBindings?.find((rule) => rule.allowInEditable != null)?.allowInEditable
            ?? command?.defaultBinding?.allowInEditable;
        return override.map((rule) => (
            rule.allowInEditable == null && defaultAllowInEditable != null
                ? { ...rule, allowInEditable: defaultAllowInEditable }
                : rule
        ));
    }
    if (command?.defaultBindings && command.defaultBindings.length > 0) return command.defaultBindings;
    return command?.defaultBinding ? [command.defaultBinding] : [];
}

function getActiveEffectiveBindings(params: Readonly<{
    commandId: KeyboardCommandId;
    overrides: Readonly<Record<string, readonly KeybindingRule[]>>;
    platform: KeyboardPlatform;
    surface: KeyboardSurface;
    singleKeyShortcutsEnabled: boolean;
}>): readonly KeybindingRule[] {
    return getEffectiveBindings(params.commandId, params.overrides)
        .filter((binding) => isKeybindingRuleAvailable(binding, {
            platform: params.platform,
            surface: params.surface,
            singleKeyShortcutsEnabled: params.singleKeyShortcutsEnabled,
        }));
}


function buildBrowserReservedConflicts(params: Readonly<{
    surface: KeyboardSurface;
    platform: KeyboardPlatform;
    disabledIds: ReadonlySet<string>;
    overrides: Readonly<Record<string, readonly KeybindingRule[]>>;
    singleKeyShortcutsEnabled: boolean;
}>): readonly KeyboardShortcutSettingsConflict[] {
    if (params.surface !== 'web') return [];

    return defaultKeyboardCommands.flatMap((command) => {
        if (params.disabledIds.has(command.id)) return [];
        const activeBindings = getActiveEffectiveBindings({
            commandId: command.id,
            overrides: params.overrides,
            platform: params.platform,
            surface: params.surface,
            singleKeyShortcutsEnabled: params.singleKeyShortcutsEnabled,
        });
        const hasConflict = activeBindings.some((binding) => browserShortcutConflicts.some((entry) => (
            entry.platforms.includes('web')
            && keybindingRulesAreSemanticallyEqual(binding, entry.binding, params.platform)
        )));
        return hasConflict
            ? [{ id: `browser-reserved:${command.id}`, kind: 'browser-reserved' as const, commandIds: [command.id] }]
            : [];
    });
}

function buildDuplicateBindingConflicts(params: Readonly<{
    platform: KeyboardPlatform;
    surface: KeyboardSurface;
    disabledIds: ReadonlySet<string>;
    overrides: Readonly<Record<string, readonly KeybindingRule[]>>;
    singleKeyShortcutsEnabled: boolean;
}>): readonly KeyboardShortcutSettingsConflict[] {
    const commandIdsByLabel = new Map<string, KeyboardCommandId[]>();

    for (const command of defaultKeyboardCommands) {
        if (params.disabledIds.has(command.id)) continue;
        for (const binding of getActiveEffectiveBindings({
            commandId: command.id,
            overrides: params.overrides,
            platform: params.platform,
            surface: params.surface,
            singleKeyShortcutsEnabled: params.singleKeyShortcutsEnabled,
        })) {
            const conflictScope = binding.conflictScope ?? 'global';
            const label = `${conflictScope}:${formatKeybindingLabel(parseKeybindingRule(binding), params.platform)}`;
            const current = commandIdsByLabel.get(label) ?? [];
            if (!current.includes(command.id)) current.push(command.id);
            commandIdsByLabel.set(label, current);
        }
    }

    return Array.from(commandIdsByLabel.values())
        .map((commandIds) => [...commandIds].sort(commandIdSort))
        .filter((commandIds) => commandIds.length > 1)
        .map((commandIds) => ({
            id: `duplicate:${commandIds.join(':')}`,
            kind: 'duplicate' as const,
            commandIds,
        }));
}

export function buildKeyboardShortcutSettingsModel(params: Readonly<{
    settings: ShortcutSettingsSubset;
    platform: KeyboardPlatform;
    surface: KeyboardSurface;
}>): KeyboardShortcutSettingsModel {
    const disabledIds = new Set(params.settings.keyboardShortcutDisabledCommandIdsV1);
    if (params.settings.commandPaletteEnabled !== true) {
        disabledIds.add('commandPalette.open');
    }
    const overrides = params.settings.keyboardShortcutOverridesV1;
    const singleKeyShortcutsEnabled = params.settings.keyboardSingleKeyShortcutsEnabled === true;
    const commandRows = defaultKeyboardCommands.map((command): KeyboardShortcutSettingsCommandRow => {
        const effectiveBinding = getActiveEffectiveBindings({
            commandId: command.id,
            overrides,
            platform: params.platform,
            surface: params.surface,
            singleKeyShortcutsEnabled,
        })[0] ?? getEffectiveBindings(command.id, overrides)[0] ?? null;
        const defaultLabel = effectiveBinding
            ? formatKeybindingLabel(effectiveBinding, params.platform)
            : null;
        const registryBinding = getActiveEffectiveBindings({
            commandId: command.id,
            overrides: {},
            platform: params.platform,
            surface: params.surface,
            singleKeyShortcutsEnabled,
        })[0] ?? getEffectiveBindings(command.id, {})[0] ?? null;
        return {
            commandId: command.id,
            titleKey: command.settingsTitleKey,
            bindingValue: effectiveBinding?.binding ?? null,
            defaultLabel,
            registryDefaultLabel: registryBinding ? formatKeybindingLabel(registryBinding, params.platform) : null,
            disabled: disabledIds.has(command.id),
            hasOverride: Boolean(overrides[command.id]?.length),
        };
    });

    return {
        shortcutsEnabled: params.settings.keyboardShortcutsV2Enabled === true,
        singleKeyShortcutsEnabled,
        commandRows,
        commandGroups: KEYBOARD_SHORTCUT_COMMAND_GROUP_ORDER
            .map((id) => ({ id, rows: commandRows.filter((row) => resolveKeyboardShortcutCommandGroupId(row.commandId) === id) }))
            .filter((group) => group.rows.length > 0),
        conflicts: [
            ...buildBrowserReservedConflicts({
                surface: params.surface,
                platform: params.platform,
                disabledIds,
                overrides,
                singleKeyShortcutsEnabled,
            }),
            ...buildDuplicateBindingConflicts({
                platform: params.platform,
                surface: params.surface,
                disabledIds,
                overrides,
                singleKeyShortcutsEnabled,
            }),
        ],
    };
}

export { buildKeyboardShortcutToggleDelta, buildKeyboardShortcutResetDelta, buildKeyboardShortcutSetDelta } from '@happier-dev/protocol/actions/settings/keyboardPreferenceMutations';
