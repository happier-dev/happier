import * as React from 'react';
import { buildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

/**
 * The one "active review file" per review scope (a Session address, a workspace): which changed file
 * Review is showing, and a request from a changed-files list to show another. Review publishes; the
 * Git changed-files list (and any list that replaces it) highlights, reveals and asks — neither owns
 * the other's scroll. Nothing is persisted. Ordinary hidden lists hold no request; a route promotion
 * may retain one comparison-qualified path until matching Files mounts, or its captured host retires.
 */
export type ActiveReviewFileState = Readonly<{
    /** Review is open and on screen for this scope. */
    presented: boolean;
    /** The file Review shows (null while Review is not on screen). */
    activePath: string | null;
    /** The last file a list asked Review to show; a new nonce for every ask. */
    focusRequest: Readonly<{ path: string; nonce: number; comparison?: SessionScmReviewComparison; isCurrent?: () => boolean }> | null;
}>;

const EMPTY: ActiveReviewFileState = Object.freeze({ presented: false, activePath: null, focusRequest: null });

// Each mounted presentation retires only itself; live selection still has one scope owner.
const states = new Map<string, { state: ActiveReviewFileState; presenters: Set<string> }>();
const listeners = new Map<string, Set<() => void>>();
let nextNonce = 1;

function write(key: string, next: ActiveReviewFileState): void {
    const entry = states.get(key) ?? { state: EMPTY, presenters: new Set<string>() };
    entry.state = next;
    states.set(key, entry);
    for (const listener of listeners.get(key) ?? []) listener();
}

export function readActiveReviewFile(key: string): ActiveReviewFileState {
    const state = states.get(key)?.state ?? EMPTY;
    if (state.focusRequest?.isCurrent && !state.focusRequest.isCurrent()) return { ...state, focusRequest: null };
    return state;
}

export function subscribeActiveReviewFile(key: string, listener: () => void): () => void {
    let set = listeners.get(key);
    if (!set) {
        set = new Set();
        listeners.set(key, set);
    }
    set.add(listener);
    return () => {
        set?.delete(listener);
        if (set && set.size === 0) listeners.delete(key);
    };
}

/** Review reports whether it is on screen and which file it is on. Unchanged facts notify nobody. */
export function publishActiveReviewFile(key: string, input: Readonly<{ presented: boolean; activePath: string | null; presenterId?: string }>): void {
    const current = readActiveReviewFile(key);
    const entry = states.get(key) ?? { state: EMPTY, presenters: new Set<string>() };
    const presenterId = input.presenterId ?? 'legacy';
    if (input.presented) entry.presenters.add(presenterId);
    else entry.presenters.delete(presenterId);
    states.set(key, entry);
    const presented = entry.presenters.size > 0;
    const activePath = presented ? input.presented ? input.activePath : current.activePath : null;
    if (current.presented === presented && current.activePath === activePath) return;
    write(key, { presented, activePath,
        focusRequest: presented || current.focusRequest?.comparison ? current.focusRequest : null });
}

/**
 * A list asks Review to show a file. Answers whether Review took it (it is on screen); when not, the
 * list keeps its own action (opening the file).
 */
export function requestActiveReviewFile(key: string, path: string, comparison?: SessionScmReviewComparison, isCurrent?: () => boolean): boolean {
    const current = readActiveReviewFile(key);
    if ((!current.presented && !comparison) || (isCurrent && !isCurrent())) return false;
    write(key, { ...current, focusRequest: { path, nonce: nextNonce++, ...(comparison ? { comparison } : {}), ...(isCurrent ? { isCurrent } : {}) } });
    return true;
}

/** A route promotion keeps one pending path until that exact comparison's Files view mounts. */
export function requestActiveReviewFileForComparison(key: string, path: string, comparison: SessionScmReviewComparison, isCurrent?: () => boolean): boolean {
    return requestActiveReviewFile(key, path, comparison, isCurrent);
}

/** Matching Files is mounted: retain the scroll request, but no longer carry it through unmount. */
export function acknowledgeActiveReviewFileRequest(key: string, nonce: number): void {
    const current = readActiveReviewFile(key);
    const request = current.focusRequest;
    if (!request?.comparison || request.nonce !== nonce) return;
    const { comparison: _comparison, ...focusRequest } = request;
    write(key, { ...current, focusRequest });
}

function useActiveReviewFileSelector<T>(key: string | null, select: (state: ActiveReviewFileState) => T): T {
    const subscribe = React.useCallback(
        (listener: () => void) => (key ? subscribeActiveReviewFile(key, listener) : () => {}),
        [key],
    );
    const getSnapshot = () => select(key ? readActiveReviewFile(key) : EMPTY);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The file Review is on, for a list that reveals it (null while Review is not on screen). */
export function useActiveReviewFilePath(key: string | null): string | null {
    return useActiveReviewFileSelector(key, (state) => state.activePath);
}

/** Row-local: whether this row is Review's file. Only the two rows that change re-render. */
export function useIsActiveReviewFile(key: string | null, path: string): boolean {
    return useActiveReviewFileSelector(key, (state) => state.activePath === path);
}

/** Review consumes list requests. */
export function useActiveReviewFileRequest(key: string | null): ActiveReviewFileState['focusRequest'] {
    return useActiveReviewFileSelector(key, (state) => state.focusRequest);
}

export function resetActiveReviewFilesForTests(): void {
    states.clear();
    listeners.clear();
}

/** The scope key a Session's Review and its Git changed-files list share. */
export function activeReviewFileKeyForSession(sessionId: string, serverId?: string | null): string {
    return `session:${serverId ?? ''}:${sessionId}`;
}

/** Review and Git share the canonical normalized workspace identity, including its Home and machine. */
export function activeReviewFileKeyForWorkspace(scope: WorkspaceScopeBase): string {
    return `workspace:${buildWorkspaceCacheKey(scope)}`;
}

/**
 * A changed-files list row was tapped: with Review on screen the file is shown there (Review scrolls
 * to it); otherwise the list keeps its own action and opens the file.
 */
export function openChangedFileFromList(key: string | null, path: string, open: (path: string) => void): void {
    if (key && requestActiveReviewFile(key, path)) return;
    open(path);
}
