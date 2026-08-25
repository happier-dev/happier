import * as React from 'react';
import { Platform } from 'react-native';

import {
    buildKeyboardShortcutLabels,
    ESCAPE_LAYER_PRIORITIES,
    resolveKeyboardPlatform,
    useEscapeLayer,
    useKeyboardShortcutHandlers,
    type KeyboardShortcutHandlers,
} from '@/keyboard';
import type { BrowserToolbarModel } from '@/sync/domains/browser/shell';

export type BrowserKeyboardCommandId =
    | 'browser.address.focus'
    | 'browser.back'
    | 'browser.forward'
    | 'browser.reload';

export type BrowserKeyboardShortcutLabels = Partial<Record<BrowserKeyboardCommandId, string>>;

/**
 * UB-6: the browser chrome's keyboard shortcuts, registered through the app's ONE keyboard-command
 * owner (`@/keyboard`) so they appear in Settings, respect user rebinding, and take part in the
 * same conflict/priority model as every other command. No second key listener is created here.
 *
 * **Guest↔host policy.** These are HOST shortcuts. The page under the browser frame renders in a
 * sandboxed iframe or a native child webview, so its key events are delivered to that frame's own
 * document (or the native view) and never reach the host listener — a focused guest simply does not
 * see these bindings fire, and they cannot steal a key from it. Symmetrically, `when:
 * !isEditableTarget` on each command keeps them out of the address bar and every other host field.
 *
 * A shortcut is registered ONLY while the active engine can actually fulfil it (the same
 * capability truth the toolbar buttons use). An engine with no history producer never claims
 * Back/Forward, so the key falls through to whatever else wants it instead of dead-ending.
 */
export function useBrowserKeyboardShortcuts(input: Readonly<{
    model: BrowserToolbarModel;
    onFocusAddress: () => void;
    onBack: () => void;
    onForward: () => void;
    onReload: () => void;
    onStop: () => void;
}>): BrowserKeyboardShortcutLabels {
    const { model } = input;
    const onFocusAddress = input.onFocusAddress;
    const onBack = input.onBack;
    const onForward = input.onForward;
    const onReload = input.onReload;
    const onStop = input.onStop;

    const handlers = React.useMemo<KeyboardShortcutHandlers>(() => {
        const next: KeyboardShortcutHandlers = {};
        if (model.canNavigate) next['browser.address.focus'] = onFocusAddress;
        if (model.canGoBack) next['browser.back'] = onBack;
        if (model.canGoForward) next['browser.forward'] = onForward;
        if (model.canReload) next['browser.reload'] = onReload;
        return next;
    }, [
        model.canGoBack,
        model.canGoForward,
        model.canNavigate,
        model.canReload,
        onBack,
        onFocusAddress,
        onForward,
        onReload,
    ]);
    useKeyboardShortcutHandlers(handlers);

    // Escape stops an in-flight load. Routed through the canonical escape stack rather than a
    // keybinding so it can never double-fire with a modal, popover or pane dismissal; it sits at
    // the lowest priority, so Escape only means "stop loading" when nothing else claims it, and it
    // is registered only while a load is actually stoppable.
    useEscapeLayer({
        priority: ESCAPE_LAYER_PRIORITIES.browserStopLoading,
        enabled: model.canStop,
        onEscape: () => {
            if (!model.canStop) return false;
            onStop();
            return true;
        },
    });

    // Labels for the `tooltip` + `KeyHint` surfaces, resolved from the same command registry so a
    // rebound shortcut is never advertised with its stale default.
    return React.useMemo(
        (): BrowserKeyboardShortcutLabels => buildKeyboardShortcutLabels(
            resolveKeyboardPlatform(),
            Platform.OS === 'web' ? 'web' : 'native',
        ),
        [],
    );
}
