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
    defaultLabel: string | null;
    disabled: boolean;
    hasOverride: boolean;
}>;

export type KeyboardShortcutSettingsModel = Readonly<{
    shortcutsEnabled: boolean;
    singleKeyShortcutsEnabled: boolean;
    commandRows: readonly KeyboardShortcutSettingsCommandRow[];
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

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type KeyboardShortcutToggleDelta =
    & Mutable<Pick<Settings, 'keyboardShortcutDisabledCommandIdsV1'>>
    & Partial<Mutable<Pick<Settings, 'commandPaletteEnabled'>>>;

type KeyboardShortcutResetDelta =
    & Mutable<Pick<Settings, 'keyboardShortcutDisabledCommandIdsV1' | 'keyboardShortcutOverridesV1'>>
    & Partial<Mutable<Pick<Settings, 'commandPaletteEnabled'>>>;

type KeyboardShortcutSetDelta =
    & Mutable<Pick<Settings, 'keyboardShortcutDisabledCommandIdsV1' | 'keyboardShortcutOverridesV1'>>
    & Partial<Mutable<Pick<Settings, 'commandPaletteEnabled'>>>;

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

function clonePersistedKeybindingRule(binding: KeybindingRule): Settings['keyboardShortcutOverridesV1'][string][number] {
    return {
        binding: binding.binding,
        ...(binding.platforms ? { platforms: [...binding.platforms] } : {}),
        ...(binding.blockedSurfaces ? { blockedSurfaces: [...binding.blockedSurfaces] } : {}),
        ...(binding.allowInEditable != null ? { allowInEditable: binding.allowInEditable } : {}),
        ...(binding.nativeConsumable != null ? { nativeConsumable: binding.nativeConsumable } : {}),
        ...(binding.conflictScope != null ? { conflictScope: binding.conflictScope } : {}),
    };
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
            current.push(command.id);
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
        return {
            commandId: command.id,
            titleKey: command.settingsTitleKey,
            bindingValue: effectiveBinding?.binding ?? null,
            defaultLabel,
            disabled: disabledIds.has(command.id),
            hasOverride: Boolean(overrides[command.id]?.length),
        };
    });

    return {
        shortcutsEnabled: params.settings.keyboardShortcutsV2Enabled === true,
        singleKeyShortcutsEnabled,
        commandRows,
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

export function buildKeyboardShortcutToggleDelta(
    disabledCommandIds: readonly string[],
    commandId: KeyboardCommandId,
    disabled: boolean,
): KeyboardShortcutToggleDelta {
    const next = new Set(disabledCommandIds);
    if (disabled) {
        next.add(commandId);
    } else {
        next.delete(commandId);
    }
    const delta: KeyboardShortcutToggleDelta = {
        keyboardShortcutDisabledCommandIdsV1: Array.from(next),
    };
    if (commandId === 'commandPalette.open') {
        delta.commandPaletteEnabled = !disabled;
    }
    return delta;
}

export function buildKeyboardShortcutResetDelta(params: Readonly<{
    disabledCommandIds: readonly string[];
    overrides: Readonly<Record<string, readonly KeybindingRule[]>>;
    commandId: KeyboardCommandId;
}>): KeyboardShortcutResetDelta {
    const nextOverrides = { ...params.overrides };
    delete nextOverrides[params.commandId];
    const keyboardShortcutOverridesV1 = Object.fromEntries(
        Object.entries(nextOverrides).map(([commandId, bindings]) => [
            commandId,
            bindings.map(clonePersistedKeybindingRule),
        ]),
    ) satisfies Settings['keyboardShortcutOverridesV1'];
    return {
        ...buildKeyboardShortcutToggleDelta(params.disabledCommandIds, params.commandId, false),
        keyboardShortcutOverridesV1,
    };
}

export function buildKeyboardShortcutSetDelta(params: Readonly<{
    disabledCommandIds: readonly string[];
    overrides: Readonly<Record<string, readonly KeybindingRule[]>>;
    commandId: KeyboardCommandId;
    binding: string;
}>): KeyboardShortcutSetDelta | null {
    const binding = params.binding.trim();
    if (binding.length === 0) return null;
    const parsed = parseKeybindingRule(binding);
    if (!parsed.key && !parsed.code) return null;

    const keyboardShortcutOverridesV1 = Object.fromEntries([
        ...Object.entries(params.overrides).map(([commandId, bindings]) => [
            commandId,
            bindings.map(clonePersistedKeybindingRule),
        ] as const),
        [params.commandId, [{ binding }]],
    ]) satisfies Settings['keyboardShortcutOverridesV1'];

    return {
        ...buildKeyboardShortcutToggleDelta(params.disabledCommandIds, params.commandId, false),
        keyboardShortcutOverridesV1,
    };
}
