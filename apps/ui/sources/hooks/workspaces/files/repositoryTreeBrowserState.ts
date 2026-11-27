import * as React from 'react';

type BrowserState = Readonly<{
    visibilityMode: 'project' | 'all';
    gitIgnoreAvailable?: boolean;
    revealedPaths: readonly string[];
    latestRequest?: Readonly<{ path: string }>;
    searchQuery: string;
    changedOnly: boolean;
    detailsMode: boolean;
    location: Readonly<{ path: string; kind: 'folder' | 'file' }>;
    /**
     * What the Files pane shows (lab pr974 SG1/SM1): the tree (`list`), one folder as a gallery, or this Session's
     * media. Changed only belongs to the tree, so choosing Changed returns a gallery or Media to the list.
     */
    view: 'list' | 'gallery' | 'media';
    /** The folder the gallery shows: kept while the pane returns to the list, so the toggle comes back to it. */
    galleryPath: string;
}>;

const INITIAL_STATE = Object.freeze<BrowserState>({ visibilityMode: 'project', revealedPaths: [], searchQuery: '', changedOnly: false, detailsMode: false, location: { path: '', kind: 'folder' }, view: 'list', galleryPath: '' });
// Transient presentation state, shared only by hosts addressing this exact workspace.
const states = new Map<string, BrowserState>();
const listeners = new Map<string, Set<() => void>>();

function read(scopeKey: string): BrowserState {
    return states.get(scopeKey) ?? INITIAL_STATE;
}

function update(scopeKey: string, transform: (state: BrowserState) => BrowserState): void {
    if (!scopeKey) return;
    const previous = read(scopeKey);
    const next = transform(previous);
    if (next === previous) return;
    states.set(scopeKey, next);
    listeners.get(scopeKey)?.forEach(listener => listener());
}

export function useRepositoryTreeBrowserState(scopeKey: string) {
    const subscribe = React.useCallback((listener: () => void) => {
        const scopedListeners = listeners.get(scopeKey) ?? new Set<() => void>();
        listeners.set(scopeKey, scopedListeners);
        scopedListeners.add(listener);
        return () => { scopedListeners.delete(listener); if (scopedListeners.size === 0) listeners.delete(scopeKey); };
    }, [scopeKey]);
    const getSnapshot = React.useCallback(() => read(scopeKey), [scopeKey]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const setVisibilityMode = React.useCallback((visibilityMode: BrowserState['visibilityMode']) => update(scopeKey, state => state.visibilityMode === visibilityMode ? state : { ...state, visibilityMode }), [scopeKey]);
    const setGitIgnoreAvailable = React.useCallback((gitIgnoreAvailable: boolean | undefined) => update(scopeKey, state => state.gitIgnoreAvailable === gitIgnoreAvailable ? state : { ...state, gitIgnoreAvailable }), [scopeKey]);
    const setSearchQuery = React.useCallback((searchQuery: string) => update(scopeKey, state => state.searchQuery === searchQuery ? state : { ...state, searchQuery }), [scopeKey]);
    const setChangedOnly = React.useCallback((changedOnly: boolean) => update(scopeKey, state => state.changedOnly === changedOnly && (!changedOnly || state.view === 'list')
        ? state : { ...state, changedOnly, view: changedOnly ? 'list' : state.view }), [scopeKey]);
    const setView = React.useCallback((view: BrowserState['view']) => update(scopeKey, state => state.view === view && (view === 'list' || !state.changedOnly)
        ? state : { ...state, view, changedOnly: view === 'list' ? state.changedOnly : false }), [scopeKey]);
    const showGallery = React.useCallback((galleryPath: string) => update(scopeKey, state => state.view === 'gallery' && state.galleryPath === galleryPath && !state.changedOnly
        ? state : { ...state, view: 'gallery', galleryPath, changedOnly: false }), [scopeKey]);
    const setDetailsMode = React.useCallback((detailsMode: boolean) => update(scopeKey, state => state.detailsMode === detailsMode ? state : { ...state, detailsMode }), [scopeKey]);
    const setLocation = React.useCallback((location: BrowserState['location']) => update(scopeKey, state => state.location.path === location.path && state.location.kind === location.kind ? state : { ...state, location }), [scopeKey]);
    const revealPath = React.useCallback((path: string, options?: Readonly<{ focus: boolean }>) => update(scopeKey, state => {
        const exists = state.revealedPaths.includes(path);
        if (exists && !options?.focus) return state;
        return { ...state, revealedPaths: exists ? state.revealedPaths : [...state.revealedPaths, path], latestRequest: options?.focus ? { path } : state.latestRequest };
    }), [scopeKey]);
    return { ...state, setVisibilityMode, setGitIgnoreAvailable, setSearchQuery, setChangedOnly, setView, showGallery, setDetailsMode, setLocation, revealPath };
}
