import { Platform } from 'react-native';

import { defaultKeyboardCommands } from './commands';
import { formatKeybindingLabel, matchKeybindingRule, parseKeybindingRule } from './bindings';
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
    if (!options.singleKeyShortcutsEnabled && isSingleKeyRule(parsed)) return false;
    return true;
}

function commandCanRunWhenDisabled(
    commandId: KeyboardCommandId,
    enabled: boolean,
    enabledWhenDisabledCommandIds: readonly KeyboardCommandId[],
): boolean {
    return enabled || enabledWhenDisabledCommandIds.includes(commandId);
}

function resolveNativeConsumableKey(
    rule: KeybindingRule,
    nativeConsumable: boolean,
): 'Enter' | 'Escape' | null {
    if (!nativeConsumable) return null;
    const parsed = parseKeybindingRule(rule);
    if (parsed.code === 'Enter' || parsed.key === 'Enter') return 'Enter';
    if (parsed.code === 'Escape' || parsed.key === 'Escape') return 'Escape';
    return null;
}

function buildNativeConsumableSignature(
    rule: KeybindingRule,
    platform: KeyboardPlatform,
    nativeConsumable: boolean,
): string | null {
    const key = resolveNativeConsumableKey(rule, nativeConsumable);
    if (!key) return null;
    const parsed = parseKeybindingRule(rule);
    const mod = parsed.mod ? resolveNativeConsumableMod(platform) : null;
    return [
        key,
        `shift=${parsed.shift === true}`,
        `ctrl=${parsed.ctrl === true || mod === 'ctrl'}`,
        `meta=${parsed.meta === true || mod === 'meta'}`,
        `alt=${parsed.alt === true}`,
    ].join('|');
}

function resolveNativeConsumableMod(platform: KeyboardPlatform): 'meta' | 'ctrl' {
    return platform === 'macos' || platform === 'ios' ? 'meta' : 'ctrl';
}

export function commandHasAvailableKeyboardHandler(params: Readonly<{
    commandId: KeyboardCommandId;
    enabled: boolean;
    enabledWhenDisabledCommandIds?: readonly KeyboardCommandId[];
    platform: KeyboardPlatform;
    surface: KeyboardSurface;
    singleKeyShortcutsEnabled: boolean;
    disabledCommandIds: readonly string[];
    overrides: Readonly<Record<string, readonly KeybindingRule[]>>;
    handlers: KeyboardShortcutHandlers;
    context: KeyboardContext;
}>): boolean {
    if (!commandCanRunWhenDisabled(params.commandId, params.enabled, params.enabledWhenDisabledCommandIds ?? [])) return false;
    if (params.disabledCommandIds.includes(params.commandId)) return false;
    if (!params.handlers[params.commandId]) return false;
    const command = defaultKeyboardCommands.find((entry) => entry.id === params.commandId);
    if (!command) return false;
    if (command.when && !command.when(params.context)) return false;
    return getCommandBindings(params.commandId, params.overrides).some((rule) => isKeybindingRuleAvailable(rule, {
        platform: params.platform,
        surface: params.surface,
        singleKeyShortcutsEnabled: params.singleKeyShortcutsEnabled,
    }));
}

export function hasAnyAvailableKeyboardHandler(options: KeyboardShortcutDispatcherOptions): boolean {
    const surface = options.surface ?? 'native';
    const context = options.getContext();
    return defaultKeyboardCommands.some((command) => commandHasAvailableKeyboardHandler({
        commandId: command.id,
        enabled: options.enabled,
        enabledWhenDisabledCommandIds: options.enabledWhenDisabledCommandIds,
        platform: options.platform,
        surface,
        singleKeyShortcutsEnabled: options.singleKeyShortcutsEnabled,
        disabledCommandIds: options.disabledCommandIds,
        overrides: options.overrides,
        handlers: options.handlers,
        context,
    }));
}

export function resolveNativeHardwareKeyboardConsumableEventSignatures(
    options: KeyboardShortcutDispatcherOptions,
): readonly string[] {
    const surface = options.surface ?? 'native';
    const context = options.getContext();
    const signatures = new Set<string>();

    for (const command of defaultKeyboardCommands) {
        if (!commandHasAvailableKeyboardHandler({
            commandId: command.id,
            enabled: options.enabled,
            enabledWhenDisabledCommandIds: options.enabledWhenDisabledCommandIds,
            platform: options.platform,
            surface,
            singleKeyShortcutsEnabled: options.singleKeyShortcutsEnabled,
            disabledCommandIds: options.disabledCommandIds,
            overrides: options.overrides,
            handlers: options.handlers,
            context,
        })) {
            continue;
        }

        for (const rule of getCommandBindings(command.id, options.overrides)) {
            if (!isKeybindingRuleAvailable(rule, {
                platform: options.platform,
                surface,
                singleKeyShortcutsEnabled: options.singleKeyShortcutsEnabled,
            })) {
                continue;
            }
            const signature = buildNativeConsumableSignature(
                rule,
                options.platform,
                rule.nativeConsumable === true || command.defaultBinding?.nativeConsumable === true,
            );
            if (signature) {
                signatures.add(signature);
            }
        }
    }

    return Array.from(signatures);
}

export function createKeyboardShortcutDispatcher(options: KeyboardShortcutDispatcherOptions) {
    return (event: NormalizedKeyboardEvent): boolean => {
        const surface = options.surface ?? 'native';
        if (!options.enabled && (options.enabledWhenDisabledCommandIds ?? []).length === 0) return false;
        const context = options.getContext();
        for (const command of defaultKeyboardCommands) {
            if (!commandHasAvailableKeyboardHandler({
                commandId: command.id,
                enabled: options.enabled,
                enabledWhenDisabledCommandIds: options.enabledWhenDisabledCommandIds,
                platform: options.platform,
                surface,
                singleKeyShortcutsEnabled: options.singleKeyShortcutsEnabled,
                disabledCommandIds: options.disabledCommandIds,
                overrides: options.overrides,
                handlers: options.handlers,
                context,
            })) continue;

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
                options.handlers[command.id]?.();
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
    const singleKeyShortcutsEnabled = options.singleKeyShortcutsEnabled === true;
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
                        singleKeyShortcutsEnabled,
                    }));
                return binding ? [command.id, formatKeybindingLabel(binding, platform)] : null;
            })
            .filter((entry): entry is [KeyboardCommandId, string] => entry != null),
    ) as Partial<Record<KeyboardCommandId, string>>;
}
