import * as React from 'react';

import type { HappierLiveStreamInputGesture as LiveStreamInputGesture } from './inputGesture.js';

export type RemoteViewerClipboardResult = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;
export type RemoteViewerClipboardShortcut = (action: 'copy' | 'cut' | 'paste') => Promise<RemoteViewerClipboardResult>;

export const REMOTE_VIEWER_KEYS = ['Escape', 'Tab', 'Enter', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight', 'Home', 'End'] as const;
type KeyGesture = Extract<LiveStreamInputGesture, { kind: 'keyboard_key' }>;
export type RemoteViewerModifier = NonNullable<KeyGesture['modifiers']>[number];
export type RemoteViewerModifierState = 'off' | 'once' | 'locked';
type ModifierStates = Readonly<Record<RemoteViewerModifier, RemoteViewerModifierState>>;
const EMPTY_MODIFIERS: ModifierStates = { alt: 'off', control: 'off', meta: 'off', shift: 'off', fn: 'off' };

export type RemoteViewerActionResult = Readonly<{ ok: true }> | Readonly<{
    ok: false;
    reason: 'clipboard_not_supported' | 'input_not_available' | 'modifier_not_supported';
}>;
export type RemoteViewerKeyboard = Readonly<{
    available: boolean;
    focused: boolean;
    showKeyboard(): void;
    hideKeyboard(): void;
}>;

/** Viewer-local input intent. One-shot modifiers are consumed by a key/click, never pointer motion. */
export function useRemoteViewerActions(input: Readonly<{
    enabled: boolean;
    sendGesture(gesture: LiveStreamInputGesture): void;
    clipboardShortcut?: RemoteViewerClipboardShortcut;
    keyboard?: RemoteViewerKeyboard;
    supportedModifiers?: readonly RemoteViewerModifier[];
}>): RemoteViewerActions {
    const callbacks = React.useRef(input);
    callbacks.current = input;
    const [modifiers, setModifiers] = React.useState(EMPTY_MODIFIERS);
    const currentModifiers = React.useRef(modifiers);
    const publish = React.useCallback((next: ModifierStates) => {
        currentModifiers.current = next;
        setModifiers(next);
    }, []);
    React.useEffect(() => {
        if (!input.enabled && currentModifiers.current !== EMPTY_MODIFIERS) publish(EMPTY_MODIFIERS);
    }, [input.enabled, publish]);
    const tapModifier = React.useCallback((modifier: RemoteViewerModifier, tap?: Readonly<{ clickCount: 2 }>): RemoteViewerActionResult => {
        if (!callbacks.current.enabled) return { ok: false, reason: 'input_not_available' };
        if (callbacks.current.supportedModifiers && !callbacks.current.supportedModifiers.includes(modifier)) {
            return { ok: false, reason: 'modifier_not_supported' };
        }
        const current = currentModifiers.current;
        // The host uses its existing double-tap recognizer; unrelated single taps never lock.
        publish({ ...current, [modifier]: tap?.clickCount === 2 ? 'locked' : current[modifier] === 'off' ? 'once' : 'off' });
        return { ok: true };
    }, [publish]);
    const prepareGesture = React.useCallback((gesture: LiveStreamInputGesture): LiveStreamInputGesture | null => {
        if (!callbacks.current.enabled) return null;
        if (gesture.kind !== 'keyboard_key' && gesture.kind !== 'tap') return gesture;
        const current = currentModifiers.current;
        const active = (Object.keys(current) as RemoteViewerModifier[]).filter(modifier => current[modifier] !== 'off');
        const once = active.filter(modifier => current[modifier] === 'once');
        if (once.length) {
            const next = { ...current };
            for (const modifier of once) next[modifier] = 'off';
            publish(next);
        }
        if (!active.length) return gesture;
        return { ...gesture, modifiers: [...new Set([...(gesture.modifiers ?? []), ...active])] };
    }, [publish]);
    const sendKey = React.useCallback((key: string) => {
        const gesture = prepareGesture({ kind: 'keyboard_key', key });
        if (gesture) callbacks.current.sendGesture(gesture);
    }, [prepareGesture]);
    const sendText = React.useCallback((text: string) => {
        if (!callbacks.current.enabled || !text) return;
        // With a held modifier, typed characters are keys (Ctrl+A); ordinary/IME text stays intact.
        if (Object.values(currentModifiers.current).some(state => state !== 'off')) {
            for (const key of text) sendKey(key);
        } else callbacks.current.sendGesture({ kind: 'keyboard_text', text });
    }, [sendKey]);
    const clipboardAction = React.useCallback(async (action: 'paste' | 'copy'): Promise<RemoteViewerClipboardResult> => {
        if (!callbacks.current.enabled) return { ok: false, reason: 'input_not_available' };
        if (!callbacks.current.clipboardShortcut) return { ok: false, reason: 'clipboard_not_supported' };
        return callbacks.current.clipboardShortcut(action);
    }, []);
    const sendClipboard = React.useCallback(() => clipboardAction('paste'), [clipboardAction]);
    const receiveClipboard = React.useCallback(() => clipboardAction('copy'), [clipboardAction]);
    const clipboard = input.enabled && input.clipboardShortcut ? { available: true as const }
        : { available: false as const, reason: input.enabled ? 'clipboard_not_supported' as const : 'input_not_available' as const };
    return React.useMemo(() => ({ modifiers, tapModifier, prepareGesture, sendKey, sendText, sendClipboard, receiveClipboard,
        clipboard, keyboard: input.keyboard, supportedModifiers: input.supportedModifiers }),
    [modifiers, tapModifier, prepareGesture, sendKey, sendText, sendClipboard, receiveClipboard, clipboard.available,
        'reason' in clipboard ? clipboard.reason : undefined, input.keyboard, input.supportedModifiers]);
}

export type RemoteViewerActions = Readonly<{
    modifiers: ModifierStates;
    tapModifier(modifier: RemoteViewerModifier, tap?: Readonly<{ clickCount: 2 }>): RemoteViewerActionResult;
    prepareGesture(gesture: LiveStreamInputGesture): LiveStreamInputGesture | null;
    sendKey(key: string): void;
    sendText(text: string): void;
    sendClipboard(): Promise<RemoteViewerClipboardResult>;
    receiveClipboard(): Promise<RemoteViewerClipboardResult>;
    clipboard: Readonly<{ available: true }> | Readonly<{ available: false; reason: 'clipboard_not_supported' | 'input_not_available' }>;
    keyboard?: RemoteViewerKeyboard;
    supportedModifiers?: readonly RemoteViewerModifier[];
}>;
