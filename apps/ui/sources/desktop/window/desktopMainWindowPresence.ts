import { isDesktopHost } from '@/utils/platform/desktopHost';

type DesktopWindowDocument = Readonly<{
    visibilityState?: string;
    hasFocus?: () => boolean;
}>;

function readDesktopWindowDocument(): DesktopWindowDocument | undefined {
    return (globalThis as unknown as { document?: DesktopWindowDocument }).document;
}

function readHasFocus(doc: DesktopWindowDocument | undefined): boolean | undefined {
    if (typeof doc?.hasFocus !== 'function') {
        return undefined;
    }
    try {
        return doc.hasFocus();
    } catch {
        return undefined;
    }
}

/**
 * Whether the desktop main window is on screen right now.
 *
 * This is the presence fact for everything the user can *see*: the current-UI
 * context a voice provider may describe, and the motion loops that redraw while
 * they look at it. Focus is deliberately not required. The hands-free posture —
 * talking to Voice while the editor holds focus — leaves the window fully
 * visible, and the web build has always kept both for a visible unfocused tab,
 * so requiring focus here made the two hosts disagree about the same window.
 *
 * `document.hasFocus()` is still read, as an escape rather than a gate: macOS
 * can leave a desktop webview latched at `visibilityState: 'hidden'` with no
 * further `visibilitychange`, and a bare visibility read would then withhold
 * context for the rest of the process. A focused document cannot be hidden, so
 * focus is the contradiction that releases the latch — and `focus` is already
 * one of the transitions {@link useHostActivelyViewed} republishes on.
 */
export function isDesktopMainWindowVisible(): boolean {
    if (!isDesktopHost()) {
        return false;
    }

    const doc = readDesktopWindowDocument();
    if (doc?.visibilityState !== 'hidden') {
        return true;
    }

    return readHasFocus(doc) === true;
}

/**
 * Whether the desktop main window is the one the user is currently interacting
 * with.
 *
 * Strictly narrower than {@link isDesktopMainWindowVisible} and kept separate on
 * purpose: this answers "has the user's attention already landed here?", which
 * is what suppressing a redundant local notification depends on. Visibility is
 * too weak for that decision — a window sitting unwatched on a second monitor
 * still reports `visible`, and suppressing on it would silently drop the
 * notification the user was relying on.
 *
 * A host that publishes no `hasFocus` falls back to visibility, which is the
 * strongest fact it offers.
 */
export function isDesktopMainWindowFocused(): boolean {
    if (!isDesktopHost()) {
        return false;
    }

    const doc = readDesktopWindowDocument();
    const focused = readHasFocus(doc);
    return focused ?? doc?.visibilityState !== 'hidden';
}
