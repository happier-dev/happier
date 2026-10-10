import type { AccountSettings } from '../../account/settings/accountSettings.js';
export type KeybindingRule = Readonly<{ binding: string; platforms?: readonly ('macos' | 'ios' | 'windows' | 'linux' | 'android' | 'web')[]; blockedSurfaces?: readonly ('native' | 'web')[]; webHost?: 'browser' | 'desktop'; allowInEditable?: boolean; nativeConsumable?: boolean; conflictScope?: string }>;
export type ParsedKeybindingRule = KeybindingRule & Readonly<{ key?: string; code?: string; mod?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }>;
type KeyboardPlatform = NonNullable<KeybindingRule['platforms']>[number];
type KeyboardSurface = NonNullable<KeybindingRule['blockedSurfaces']>[number];
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type KeyboardShortcutToggleDelta =
    & Mutable<Pick<AccountSettings, 'keyboardShortcutDisabledCommandIdsV1'>>
    & Partial<Mutable<Pick<AccountSettings, 'commandPaletteEnabled'>>>;

type KeyboardShortcutResetDelta =
    & Mutable<Pick<AccountSettings, 'keyboardShortcutDisabledCommandIdsV1' | 'keyboardShortcutOverridesV1'>>
    & Partial<Mutable<Pick<AccountSettings, 'commandPaletteEnabled'>>>;

type KeyboardShortcutSetDelta =
    & Mutable<Pick<AccountSettings, 'keyboardShortcutDisabledCommandIdsV1' | 'keyboardShortcutOverridesV1'>>
    & Partial<Mutable<Pick<AccountSettings, 'commandPaletteEnabled'>>>;

const codeByDisplayKey: Readonly<Record<string, string>> = {
    Enter: 'Enter',
    Escape: 'Escape',
    Tab: 'Tab',
    Space: 'Space',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Backspace: 'Backspace',
    Delete: 'Delete',
    '.': 'Period',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    Slash: 'Slash',
    '?': 'Slash',
    '`': 'Backquote',
    '\\': 'Backslash',
};

function codeForToken(token: string): string | undefined {
    if (/^[A-Z]$/.test(token)) return `Key${token}`;
    if (/^[0-9]$/.test(token)) return `Digit${token}`;
    return codeByDisplayKey[token];
}

export function parseKeybindingRule(bindingOrRule: string | KeybindingRule): ParsedKeybindingRule {
    const rule = typeof bindingOrRule === 'string' ? { binding: bindingOrRule } : bindingOrRule;
    const parts = rule.binding.split('+').map((part) => part.trim()).filter(Boolean);
    const parsed: {
        binding: string;
        platforms?: readonly KeyboardPlatform[];
        blockedSurfaces?: readonly KeyboardSurface[];
        allowInEditable?: boolean;
        key?: string;
        code?: string;
        mod?: boolean;
        alt?: boolean;
        ctrl?: boolean;
        meta?: boolean;
        shift?: boolean;
    } = {
        ...rule,
        binding: rule.binding,
    };

    for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower === 'mod') parsed.mod = true;
        else if (lower === 'ctrl' || lower === 'control') parsed.ctrl = true;
        else if (lower === 'cmd' || lower === 'command' || lower === 'meta') parsed.meta = true;
        else if (lower === 'shift') parsed.shift = true;
        else if (lower === 'alt' || lower === 'option') parsed.alt = true;
        else {
            const normalizedKey = part.length === 1 ? part.toUpperCase() : part;
            parsed.key = part.length === 1 ? part.toLowerCase() : part;
            parsed.code = codeForToken(normalizedKey);
        }
    }

    return parsed;
}

function clonePersistedKeybindingRule(binding: KeybindingRule): AccountSettings['keyboardShortcutOverridesV1'][string][number] {
    return {
        binding: binding.binding,
        ...(binding.platforms ? { platforms: [...binding.platforms] } : {}),
        ...(binding.blockedSurfaces ? { blockedSurfaces: [...binding.blockedSurfaces] } : {}),
        ...(binding.allowInEditable != null ? { allowInEditable: binding.allowInEditable } : {}),
        ...(binding.nativeConsumable != null ? { nativeConsumable: binding.nativeConsumable } : {}),
        ...(binding.conflictScope != null ? { conflictScope: binding.conflictScope } : {}),
    };
}

export function buildKeyboardShortcutToggleDelta(
    disabledCommandIds: readonly string[],
    commandId: string,
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
    commandId: string;
}>): KeyboardShortcutResetDelta {
    const nextOverrides = { ...params.overrides };
    delete nextOverrides[params.commandId];
    const keyboardShortcutOverridesV1 = Object.fromEntries(
        Object.entries(nextOverrides).map(([commandId, bindings]) => [
            commandId,
            bindings.map(clonePersistedKeybindingRule),
        ]),
    ) satisfies AccountSettings['keyboardShortcutOverridesV1'];
    return {
        ...buildKeyboardShortcutToggleDelta(params.disabledCommandIds, params.commandId, false),
        keyboardShortcutOverridesV1,
    };
}

export function buildKeyboardShortcutSetDelta(params: Readonly<{
    disabledCommandIds: readonly string[];
    overrides: Readonly<Record<string, readonly KeybindingRule[]>>;
    commandId: string;
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
    ]) satisfies AccountSettings['keyboardShortcutOverridesV1'];


    return {
        ...buildKeyboardShortcutToggleDelta(params.disabledCommandIds, params.commandId, false),
        keyboardShortcutOverridesV1,
    };
}
