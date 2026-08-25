import type {
    KeyboardContext,
    KeyboardPlatform,
    KeyboardSurface,
    KeybindingRule,
    NormalizedKeyboardEvent,
    ParsedKeybindingRule,
} from './types';

export const browserShortcutConflicts: readonly Readonly<{
    binding: string;
    platforms: readonly KeyboardPlatform[];
    reason: 'browser-reserved';
}>[] = [
    { binding: 'Mod+N', platforms: ['web'], reason: 'browser-reserved' },
    { binding: 'Mod+Shift+N', platforms: ['web'], reason: 'browser-reserved' },
    { binding: 'Mod+K', platforms: ['web'], reason: 'browser-reserved' },
    { binding: 'Mod+T', platforms: ['web'], reason: 'browser-reserved' },
    { binding: 'Mod+W', platforms: ['web'], reason: 'browser-reserved' },
    { binding: 'Ctrl+Tab', platforms: ['web'], reason: 'browser-reserved' },
    { binding: 'Ctrl+Shift+Tab', platforms: ['web'], reason: 'browser-reserved' },
    // The host browser owns address-bar focus, reload and history on the web surface, so the
    // in-app browser chrome binds Alt there instead (see `browser.*` in `commands.ts`).
    { binding: 'Mod+L', platforms: ['web'], reason: 'browser-reserved' },
    { binding: 'Mod+R', platforms: ['web'], reason: 'browser-reserved' },
    { binding: 'Mod+[', platforms: ['web'], reason: 'browser-reserved' },
    { binding: 'Mod+]', platforms: ['web'], reason: 'browser-reserved' },
];

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
};

const semanticKeyFallbacks = new Set([
    'Enter',
    'Escape',
    'Tab',
    'Space',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Backspace',
    'Delete',
    'Slash',
]);

const labelByCode: Readonly<Record<string, string>> = {
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
    Period: '.',
    BracketLeft: '[',
    BracketRight: ']',
    Slash: 'Slash',
};

export function resolveModModifier(platform: KeyboardPlatform): 'meta' | 'ctrl' {
    return platform === 'macos' || platform === 'ios' ? 'meta' : 'ctrl';
}

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

function modifierMatches(
    rule: ParsedKeybindingRule,
    event: NormalizedKeyboardEvent,
    platform: KeyboardPlatform,
): boolean {
    const requiredMod = rule.mod ? resolveModModifier(platform) : null;
    const expectedMeta = rule.meta === true || requiredMod === 'meta';
    const expectedCtrl = rule.ctrl === true || requiredMod === 'ctrl';
    return event.metaKey === expectedMeta
        && event.ctrlKey === expectedCtrl
        && event.altKey === (rule.alt === true)
        && event.shiftKey === (rule.shift === true || rule.key === '?');
}

function platformMatches(
    rule: ParsedKeybindingRule,
    options: Readonly<{ platform: KeyboardPlatform; surface?: KeyboardSurface }>,
): boolean {
    return !rule.platforms
        || rule.platforms.includes(options.platform)
        || (options.surface === 'web' && rule.platforms.includes('web'));
}

export function matchKeybindingRule(
    rule: ParsedKeybindingRule,
    event: NormalizedKeyboardEvent,
    options: Readonly<{ platform: KeyboardPlatform; surface?: KeyboardSurface; context: KeyboardContext }>,
): boolean {
    if (!platformMatches(rule, options)) return false;
    if (options.context.isComposing || event.isComposing || event.repeat) return false;
    if (options.context.isEditableTarget && rule.allowInEditable !== true) return false;
    if (!modifierMatches(rule, event, options.platform)) return false;
    if (rule.code) {
        if (event.code === rule.code) return true;
        return semanticKeyFallbacks.has(rule.code)
            && event.code.length === 0
            && event.key.toLowerCase() === String(rule.key ?? rule.code).toLowerCase();
    }
    return event.key.toLowerCase() === String(rule.key ?? '').toLowerCase();
}

function displayKey(rule: ParsedKeybindingRule): string {
    if (rule.key === '?') return '?';
    if (rule.code?.startsWith('Key')) return rule.code.slice(3);
    if (rule.code?.startsWith('Digit')) return rule.code.slice(5);
    if (rule.code && labelByCode[rule.code]) return labelByCode[rule.code];
    return String(rule.key ?? rule.code ?? '').toUpperCase();
}

export function formatKeybindingLabel(rule: ParsedKeybindingRule | KeybindingRule, platform: KeyboardPlatform): string {
    const parsed = 'code' in rule || 'key' in rule ? rule as ParsedKeybindingRule : parseKeybindingRule(rule);
    const labels: string[] = [];
    if (parsed.mod) labels.push(resolveModModifier(platform) === 'meta' ? 'Cmd' : 'Ctrl');
    if (parsed.ctrl) labels.push('Ctrl');
    if (parsed.meta) labels.push('Cmd');
    if (parsed.alt) labels.push(platform === 'macos' || platform === 'ios' ? 'Option' : 'Alt');
    if (parsed.shift && parsed.key !== '?') labels.push('Shift');
    labels.push(displayKey(parsed));
    return labels.join('+');
}

type KeybindingCaptureNativeEvent = Readonly<{
    key?: string;
    code?: string;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    isComposing?: boolean;
}>;

export type KeybindingCaptureEvent = KeybindingCaptureNativeEvent & Readonly<{
    nativeEvent?: KeybindingCaptureNativeEvent;
}>;

const modifierOnlyKeys = new Set([
    'Alt',
    'AltGraph',
    'Command',
    'Control',
    'Meta',
    'OS',
    'Shift',
]);

function readCaptureEventValue<TKey extends keyof KeybindingCaptureNativeEvent>(
    event: KeybindingCaptureEvent,
    key: TKey,
): KeybindingCaptureNativeEvent[TKey] {
    return event[key] ?? event.nativeEvent?.[key];
}

function keyTokenFromCaptureEvent(event: KeybindingCaptureEvent): string | null {
    const key = readCaptureEventValue(event, 'key') ?? '';
    const code = readCaptureEventValue(event, 'code') ?? '';
    if (modifierOnlyKeys.has(key) || modifierOnlyKeys.has(code.replace(/Left$|Right$/, ''))) return null;
    if (key === '?' || (code === 'Slash' && key === '?')) return '?';
    if (code.startsWith('Key') && code.length === 4) return code.slice(3).toUpperCase();
    if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
    if (labelByCode[code]) return labelByCode[code];
    if (key === ' ') return 'Space';
    if (key.length === 1) return key.toUpperCase();
    return key.length > 0 ? key : null;
}

export function formatKeybindingCaptureEvent(
    event: KeybindingCaptureEvent,
    platform: KeyboardPlatform,
): string | null {
    if (readCaptureEventValue(event, 'isComposing') === true) return null;

    const keyToken = keyTokenFromCaptureEvent(event);
    if (!keyToken) return null;

    const primaryModifier = resolveModModifier(platform);
    const metaKey = readCaptureEventValue(event, 'metaKey') === true;
    const ctrlKey = readCaptureEventValue(event, 'ctrlKey') === true;
    const altKey = readCaptureEventValue(event, 'altKey') === true;
    const shiftKey = readCaptureEventValue(event, 'shiftKey') === true;
    const parts: string[] = [];

    if ((primaryModifier === 'meta' && metaKey) || (primaryModifier === 'ctrl' && ctrlKey)) {
        parts.push('Mod');
    }
    if (ctrlKey && primaryModifier !== 'ctrl') parts.push('Ctrl');
    if (metaKey && primaryModifier !== 'meta') parts.push('Cmd');
    if (altKey) parts.push('Alt');
    if (shiftKey && keyToken !== '?') parts.push('Shift');
    parts.push(keyToken);

    return parts.join('+');
}

export function keybindingRulesAreSemanticallyEqual(
    left: KeybindingRule | string,
    right: KeybindingRule | string,
    platform: KeyboardPlatform,
): boolean {
    return formatKeybindingLabel(parseKeybindingRule(left), platform) === formatKeybindingLabel(parseKeybindingRule(right), platform);
}
