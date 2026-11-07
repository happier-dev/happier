import { retainIfEqual } from '@/sync/domains/state/structuralSharing';
import type { ReviewDiffState } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffBlock';

type Listener = () => void;

export type ChangedFilesReviewDiffStateSource = Readonly<{
    getSnapshot: () => ReadonlyMap<string, ReviewDiffState>;
    subscribeAll: (listener: Listener) => () => void;
    getDiffState: (path: string) => ReviewDiffState;
    subscribe: (path: string, listener: Listener) => () => void;
    reset: () => void;
    prune: (allowedPaths: ReadonlySet<string>, inFlightPaths: ReadonlySet<string>) => void;
    setDiffState: (path: string, next: ReviewDiffState) => void;
    updateDiffState: (path: string, updater: (prev: ReviewDiffState) => ReviewDiffState) => void;
}>;

const INITIAL_DIFF_STATE: ReviewDiffState = { status: 'idle', diff: '', error: null };

export function createChangedFilesReviewDiffStateSource(initialStates?: Iterable<readonly [string, ReviewDiffState]>): ChangedFilesReviewDiffStateSource {
    const stateByPath = new Map<string, ReviewDiffState>(initialStates);
    const listenersByPath = new Map<string, Set<Listener>>();
    const allListeners = new Set<Listener>();
    let snapshot: ReadonlyMap<string, ReviewDiffState> = new Map(stateByPath);

    const emit = (path: string) => {
        snapshot = new Map(stateByPath);
        for (const listener of allListeners) listener();
        const listeners = listenersByPath.get(path);
        if (!listeners || listeners.size === 0) return;
        for (const listener of Array.from(listeners)) {
            try {
                listener();
            } catch {
                // ignore
            }
        }
    };

    const getDiffState = (path: string): ReviewDiffState => stateByPath.get(path) ?? INITIAL_DIFF_STATE;

    const setDiffState = (path: string, next: ReviewDiffState) => {
        const prev = stateByPath.get(path);
        // A refetch that returns the same patch must not republish: every row and the whole-snapshot reader re-render on it.
        if (retainIfEqual(prev, next) === prev) return;
        stateByPath.set(path, next);
        emit(path);
    };

    const updateDiffState = (path: string, updater: (prev: ReviewDiffState) => ReviewDiffState) => {
        const prev = getDiffState(path);
        const next = updater(prev);
        setDiffState(path, next);
    };

    const subscribe = (path: string, listener: Listener) => {
        const set = listenersByPath.get(path) ?? new Set<Listener>();
        set.add(listener);
        listenersByPath.set(path, set);
        return () => {
            const existing = listenersByPath.get(path);
            if (!existing) return;
            existing.delete(listener);
            if (existing.size === 0) listenersByPath.delete(path);
        };
    };

    const reset = () => {
        if (stateByPath.size === 0) return;
        const paths = Array.from(stateByPath.keys());
        stateByPath.clear();
        for (const path of paths) emit(path);
    };

    const prune = (allowedPaths: ReadonlySet<string>, inFlightPaths: ReadonlySet<string>) => {
        if (stateByPath.size === 0) return;
        const removed: string[] = [];
        for (const path of stateByPath.keys()) {
            if (allowedPaths.has(path)) continue;
            if (inFlightPaths.has(path)) continue;
            removed.push(path);
        }
        if (removed.length === 0) return;
        for (const path of removed) {
            stateByPath.delete(path);
        }
        for (const path of removed) emit(path);
    };

    return { getDiffState, subscribe, reset, prune, setDiffState, updateDiffState,
        getSnapshot: () => snapshot,
        subscribeAll: listener => { allListeners.add(listener); return () => { allListeners.delete(listener); }; } };
}
