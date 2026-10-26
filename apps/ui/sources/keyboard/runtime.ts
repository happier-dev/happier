import { Platform } from 'react-native';

import { defaultKeyboardCommands } from './commands';
import {
    formatKeybindingLabel,
    matchKeybindingRule,
    parseKeybindingRule,
    readKeybindingRuleModifierShape,
} from './bindings';
import type {
    KeyboardCommandId,
    KeyboardContext,
    KeyboardPlatform,
    KeyboardSurface,
    KeybindingRule,
    NormalizedKeyboardEvent,
} from './types';

export type KeyboardShortcutHandlers = Partial<Record<KeyboardCommandId, () => void>>;

export type KeyboardShortcutDispatcherOptions = Readonly<{
    enabled: boolean;
    enabledWhenDisabledCommandIds?: readonly KeyboardCommandId[];
    platform: KeyboardPlatform;
    surface?: KeyboardSurface;
    singleKeyShortcutsEnabled: boolean;
    disabledCommandIds: readonly string[];
    overrides: Readonly<Record<string, readonly KeybindingRule[]>>;
    handlers: KeyboardShortcutHandlers;
    getContext: () => KeyboardContext;
}>;

export type KeyboardShortcutLabelOptions = Readonly<{
    disabledCommandIds?: readonly string[];
    overrides?: Readonly<Record<string, readonly KeybindingRule[]>>;
    singleKeyShortcutsEnabled?: boolean;
    handlers?: KeyboardShortcutHandlers;
    context?: KeyboardContext;
}>;

export type NativeHardwareKeyboardEventLike = Readonly<{
    key: string;
    code?: string;
    modifiers: Readonly<{
        shift: boolean;
        ctrl: boolean;
        meta: boolean;
        alt: boolean;
    }>;
    repeat: boolean;
}>;

export type NativeHardwareKeyboardAllowedEvent = Readonly<{
    key: string;
    modifiers: Readonly<{
        shift: boolean;
        ctrl: boolean;
        meta: boolean;
        alt: boolean;
    }>;
}>;

export type NativeHardwareKeyboardAllowlist = Readonly<{
    allowedEvents: readonly NativeHardwareKeyboardAllowedEvent[];
}>;

function isSingleKeyRule(rule: KeybindingRule): boolean {
    const parsed = parseKeybindingRule(rule);
    return parsed.mod !== true
        && parsed.alt !== true
        && parsed.ctrl !== true
        && parsed.meta !== true
        && parsed.shift !== true;
}

function getCommandBindings(
    commandId: KeyboardCommandId,
    overrides: Readonly<Record<string, readonly KeybindingRule[]>>,
): readonly KeybindingRule[] {
    const override = overrides[commandId];
    const command = defaultKeyboardCommands.find((entry) => entry.id === commandId);
    if (override && override.length > 0) {
        const defaultAllowInEditable = command?.allowInEditable ?? command?.defaultBindings?.find((rule) => rule.allowInEditable != null)?.allowInEditable
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

export function isKeybindingRuleAvailable(
    rule: KeybindingRule,
    options: Readonly<{
        platform: KeyboardPlatform;
        surface: KeyboardSurface;
        singleKeyShortcutsEnabled: boolean;
    }>,
): boolean {
    const parsed = parseKeybindingRule(rule);
    if (
        parsed.platforms
        && !parsed.platforms.includes(options.platform)
        && !(options.surface === 'web' && parsed.platforms.includes('web'))
    ) {
        return false;
    }
    if (parsed.blockedSurfaces?.includes(options.surface)) return false;
    if (!isNativeHardwareKeybindingAvailable(parsed, options.platform, options.surface)) return false;
    if (!options.singleKeyShortcutsEnabled && isSingleKeyRule(parsed)) return false;
    return true;
}

function isNativeHardwareLimitedPlatform(platform: KeyboardPlatform): boolean {
    return platform === 'ios' || platform === 'android';
}

function nativeAllowedEventForRule(
    rule: KeybindingRule,
    platform: KeyboardPlatform,
    surface: KeyboardSurface,
): NativeHardwareKeyboardAllowedEvent | null {
    if (surface !== 'native' || !isNativeHardwareLimitedPlatform(platform)) return {
        key: '',
        modifiers: { shift: false, ctrl: false, meta: false, alt: false },
    };
    const parsed = parseKeybindingRule(rule);
    if (parsed.allowInEditable !== true) return null;
    const key = parsed.code === 'Enter' || parsed.code === 'NumpadEnter' || parsed.key === 'Enter'
        ? 'Enter'
        : parsed.code === 'Escape' || parsed.key === 'Escape'
          ? 'Escape'
          : null;
    if (!key) return null;
    const modifiers = readKeybindingRuleModifierShape(parsed, platform);
    if (key === 'Enter' && !modifiers.shift && !modifiers.ctrl && !modifiers.meta) return null;
    if (key === 'Enter' && modifiers.alt) return null;
    if (key === 'Escape' && modifiers.alt) return null;
    return { key, modifiers };
}

function isNativeHardwareKeybindingAvailable(
    rule: KeybindingRule,
    platform: KeyboardPlatform,
    surface: KeyboardSurface,
): boolean {
    if (surface !== 'native' || !isNativeHardwareLimitedPlatform(platform)) return true;
    return nativeAllowedEventForRule(rule, platform, surface) != null;
}

function nativeAllowedEventKey(event: NativeHardwareKeyboardAllowedEvent): string {
    return [
        event.key,
        event.modifiers.shift ? 'shift' : '',
        event.modifiers.ctrl ? 'ctrl' : '',
        event.modifiers.meta ? 'meta' : '',
        event.modifiers.alt ? 'alt' : '',
    ].join(':');
}

export function buildNativeHardwareKeyboardAllowlist(options: Readonly<{
    enabled: boolean;
    platform: KeyboardPlatform;
    surface: KeyboardSurface;
    singleKeyShortcutsEnabled: boolean;
    disabledCommandIds: readonly string[];
    overrides: Readonly<Record<string, readonly KeybindingRule[]>>;
    handlers: KeyboardShortcutHandlers;
    getContext: () => KeyboardContext;
}>): NativeHardwareKeyboardAllowlist | null {
    if (!options.enabled || options.surface !== 'native' || !isNativeHardwareLimitedPlatform(options.platform)) return null;
    const context = options.getContext();
    const allowedEventsByKey = new Map<string, NativeHardwareKeyboardAllowedEvent>();
    for (const command of defaultKeyboardCommands) {
        const handler = options.handlers[command.id];
        if (!handler) continue;
        if (options.disabledCommandIds.includes(command.id)) continue;
        if (command.when && !command.when(context)) continue;
        for (const rule of getCommandBindings(command.id, options.overrides)) {
            if (!isKeybindingRuleAvailable(rule, {
                platform: options.platform,
                surface: options.surface,
                singleKeyShortcutsEnabled: options.singleKeyShortcutsEnabled,
            })) continue;
            const allowedEvent = nativeAllowedEventForRule(rule, options.platform, options.surface);
            if (!allowedEvent) continue;
            allowedEventsByKey.set(nativeAllowedEventKey(allowedEvent), allowedEvent);
        }
    }
    const allowedEvents = Array.from(allowedEventsByKey.values());
    return allowedEvents.length > 0 ? { allowedEvents } : null;
}

export function createKeyboardShortcutDispatcher(options: KeyboardShortcutDispatcherOptions) {
    return (event: NormalizedKeyboardEvent): boolean => {
        const surface = options.surface ?? 'native';
        const enabledWhenDisabledCommandIds = options.enabledWhenDisabledCommandIds ?? [];
        if (!options.enabled && enabledWhenDisabledCommandIds.length === 0) return false;
        const context = options.getContext();
        for (const command of defaultKeyboardCommands) {
            if (!options.enabled && !enabledWhenDisabledCommandIds.includes(command.id)) continue;
            const handler = options.handlers[command.id];
            if (!handler) continue;
            if (options.disabledCommandIds.includes(command.id)) continue;
            if (command.when && !command.when(context)) continue;

            for (const rule of getCommandBindings(command.id, options.overrides)) {
                if (!isKeybindingRuleAvailable(rule, {
                    platform: options.platform,
                    surface,
                    singleKeyShortcutsEnabled: options.singleKeyShortcutsEnabled,
                })) continue;
                if (!matchKeybindingRule(parseKeybindingRule(rule), event, {
                    platform: options.platform,
                    surface,
                    context,
                })) continue;
                handler();
                return true;
            }
        }
        return false;
    };
}

export function normalizeNativeHardwareKeyboardEvent(event: NativeHardwareKeyboardEventLike): NormalizedKeyboardEvent {
    return {
        key: event.key,
        code: event.code ?? '',
        altKey: event.modifiers.alt,
        ctrlKey: event.modifiers.ctrl,
        metaKey: event.modifiers.meta,
        shiftKey: event.modifiers.shift,
        repeat: event.repeat,
        isComposing: false,
    };
}

export function normalizeKeyboardEvent(event: KeyboardEvent): NormalizedKeyboardEvent {
    return {
        key: event.key,
        code: event.code,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        isComposing: event.isComposing === true,
    };
}

function isAppleWebPlatform(): boolean {
    if (typeof navigator === 'undefined') return false;
    return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}

export function resolveKeyboardPlatform(): KeyboardPlatform {
    if (Platform.OS === 'ios') return 'ios';
    if (Platform.OS === 'android') return 'android';
    if (Platform.OS === 'web') return isAppleWebPlatform() ? 'macos' : 'windows';
    return 'linux';
}

export function readKeyboardContextFromEventTarget(target: EventTarget | null): KeyboardContext {
    const element = target as HTMLElement | null;
    const tagName = String(element?.tagName ?? '').toLowerCase();
    const isEditableTarget = tagName === 'input'
        || tagName === 'textarea'
        || tagName === 'select'
        || element?.isContentEditable === true
        || element?.closest?.('[contenteditable="true"], [data-keyboard-shortcuts-owned="true"]') != null;
    return {
        isEditableTarget,
        isComposing: false,
    };
}

export function buildKeyboardShortcutLabels(
    platform: KeyboardPlatform,
    surface: KeyboardSurface = 'native',
    options: KeyboardShortcutLabelOptions = {},
): Partial<Record<KeyboardCommandId, string>> {
    return Object.fromEntries(
        defaultKeyboardCommands
            .filter((command) => !options.disabledCommandIds?.includes(command.id))
            .filter((command) => !options.handlers || Boolean(options.handlers[command.id]))
            .filter((command) => !options.context || !command.when || command.when(options.context))
            .map((command) => {
                const binding = getCommandBindings(command.id, options.overrides ?? {})
                    .find((rule) => isKeybindingRuleAvailable(rule, {
                        platform,
                        surface,
                        singleKeyShortcutsEnabled: options.singleKeyShortcutsEnabled !== false,
                    }));
                return binding ? [command.id, formatKeybindingLabel(binding, platform)] : null;
            })
            .filter((entry): entry is [KeyboardCommandId, string] => entry != null),
    ) as Partial<Record<KeyboardCommandId, string>>;
}
