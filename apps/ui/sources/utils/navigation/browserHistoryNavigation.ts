/** Browser entry position, retained across reloads; never a second URL/history stack. */
type BrowserHistoryPosition = Readonly<{ index: number; total: number }>;
export type BrowserHistoryNavigationAvailability = Readonly<{
    canNavigateBack: boolean;
    canNavigateForward: boolean;
}>;

const HISTORY_POSITION_STATE_KEY = '__happierDesktopSidebarHistoryPosition';
const DEFAULT_POSITION: BrowserHistoryPosition = { index: 0, total: 1 };
export const BROWSER_HISTORY_NAVIGATION_CHANGED = 'happier:browser-history-navigation-changed';

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readHistoryPosition(history: Pick<History, 'state'>): BrowserHistoryPosition | null {
    const state: unknown = history.state;
    if (!isRecord(state)) return null;
    const position = state[HISTORY_POSITION_STATE_KEY];
    if (!isRecord(position)) return null;
    const { index, total } = position;
    return typeof index === 'number' && typeof total === 'number'
        && Number.isInteger(index) && Number.isInteger(total)
        && index >= 0 && total >= 1 && index < total ? { index, total } : null;
}

function attachHistoryPosition(state: unknown, position: BrowserHistoryPosition) {
    return { ...(isRecord(state) ? state : { value: state }), [HISTORY_POSITION_STATE_KEY]: position };
}

/** Unknown histories remain unknown; length alone cannot distinguish Back from Forward. */
export function readBrowserHistoryNavigationAvailability(history: Pick<History, 'state'>): BrowserHistoryNavigationAvailability | null {
    const position = readHistoryPosition(history);
    return position ? { canNavigateBack: position.index > 0, canNavigateForward: position.index < position.total - 1 } : null;
}

/** Native traversal deltas must not use a workspace history rebuilt after reload. */
export function readBrowserHistoryIndex(history: Pick<History, 'state'>): number | undefined {
    return readHistoryPosition(history)?.index;
}

/**
 * Installed once by the browser navigation bootstrap, before Expo writes its `{ id }` mirror.
 * This is the former sidebar hook's tracking, now independent of a chrome consumer's lifetime.
 * The existing state key and entry ids are preserved; the browser still owns chronology.
 */
export function trackBrowserHistoryNavigation(history: Pick<History, 'state' | 'pushState' | 'replaceState'>, changed: () => void): () => void {
    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);
    originalReplaceState(attachHistoryPosition(history.state, readHistoryPosition(history) ?? DEFAULT_POSITION), '');
    history.pushState = (state: unknown, unused: string, url?: string | URL | null) => {
        const previous = readHistoryPosition(history) ?? DEFAULT_POSITION;
        const nextIndex = previous.index + 1;
        originalReplaceState(attachHistoryPosition(history.state, { index: previous.index, total: nextIndex + 1 }), '');
        originalPushState(attachHistoryPosition(state, { index: nextIndex, total: nextIndex + 1 }), unused, url ?? undefined);
        changed();
    };
    history.replaceState = (state: unknown, unused: string, url?: string | URL | null) => {
        originalReplaceState(attachHistoryPosition(state, readHistoryPosition(history) ?? DEFAULT_POSITION), unused, url ?? undefined);
        changed();
    };
    return () => {
        history.pushState = originalPushState;
        history.replaceState = originalReplaceState;
    };
}
