import * as React from 'react';

import {
    ESCAPE_LAYER_PRIORITIES,
    useEscapeLayer,
    useKeyboardShortcutHandlers,
    useKeyboardShortcutLabel,
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
 * Embedded engines receive these active command signatures through the keyboard owner. A
 * matching guest chord returns to the same dispatcher, including from a guest field; unrelated
 * keys remain with the guest. There is no independent guest shortcut registry.
 *
 * A shortcut is registered ONLY while the active engine can actually fulfil it (the same
 * capability truth the toolbar buttons use). An engine with no history producer never claims
 * Back/Forward, so the key falls through to whatever else wants it instead of dead-ending.
 */
export function useBrowserKeyboardShortcuts(input: Readonly<{
    model: BrowserToolbarModel;
    /** Whether a key event came from inside this Browser (its page or chrome): only then does Escape stop a load. */
    containsTarget: (target: unknown) => boolean;
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

    // Escape stops an in-flight load while the Browser has focus (owner 2026-11-20). Routed through the
    // canonical escape stack rather than a keybinding so it never double-fires with a dismissal: dialogs and
    // popovers still take Escape first, then this layer, then the pane and Session navigation, so the next
    // Escape closes the pane as before. It is registered only while a load is stoppable, and an Escape from
    // outside the Browser passes to the layers below.
    const containsTarget = input.containsTarget;
    useEscapeLayer({
        priority: ESCAPE_LAYER_PRIORITIES.browserStopLoading,
        enabled: model.canStop,
        onEscape: (event) => {
            if (!model.canStop) return false;
            if (!containsTarget((event as { target?: unknown } | null)?.target)) return false;
            onStop();
            return true;
        },
    });

    // Consume the dispatch owner's effective labels, including preferences and live handlers.
    const address = useKeyboardShortcutLabel('browser.address.focus');
    const back = useKeyboardShortcutLabel('browser.back');
    const forward = useKeyboardShortcutLabel('browser.forward');
    const reload = useKeyboardShortcutLabel('browser.reload');
    return React.useMemo(
        (): BrowserKeyboardShortcutLabels => ({
            'browser.address.focus': address,
            'browser.back': back,
            'browser.forward': forward,
            'browser.reload': reload,
        }),
        [address, back, forward, reload],
    );
}
