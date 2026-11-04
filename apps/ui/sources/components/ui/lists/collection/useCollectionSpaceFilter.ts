import * as React from 'react';
import type { CollectionEntityKindV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import type { CollectionFilterMapV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useCollectionSpaceBinding } from './useCollectionSpaceBinding';

type CollectionSpaceDraftState<K extends CollectionEntityKindV1> = Readonly<{
    lifetime: ServerAccountScopeLifetime | null;
    filters: CollectionFilterMapV1[K];
    savedFilter: CollectionFilterMapV1[K];
    selectedSpaceId: string;
    bound: boolean;
    spacesEnabled: boolean;
    searchQuery: string;
}>;

/**
 * One transient draft shared by every mount of the same entity list (R8-7: a Workflows column and the
 * library home beside it narrow through one draft, never two). It lives only while a mount reads it.
 */
export type CollectionSpaceDraftStore<K extends CollectionEntityKindV1> = Readonly<{
    get(): CollectionSpaceDraftState<K> | null;
    set(next: CollectionSpaceDraftState<K>): void;
    subscribe(listener: () => void): () => void;
}>;

export function createCollectionSpaceDraftStore<K extends CollectionEntityKindV1>(): CollectionSpaceDraftStore<K> {
    let value: CollectionSpaceDraftState<K> | null = null;
    const listeners = new Set<() => void>();
    return {
        get: () => value,
        set(next) {
            if (next === value) return;
            value = next;
            for (const listener of [...listeners]) listener();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0) value = null;
            };
        },
    };
}

const subscribeNothing = () => () => {};
const readNothing = () => null;

/** Mounted entity draft over the shared settings projection, with no independent persistence. */
export function useCollectionSpaceFilter<K extends CollectionEntityKindV1>(entityKind: K, input: Readonly<{
    lifetime: ServerAccountScopeLifetime | null;
    defaultName: string;
    defaultFilter: CollectionFilterMapV1[K];
    /** Shares the draft with the entity's other mounts; omitted, the draft belongs to this mount. */
    draft?: CollectionSpaceDraftStore<K>;
}>) {
    const { lifetime, defaultFilter, draft } = input;
    const binding = useCollectionSpaceBinding(entityKind, { scope: lifetime?.scope ?? null,
        defaultName: input.defaultName, defaultFilter });
    const initial = (): CollectionSpaceDraftState<K> => ({ lifetime, filters: binding.savedSpace?.filter ?? defaultFilter,
        savedFilter: binding.savedSpace?.filter ?? defaultFilter, selectedSpaceId: binding.selectedSpaceId,
        bound: binding.spacesReady, spacesEnabled: binding.spacesEnabled, searchQuery: '' });
    const [localState, setLocalState] = React.useState(initial);
    const sharedState = React.useSyncExternalStore(draft?.subscribe ?? subscribeNothing, draft?.get ?? readNothing, draft?.get ?? readNothing);
    const state = draft ? sharedState ?? initial() : localState;
    let current = state;
    const selected = binding.activeSpace;
    const enablementChanged = binding.spacesReady && state.spacesEnabled !== binding.spacesEnabled;
    if (state.lifetime !== lifetime || binding.spacesReady && !state.bound || enablementChanged || selected && (selected.id !== state.selectedSpaceId
        || !sameStrictJsonValue(selected.filter, state.savedFilter))) {
        const changedSpace = state.lifetime !== lifetime || enablementChanged || !state.bound || selected?.id !== state.selectedSpaceId;
        const savedFilter = selected?.filter ?? defaultFilter;
        current = { lifetime, savedFilter, selectedSpaceId: binding.selectedSpaceId, bound: binding.spacesReady,
            spacesEnabled: binding.spacesEnabled,
            filters: changedSpace || sameStrictJsonValue(state.filters, state.savedFilter) ? savedFilter : state.filters,
            searchQuery: changedSpace ? '' : state.searchQuery };
        if (!draft) setLocalState(current);
    }
    // A shared draft is rebased in render like a local one, and committed once for its other readers.
    const latest = React.useRef(current);
    latest.current = current;
    React.useLayoutEffect(() => {
        if (draft && draft.get() !== current) draft.set(current);
    });
    const setDraft = React.useCallback((next: (previous: CollectionSpaceDraftState<K>) => CollectionSpaceDraftState<K>) => {
        if (draft) draft.set(next(draft.get() ?? latest.current));
        else setLocalState(next);
    }, [draft]);
    // Admission stays at the entity's typed mutation boundary; stored baselines come from settings ingress.
    const update = React.useCallback((patch: Readonly<{ filters?: Partial<CollectionFilterMapV1[K]>; searchQuery?: string }>): boolean => {
        if (!lifetime?.isCurrent() || !binding.spacesReady) return false;
        setDraft(previous => {
            const filters = patch.filters ? { ...previous.filters, ...patch.filters } : previous.filters;
            const searchQuery = patch.searchQuery ?? previous.searchQuery;
            return sameStrictJsonValue(filters, previous.filters) && searchQuery === previous.searchQuery
                ? previous : { ...previous, filters, searchQuery };
        });
        return true;
    }, [binding.spacesReady, lifetime, setDraft]);
    const reset = React.useCallback((): boolean => {
        if (!lifetime?.isCurrent() || !binding.spacesReady) return false;
        setDraft(previous => previous.filters === previous.savedFilter && previous.searchQuery === ''
            ? previous : { ...previous, filters: previous.savedFilter, searchQuery: '' });
        return true;
    }, [binding.spacesReady, lifetime, setDraft]);
    return { ...binding, filters: current.filters, searchQuery: current.searchQuery, bound: current.bound, update, reset };
}
