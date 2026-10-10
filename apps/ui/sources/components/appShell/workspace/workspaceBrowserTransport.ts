import type { WorkspaceUrlTransport } from './workspaceNavigationAdapter';
import type { WorkspaceNavigationEntry } from './workspaceNavigationHistory';
import { interceptUnsavedChangesBrowserPopState } from '@/utils/navigation/runGuardedNavigation';
import { BROWSER_HISTORY_NAVIGATION_CHANGED, readBrowserHistoryIndex, readBrowserHistoryNavigationAvailability, trackBrowserHistoryNavigation } from '@/utils/navigation/browserHistoryNavigation';

let browserWindow: Window | null = null;
let releaseBrowserHistoryNavigation: (() => void) | null = null;
let acceptWorkspacePopState: ((state: unknown, event: PopStateEvent) => boolean) | null = null;

function onWorkspacePopState(event: PopStateEvent): void {
    if (acceptWorkspacePopState?.(event.state, event)) {
        event.stopImmediatePropagation();
        return;
    }
    // Only an unbound/unrecognized entry has no direction-aware owner.
    interceptUnsavedChangesBrowserPopState(event);
}

/** App-entry bootstrap: one capture owner, before Expo evaluates its history mirror. */
export function installWorkspaceBrowserHistory(): void {
    if (typeof window === 'undefined' || !window.history || typeof window.addEventListener !== 'function' || browserWindow === window) return;
    browserWindow?.removeEventListener('popstate', onWorkspacePopState, true);
    releaseBrowserHistoryNavigation?.();
    browserWindow = window;
    const target = window;
    releaseBrowserHistoryNavigation = trackBrowserHistoryNavigation(target.history,
        () => target.dispatchEvent(new Event(BROWSER_HISTORY_NAVIGATION_CHANGED)));
    window.addEventListener('popstate', onWorkspacePopState, true);
}

/** Bind the mounted workspace transport to the already-installed browser owner. */
export function bindWorkspaceBrowserHistory(accept: (state: unknown, event: PopStateEvent) => boolean): () => void {
    installWorkspaceBrowserHistory();
    acceptWorkspacePopState = accept;
    return () => { if (acceptWorkspacePopState === accept) acceptWorkspacePopState = null; };
}

type BrowserHistoryBoundary = Pick<History, 'state' | 'pushState' | 'replaceState' | 'go'>;

function browserEntryId(state: unknown): string | null {
    if (!state || typeof state !== 'object') return null;
    const id = (state as Record<string, unknown>).id;
    return typeof id === 'string' ? id : null;
}

/**
 * Expo/React Navigation is a URL mirror, while the workspace owns navigation.
 * React Navigation's installed createMemoryHistory preserves the browser entry
 * `id` but rewrites state to `{ id }`. Keep the workspace entry in session memory
 * against that same id; history and recently-visited destinations are not persisted.
 */
export function createWorkspaceBrowserTransport(input: Readonly<{
    history: BrowserHistoryBoundary;
    getHref: () => string;
    mirror: (href: string) => void;
    createId: () => string;
    accept: (href: string, entry?: WorkspaceNavigationEntry, position?: number) => boolean | void;
    /** Settles the shared decision against the still-current destination, including cancellation. */
    guard?: (direction: -1 | 1, proceed: () => void) => boolean | Promise<boolean>;
    needsGuard?: (direction: -1 | 1) => boolean;
}>): WorkspaceUrlTransport & Readonly<{
    acceptPopState: (state: unknown, event?: PopStateEvent) => boolean;
}> {
    // Workspace positions address restored views; native positions measure traversal deltas.
    // A reload rebuilds the former, but must never reset the latter's coordinate system.
    const entries = new Map<string, Readonly<{ entry: WorkspaceNavigationEntry; position: number; browserPosition: number }>>();
    let currentPosition: number | null = null;
    let currentId: string | null = null;
    let authorizedId: string | null = null;
    let pending: { sourceId: string; targetId: string; delta: number; deciding: boolean } | null = null;
    return {
        canTraverse(direction) {
            const availability = readBrowserHistoryNavigationAvailability(input.history);
            return availability ? direction === -1 ? availability.canNavigateBack : availability.canNavigateForward : undefined;
        },
        adoptCurrent(entry, position) {
            pending = null;
            authorizedId = null;
            currentPosition = readBrowserHistoryIndex(input.history) ?? position;
            const id = browserEntryId(input.history.state) ?? input.createId();
            currentId = id;
            entries.set(id, { entry, position, browserPosition: currentPosition });
            if (browserEntryId(input.history.state) === null) {
                const state = input.history.state;
                input.history.replaceState({ ...(state && typeof state === 'object' ? state : {}), id }, '', input.getHref());
            }
        },
        commit(href, entry, replace, position) {
            pending = null;
            authorizedId = null;
            const id = replace ? browserEntryId(input.history.state) ?? input.createId() : input.createId();
            currentId = id;
            const state = input.history.state;
            const next = { ...(state && typeof state === 'object' ? state : {}), id };
            if (replace) input.history.replaceState(next, '', href);
            else input.history.pushState(next, '', href);
            currentPosition = readBrowserHistoryIndex(input.history) ?? position;
            entries.set(id, { entry, position, browserPosition: currentPosition });
            input.mirror(href);
        },
        traverse(direction) { input.history.go(direction); },
        acceptPopState(state, event) {
            const id = browserEntryId(state);
            const found = id ? entries.get(id) : undefined;
            const browserPosition = readBrowserHistoryIndex({ state }) ?? found?.browserPosition;
            if (browserPosition === undefined) {
                // Only a genuinely unannotated entry has unknown direction.
                // Reload loses workspace views, not the native traversal coordinates.
                if (event && interceptUnsavedChangesBrowserPopState(event)) {
                    // The unannotated fallback restored the source with a push.
                    // Its native coordinate changed; the workspace view did not.
                    currentPosition = readBrowserHistoryIndex(input.history) ?? currentPosition;
                    return true;
                }
                // A reload retires this page's entry map, not the browser's
                // history. Admit its URL through the same destination owner;
                // acceptance adopts the current entry without pushing another.
                if (input.accept(input.getHref()) !== true) return false;
                input.mirror(input.getHref());
                return true;
            }
            if (pending) {
                const decision = pending;
                if (id !== decision.sourceId) {
                    // Repeated traversal while the decision is open restores the
                    // same source, without replacing its original continuation.
                    if (currentPosition !== null) input.history.go(currentPosition - browserPosition);
                    return true;
                }
                if (decision.deciding) return true;
                decision.deciding = true;
                const result = input.guard?.(decision.delta < 0 ? -1 : 1, () => {
                    if (pending !== decision) return;
                    pending = null;
                    authorizedId = decision.targetId;
                    input.history.go(decision.delta);
                });
                // Keep editing/refused Save end this traversal. A later gesture
                // must get its own direction and continuation, not this target.
                void Promise.resolve(result).then(() => {
                    if (pending === decision) pending = null;
                }, () => {
                    if (pending === decision) pending = null;
                });
                return true;
            }
            const direction = currentPosition !== null && browserPosition < currentPosition ? -1 : 1;
            if (input.guard && (input.needsGuard?.(direction) ?? true)
                && currentPosition !== null && browserPosition !== currentPosition && authorizedId !== id) {
                if (currentId && id) {
                    const delta = browserPosition - currentPosition;
                    pending = { sourceId: currentId, targetId: id, delta, deciding: false };
                    // Native pop has already changed the URL. Restore without adding
                    // an entry before asking the current editor whether it may leave.
                    input.history.go(-delta);
                    return true;
                }
            }
            pending = null;
            authorizedId = null;
            currentPosition = browserPosition;
            currentId = id;
            if (found) input.accept(input.getHref(), found.entry, found.position);
            else if (input.accept(input.getHref()) !== true) return false;
            input.mirror(input.getHref());
            return true;
        },
    };
}
