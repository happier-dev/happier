import {
    getDesktopHostWindowLabel,
    invokeDesktopHost,
    isDesktopHost,
    listenDesktopHostEvent,
} from '@/utils/platform/desktopHost';

/**
 * A desktop shell's own window focus, pushed by its `tauri://focus` / `tauri://blur` events.
 *
 * The webview document is not the authority there: after a programmatic launch it was seen
 * claiming focus while its native window was hidden (motion kept running, and a stale `true`
 * would mute phone pushes), and denying focus while the native window held it. `undefined`
 * until the shell answers; a shell that never answers keeps the document fact.
 */
let nativeWindowFocus: boolean | undefined;
let nativeWindowFocusWatchStarted = false;
const hostWindowFocusListeners = new Set<() => void>();

function publishNativeWindowFocus(focused: boolean): void {
    if (nativeWindowFocus === focused) return;
    nativeWindowFocus = focused;
    for (const listener of hostWindowFocusListeners) listener();
}

function startNativeWindowFocusWatch(): void {
    if (nativeWindowFocusWatchStarted || !isDesktopHost()) return;
    nativeWindowFocusWatchStarted = true;
    let pushed = false;
    const onNativeFocus = (focused: boolean) => {
        pushed = true;
        publishNativeWindowFocus(focused);
    };
    const reportUnavailable = (error: unknown) => {
        console.warn('[window-focus] Native window focus is unavailable; using document focus', error);
    };
    void listenDesktopHostEvent('tauri://focus', () => onNativeFocus(true)).catch(reportUnavailable);
    void listenDesktopHostEvent('tauri://blur', () => onNativeFocus(false)).catch(reportUnavailable);
    const label = getDesktopHostWindowLabel();
    if (label === null) return;
    void invokeDesktopHost<unknown>('plugin:window|is_focused', { label }).then((focused) => {
        // An event pushed while the query was in flight is newer than its answer.
        if (!pushed && typeof focused === 'boolean') publishNativeWindowFocus(focused);
    }, reportUnavailable);
}

/** Notifies when the desktop shell pushes a native window focus change. */
export function subscribeToHostWindowFocus(listener: () => void): () => void {
    startNativeWindowFocusWatch();
    hostWindowFocusListeners.add(listener);
    return () => {
        hostWindowFocusListeners.delete(listener);
    };
}

/** Physical window focus, shared by local desktop presence and sync publication. */
export function readHostWindowFocus(): boolean | undefined {
    startNativeWindowFocusWatch();
    if (nativeWindowFocus !== undefined) return nativeWindowFocus;
    const doc = (globalThis as unknown as { document?: { hasFocus?: () => boolean } }).document;
    if (typeof doc?.hasFocus !== 'function') return undefined;
    try {
        return doc.hasFocus();
    } catch {
        // The host cannot establish focus: callers preserve their existing unknown-state policy.
        return undefined;
    }
}

/**
 * Whether this document host's window holds the user's attention: a browser tab or a desktop
 * window that has focus. Suppressing a redundant notification depends on this, not on
 * visibility, because a window left on a second monitor still reports `visible`. A host that
 * publishes no `hasFocus` falls back to visibility, the strongest fact it offers.
 */
export function isHostWindowFocused(): boolean {
    const focused = readHostWindowFocus();
    if (focused !== undefined) return focused;
    const doc = (globalThis as unknown as { document?: { visibilityState?: string } }).document;
    return doc?.visibilityState !== 'hidden';
}
