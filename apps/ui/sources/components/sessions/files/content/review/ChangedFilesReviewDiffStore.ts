import type { ReviewDiffState } from '@/components/sessions/files/content/review/ChangedFilesReviewDiffBlock';

type Listener = () => void;

export type ChangedFilesReviewDiffStateSource = Readonly<{
    getDiffState: (path: string) => ReviewDiffState;
    subscribe: (path: string, listener: Listener) => () => void;
    reset: () => void;
    prune: (allowedPaths: ReadonlySet<string>, inFlightPaths: ReadonlySet<string>) => void;
    setDiffState: (path: string, next: ReviewDiffState) => void;
    updateDiffState: (path: string, updater: (prev: ReviewDiffState) => ReviewDiffState) => void;
}>;

const INITIAL_DIFF_STATE: ReviewDiffState = { status: 'idle', diff: '', error: null };

export function createChangedFilesReviewDiffStateSource(): ChangedFilesReviewDiffStateSource {
    const stateByPath = new Map<string, ReviewDiffState>();
    const listenersByPath = new Map<string, Set<Listener>>();

    const emit = (path: string) => {
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
        if (prev === next) return;
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

    return { getDiffState, subscribe, reset, prune, setDiffState, updateDiffState };
}

