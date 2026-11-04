import * as React from 'react';
import type { SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { toStoredSessionListFilter } from './storedSessionListFilter';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeListKey } from '@/sync/domains/scope/serverAccountScope';
import type { ServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';

import {
    createSessionListViewFilterDefaults,
    normalizeSessionListViewFilters,
    removeUnavailableSessionListFilterSelections,
    type SessionListViewFilterDefaultsInput,
    type SessionListFilterDeletedSelections,
    type SessionListViewFilters,
    type SessionListViewContext,
} from './sessionListViewFilters';

type RetainedEntry = {
    filters: SessionListViewFilters;
    /**
     * The mounted-Home default this view was last seeded or cleared from.
     *
     * While the current Home selection still equals this baseline, nobody has made
     * an explicit Home choice yet, so a Home that finishes mounting later may join
     * the view. The moment the two diverge the choice is the person's, and no later
     * mount or probe change may overwrite it.
     */
    defaultHomeServerIds: readonly string[];
    /** Exact authenticated Home/Account lifetimes currently contributing to this view. */
    accountIdByServerId: Map<string, string>;
    defaults: SessionListViewFilterDefaultsInput;
    /** Captured independently of catalog hydration so cold drafts cannot cross Accounts. */
    spaceSettingsAccountScopeKey?: string | null;
    savedSpace?: UseSessionListViewFiltersInput['savedSpace'];
    savedLens?: SessionListViewFilters;
    showCoordinatorsRequest: 0 | 1;
};

function sameHomeSelection(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const known = new Set(a);
    return b.every((serverId) => known.has(serverId));
}

const retainedFiltersByKey = new Map<string, RetainedEntry>();
/** The one Sessions list: `global` is its retained view, whichever surface opens it. */
const GLOBAL_SESSION_LIST_CONTEXT_KEY = 'global';
const retainedFilterListeners = new Set<() => void>();
/** Asked for before the list ever mounted: its first mount opens already narrowed. */
let coordinatorsOnlyPending = false;
let unsubscribeCredentialChanges: (() => void) | null = null;

function ensureCredentialChangeSubscription(): void {
    if (unsubscribeCredentialChanges) return;
    unsubscribeCredentialChanges = subscribeHomeCredentialChange(({ serverId }) => {
        retireSessionListViewFilterCredentialContributions(serverId);
    });
}

function retentionKey(contextKey: string): string {
    return contextKey.trim();
}

function getOrCreateEntry(
    contextKey: string,
    defaults: SessionListViewFilterDefaultsInput,
): RetainedEntry {
    ensureCredentialChangeSubscription();
    const key = retentionKey(contextKey);
    const existing = retainedFiltersByKey.get(key);
    if (existing) return existing;
    const showCoordinatorsRequest = key === GLOBAL_SESSION_LIST_CONTEXT_KEY && coordinatorsOnlyPending ? 1 : 0;
    const filters = createSessionListViewFilterDefaults(defaults);
    if (key === GLOBAL_SESSION_LIST_CONTEXT_KEY) coordinatorsOnlyPending = false;
    const entry: RetainedEntry = {
        filters,
        defaultHomeServerIds: filters.homeServerIds,
        accountIdByServerId: new Map(),
        defaults,
        showCoordinatorsRequest,
    };
    retainedFiltersByKey.set(key, entry);
    return entry;
}

function resetRetainedEntry(entry: RetainedEntry, defaults: SessionListViewFilterDefaultsInput): void {
    const filters = createSessionListViewFilterDefaults(defaults);
    entry.filters = filters;
    entry.defaultHomeServerIds = filters.homeServerIds;
    entry.savedLens = undefined;
}

function removeAuthoritativelyDeletedHomes(
    entry: RetainedEntry,
    filters: SessionListViewFilters,
    deletedHomeServerIds: readonly string[],
): SessionListViewFilters {
    const wasFollowingDefault = sameHomeSelection(filters.homeServerIds, entry.defaultHomeServerIds);
    const nextFilters = removeUnavailableSessionListFilterSelections(filters, {
        deletedHomeServerIds,
    });
    entry.filters = nextFilters;
    if (wasFollowingDefault) {
        const deleted = new Set(deletedHomeServerIds);
        entry.defaultHomeServerIds = entry.defaultHomeServerIds.filter((serverId) => !deleted.has(serverId));
    }
    return nextFilters;
}

function retireHomeAccountContribution(
    entry: RetainedEntry,
    serverId: string,
    defaults: SessionListViewFilterDefaultsInput,
): void {
    if (!entry.accountIdByServerId.delete(serverId)) return;
    if (entry.accountIdByServerId.size === 0) {
        resetRetainedEntry(entry, defaults);
        entry.savedSpace = undefined;
        entry.showCoordinatorsRequest = 0;
        return;
    }
    removeAuthoritativelyDeletedHomes(entry, entry.filters, [serverId]);
}

function reconcileAccountScopeResolutions(
    entry: RetainedEntry,
    resolutions: ReadonlyMap<string, ServerCredentialAccountScopeResolution>,
    authoritativeHomeServerIds: readonly string[] | undefined,
    defaults: SessionListViewFilterDefaultsInput,
): void {
    const authoritativeHomes = authoritativeHomeServerIds
        ? new Set(authoritativeHomeServerIds)
        : null;
    for (const [serverId, accountId] of [...entry.accountIdByServerId]) {
        const resolution = resolutions.get(serverId);
        const retired = authoritativeHomes?.has(serverId) === false
            || resolution?.kind === 'signed_out'
            || resolution?.kind === 'unknown_home'
            || (resolution?.kind === 'bound' && resolution.scope.accountId !== accountId);
        if (retired) retireHomeAccountContribution(entry, serverId, defaults);
    }
    for (const [serverId, resolution] of resolutions) {
        if (resolution.kind === 'bound') {
            entry.accountIdByServerId.set(serverId, resolution.scope.accountId);
        }
    }
}

export function removeAuthoritativelyDeletedSessionListTagsForAccount(
    accountScope: ServerAccountScope,
    tagIds: readonly string[],
): void {
    const deletedTagIds = tagIds.map((tagId) => ({ serverId: accountScope.serverId, tagId }));
    for (const entry of retainedFiltersByKey.values()) {
        if (entry.accountIdByServerId.get(accountScope.serverId) !== accountScope.accountId) continue;
        entry.filters = removeUnavailableSessionListFilterSelections(entry.filters, { deletedTagIds });
    }
}

/** Credential mutation retires only that Home's contribution in every retained context. */
export function retireSessionListViewFilterCredentialContributions(serverIdRaw: string): void {
    const serverId = serverIdRaw.trim();
    if (!serverId) return;
    for (const entry of retainedFiltersByKey.values()) {
        // The next render supplies the current context defaults if this was the
        // final contribution. Until then, pruning the exact Home prevents the old
        // Account's qualified selections from remaining authoritative while its
        // replacement credential resolves.
        if (!entry.accountIdByServerId.delete(serverId)) continue;
        if (entry.accountIdByServerId.size === 0) {
            resetRetainedEntry(entry, entry.defaults);
            entry.savedSpace = undefined;
            entry.showCoordinatorsRequest = 0;
        } else {
            removeAuthoritativelyDeletedHomes(entry, entry.filters, [serverId]);
        }
    }
}

export function buildSessionListViewCredentialScopeKey(
    contextKey: string,
    resolutions: ReadonlyMap<string, ServerCredentialAccountScopeResolution>,
    participatingServerIds: readonly string[],
): string {
    const serverIds = [...new Set(participatingServerIds.map((serverId) => serverId.trim()).filter(Boolean))].sort();
    const scopes = serverIds
        .flatMap((serverId) => {
            const resolution = resolutions.get(serverId);
            return resolution?.kind === 'bound' ? [resolution.scope] : [];
        })
        .sort((left, right) => left.serverId.localeCompare(right.serverId));
    return JSON.stringify([contextKey.trim(), serverIds, serverAccountScopeListKey(scopes)]);
}

/**
 * The intent behind "Show coordinators": the Sessions list shows its default view narrowed to
 * coordinators, whether it is mounted now or mounts later. The caller navigates to the list.
 * Resetting also clears any other facet, so the list is never left narrowed two ways.
 */
export function showOnlyCoordinatorsInSessionList(contextKey = GLOBAL_SESSION_LIST_CONTEXT_KEY): void {
    const entry = retainedFiltersByKey.get(retentionKey(contextKey));
    if (!entry) {
        if (contextKey === GLOBAL_SESSION_LIST_CONTEXT_KEY) coordinatorsOnlyPending = true;
        return;
    }
    // The current draft remains untouched until the Settings selection is accepted.
    entry.showCoordinatorsRequest = 1;
    for (const listener of retainedFilterListeners) listener();
}

export function clearSessionListViewFilterRetentionForTests(): void {
    coordinatorsOnlyPending = false;
    retainedFiltersByKey.clear();
    unsubscribeCredentialChanges?.();
    unsubscribeCredentialChanges = null;
}

export type UseSessionListViewFiltersInput = Readonly<{
    /** `global` or a qualified Team-context key. */
    contextKey: string;
    defaults: SessionListViewFilterDefaultsInput;
    /** Fixed destination semantics, independent of its retention key or catalog. */
    viewContext?: SessionListViewContext;
    fixedShow?: SessionListViewFilters['show'];
    /** Archived destinations cannot be narrowed by the active inactive-visibility preference. */
    fixedIncludeInactive?: true;
    /** Existing exact-Home credential owner projection for every contributing Home. */
    accountScopeResolutions: ReadonlyMap<string, ServerCredentialAccountScopeResolution>;
    /**
     * Global Sessions mounts its Homes asynchronously, so an untouched default
     * follows the canonical mounted set. A Team context is fixed to its exact Home
     * and never reconciles.
     */
    followDefaultHomeSelection?: boolean;
    /** Complete current Home-profile scope from the authoritative local registry. */
    authoritativeHomeServerIds?: readonly string[];
    /** Admitted definition from the captured settings authority, never local Find text. */
    /** null explicitly suspends Spaces; undefined retains an unavailable catalog's current draft. */
    savedSpace?: Readonly<{ accountScopeKey: string; id: string; filter: SessionListFilterV1 }> | null;
    /** Captured settings authority even while its definitions are loading or locked. */
    spaceSettingsAccountScopeKey?: string | null;
}>;

export function useSessionListViewFilters(input: UseSessionListViewFiltersInput): Readonly<{
    filters: SessionListViewFilters;
    savedLens: SessionListViewFilters | null;
    refinements: SessionListViewFilters;
    updateFilters: React.Dispatch<React.SetStateAction<SessionListViewFilters>>;
    setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
    /** Applies only identities an owning producer has explicitly proved deleted. */
    removeAuthoritativelyDeletedSelections: (deleted: SessionListFilterDeletedSelections) => void;
    resetFilters: () => void;
    showCoordinatorsRequest: 0 | 1;
    acknowledgeShowCoordinatorsRequest: () => void;
}> {
    const defaults = { ...input.defaults,
        ...(input.fixedShow ? { show: input.fixedShow } : {}),
        ...(input.fixedIncludeInactive ? { includeInactive: true } : {}),
    };
    const contextKey = input.contextKey.trim();
    const key = retentionKey(contextKey);
    const retained = React.useMemo(
        () => getOrCreateEntry(contextKey, defaults),
        [contextKey],
    );
    retained.defaults = defaults;
    reconcileAccountScopeResolutions(
        retained,
        input.accountScopeResolutions,
        input.authoritativeHomeServerIds,
        defaults,
    );
    const savedSpace = input.savedSpace;
    const authorityKey = input.spaceSettingsAccountScopeKey !== undefined
        ? input.spaceSettingsAccountScopeKey : savedSpace?.accountScopeKey;
    if (retained.spaceSettingsAccountScopeKey !== undefined && authorityKey !== undefined
        && retained.spaceSettingsAccountScopeKey !== authorityKey) {
        resetRetainedEntry(retained, defaults);
        retained.savedSpace = undefined;
        retained.showCoordinatorsRequest = 0;
    }
    if (authorityKey !== undefined) retained.spaceSettingsAccountScopeKey = authorityKey;
    if (savedSpace === null && retained.savedSpace) {
        resetRetainedEntry(retained, defaults);
        retained.savedSpace = undefined;
    }
    if (savedSpace && (
        retained.savedSpace?.accountScopeKey !== savedSpace.accountScopeKey
        || retained.savedSpace.id !== savedSpace.id
    )) {
        retained.filters = normalizeSessionListViewFilters({ ...savedSpace.filter, searchQuery: '' }, input.viewContext, input.fixedShow, input.fixedIncludeInactive);
        retained.defaultHomeServerIds = retained.filters.homeServerIds;
    } else if (savedSpace && retained.savedSpace && savedSpace.filter !== retained.savedSpace.filter) {
        const previousSavedFilter = normalizeSessionListViewFilters({ ...retained.savedSpace.filter, searchQuery: '' }, input.viewContext, input.fixedShow, input.fixedIncludeInactive);
        const nextSavedFilter = normalizeSessionListViewFilters({ ...savedSpace.filter, searchQuery: '' }, input.viewContext, input.fixedShow, input.fixedIncludeInactive);
        if (!sameStrictJsonValue(nextSavedFilter, previousSavedFilter)
            && sameStrictJsonValue(toStoredSessionListFilter(retained.filters), toStoredSessionListFilter(previousSavedFilter))) {
            retained.filters = { ...nextSavedFilter, searchQuery: retained.filters.searchQuery };
        }
    }
    if (savedSpace) {
        const baseline = normalizeSessionListViewFilters({ ...savedSpace.filter, searchQuery: '' }, input.viewContext, input.fixedShow, input.fixedIncludeInactive);
        if (!sameStrictJsonValue(retained.savedLens, baseline)) retained.savedLens = baseline;
    }
    // A settings echo may update the saved baseline; it must not overwrite this context's draft.
    if (savedSpace) retained.savedSpace = savedSpace;
    const [state, setState] = React.useState<Readonly<{
        key: string;
        filters: SessionListViewFilters;
    }>>(() => ({ key, filters: retained.filters }));

    // A retained view can be changed from outside the list (Show coordinators); follow it.
    const [, followRetained] = React.useReducer((version: number) => version + 1, 0);
    React.useEffect(() => {
        retainedFilterListeners.add(followRetained);
        return () => { retainedFilterListeners.delete(followRetained); };
    }, []);

    let currentState = state;
    if (state.key === key && state.filters !== retained.filters) {
        currentState = { key, filters: retained.filters };
        setState(currentState);
    }
    if (state.key !== key) {
        currentState = { key, filters: retained.filters };
        setState(currentState);
    }

    if (input.authoritativeHomeServerIds) {
        const authoritativeHomeServerIds = new Set(input.authoritativeHomeServerIds);
        const deletedHomeServerIds = currentState.filters.homeServerIds
            .filter((serverId) => !authoritativeHomeServerIds.has(serverId));
        if (deletedHomeServerIds.length > 0) {
            const filters = removeAuthoritativelyDeletedHomes(
                retained,
                currentState.filters,
                deletedHomeServerIds,
            );
            currentState = { key, filters };
            setState(currentState);
        }
    }

    const mountedDefaultHomeServerIds = input.followDefaultHomeSelection === true
        ? createSessionListViewFilterDefaults(defaults).homeServerIds
        : currentState.filters.homeServerIds;
    if (
        input.followDefaultHomeSelection === true
        && sameHomeSelection(currentState.filters.homeServerIds, retained.defaultHomeServerIds)
        && !sameHomeSelection(currentState.filters.homeServerIds, mountedDefaultHomeServerIds)
    ) {
        const filters = normalizeSessionListViewFilters({
            ...currentState.filters,
            homeServerIds: mountedDefaultHomeServerIds,
        });
        retained.filters = filters;
        retained.defaultHomeServerIds = filters.homeServerIds;
        currentState = { key, filters };
        setState(currentState);
    }

    const updateFilters = React.useCallback<React.Dispatch<React.SetStateAction<SessionListViewFilters>>>((value) => {
        setState((current) => {
            const currentFilters = current.key === key ? current.filters : retained.filters;
            const requested = typeof value === 'function'
                ? (value as (previous: SessionListViewFilters) => SessionListViewFilters)(currentFilters)
                : value;
            const filters = normalizeSessionListViewFilters(requested, input.viewContext, input.fixedShow, input.fixedIncludeInactive);
            retained.filters = filters;
            return { key, filters };
        });
    }, [input.fixedIncludeInactive, input.fixedShow, input.viewContext, key, retained]);

    const setSearchQuery = React.useCallback<React.Dispatch<React.SetStateAction<string>>>((value) => {
        updateFilters((current) => ({
            ...current,
            searchQuery: typeof value === 'function'
                ? (value as (previous: string) => string)(current.searchQuery)
                : value,
        }));
    }, [updateFilters]);

    const removeAuthoritativelyDeletedSelections = React.useCallback((deleted: SessionListFilterDeletedSelections) => {
        setState((current) => {
            const currentFilters = current.key === key ? current.filters : retained.filters;
            const filters = removeUnavailableSessionListFilterSelections(currentFilters, deleted, input.viewContext);
            if (filters === currentFilters && current.key === key) return current;
            retained.filters = filters;
            return { key, filters };
        });
    }, [input.viewContext, key, retained]);

    const latestInput = React.useRef(input);
    latestInput.current = input;
    const resetFilters = React.useCallback(() => {
        const latest = latestInput.current;
        const savedSpace = latest.savedSpace ?? retained.savedSpace;
        const defaults = savedSpace
            ? normalizeSessionListViewFilters({ ...savedSpace.filter, searchQuery: '' }, latest.viewContext, latest.fixedShow, latest.fixedIncludeInactive)
            : normalizeSessionListViewFilters(createSessionListViewFilterDefaults(latest.defaults), latest.viewContext, latest.fixedShow, latest.fixedIncludeInactive);
        // Clearing re-enters default-following: the restored selection becomes the
        // new baseline, so Homes mounting after this point join again.
        retained.defaultHomeServerIds = defaults.homeServerIds;
        updateFilters(defaults);
    }, [retained, updateFilters]);

    const acknowledgeShowCoordinatorsRequest = React.useCallback(() => {
        retained.showCoordinatorsRequest = 0;
        for (const listener of retainedFilterListeners) listener();
    }, [retained]);
    const showCoordinatorsRequest = retained.showCoordinatorsRequest;
    const savedLens = retained.savedLens ?? null;
    const refinements = React.useMemo(() => {
        if (!savedLens) return currentState.filters;
        // Unchanged saved clauses belong inside membership's OR. Only deliberate
        // temporary edits narrow that union; fixed surface context is reapplied.
        const changed = Object.fromEntries(Object.entries(currentState.filters)
            .filter(([field, value]) => !sameStrictJsonValue(value, savedLens[field as keyof SessionListViewFilters])));
        return normalizeSessionListViewFilters({ ...createSessionListViewFilterDefaults({
            scope: 'all_accessible', show: 'both', startedBy: ['you', 'triggers', 'agents'],
            homeServerIds: createSessionListViewFilterDefaults(defaults).homeServerIds,
            includeInactive: currentState.filters.includeInactive,
        }), ...changed }, input.viewContext, input.fixedShow, input.fixedIncludeInactive);
    }, [currentState.filters, input.fixedIncludeInactive, input.fixedShow, input.viewContext, savedLens,
        // The retained defaults are normalized by the existing owner on each render.
        JSON.stringify(defaults.homeServerIds)]);

    return React.useMemo(() => ({
        filters: currentState.filters,
        savedLens,
        refinements,
        updateFilters,
        setSearchQuery,
        removeAuthoritativelyDeletedSelections,
        resetFilters,
        showCoordinatorsRequest,
        acknowledgeShowCoordinatorsRequest,
    }), [acknowledgeShowCoordinatorsRequest, currentState.filters, refinements, savedLens, removeAuthoritativelyDeletedSelections, resetFilters, setSearchQuery, showCoordinatorsRequest, updateFilters]);
}
