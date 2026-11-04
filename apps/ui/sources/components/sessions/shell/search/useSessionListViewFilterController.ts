import * as React from 'react';

import { useSessionListStorageKind } from '@/components/sessions/model/useSessionListStorageKind';
import { useSessionListSelectionState } from '@/hooks/session/useSessionListSelectionState';
import { listServerProfiles, resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { listServerProfileScopeIds } from '@/sync/domains/server/selection/serverSelectionProfileScopeIds';
import { useServerCredentialAccountScopeResolutions } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useSetting } from '@/sync/domains/state/storage';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { type CollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { useCollectionSpaceBinding } from '@/components/ui/lists/collection/useCollectionSpaceBinding';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { t } from '@/text';

import {
    useSessionListQueryHomeSupportByServerId,
    useSessionListFeatureHomeSupportByServerId,
    type SessionListQueryHomeInput,
} from '@/sync/domains/session/listing/useSessionListQuerySourceState';

import {
    buildSessionListFilterQueryHomes,
    buildQualifiedAudienceSelectionKey,
    isSessionListEmptyQuerySelectionComplete,
    resolveSessionListFilterOrdinaryPageAdapter,
    resolveSessionListViewContextDefaults,
    normalizeSessionListViewFilters,
    shouldUseSessionListFilterQuerySource,
    type SessionListViewContext,
    type SessionListViewFilters,
} from './sessionListViewFilters';
import {
    buildSessionListViewCredentialScopeKey,
    useSessionListViewFilters,
} from './useSessionListViewFilters';
import { toStoredSessionListFilter } from './storedSessionListFilter';
import type { SessionListSpaceMembership } from '@/sync/domains/session/listing/sessionListWorkFilter';

export type SessionListCorpusStorage = 'active' | 'archived';
export type SessionListCorpusPresentation = 'semantic_query' | 'legacy_owner_or_direct';

const GLOBAL_SESSION_LIST_VIEW_CONTEXT: SessionListViewContext = { kind: 'global' };

export function resolveSelectedHomeFeatureAvailability(
    selectedServerIds: readonly string[],
    supportByServerId: Readonly<Record<string, boolean | null | undefined>>,
): boolean {
    return selectedServerIds.some((serverId) => supportByServerId[serverId] === true);
}

/** The Home facet's options: each Home by its profile name, for any surface that edits a Sessions filter. */
export function buildSessionListFilterHomeOptions(
    serverIds: readonly string[],
): readonly Readonly<{ serverId: string; label: string }>[] {
    const profilesById = new Map(listServerProfiles().flatMap((profile) => [
        [profile.id, profile] as const,
        [resolveServerProfileScopeId(profile), profile] as const,
    ]));
    return serverIds.map((serverId) => ({
        serverId,
        label: profilesById.get(serverId)?.name?.trim() || serverId,
    }));
}

export type SessionListViewFilterController = Readonly<{
    filters: SessionListViewFilters;
    displayFilters: SessionListViewFilters;
    spaceMembership?: SessionListSpaceMembership;
    defaultFilters: SessionListViewFilters;
    contextDefaultFilters: SessionListViewFilters;
    updateFilters: React.Dispatch<React.SetStateAction<SessionListViewFilters>>;
    setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
    removeAuthoritativelyDeletedSelections: ReturnType<typeof useSessionListViewFilters>['removeAuthoritativelyDeletedSelections'];
    resetFilters(): void;
    showCoordinatorsRequest: 0 | 1;
    acknowledgeShowCoordinatorsRequest(): void;
    includeInactive: boolean;
    corpusStorage: SessionListCorpusStorage;
    setIncludeInactive(includeInactive: boolean): void;
    /** Edits this retained filter; Settings alone changes the device default. */
    setSource(source: SessionListViewFilters['source']): void;
    queryEnabled: boolean;
    corpusPresentation: SessionListCorpusPresentation;
    queryHomes: readonly (SessionListQueryHomeInput & Readonly<{ queryKey: string }>)[];
    /**
     * Homes handed to the canonical per-Home pagination owner, or `undefined` when
     * this corpus has no owner mounted and the incumbent ordinary Sync list is the
     * source. Archived always has an owner because its released GET adapter serves
     * Homes without filtered listing.
     */
    pagingHomes: readonly (SessionListQueryHomeInput & Readonly<{ queryKey: string }>)[] | undefined;
    /** True only when mounted filter options are known and qualified facets exclude every Home. */
    emptyQuerySelectionComplete?: boolean;
    followingAvailable: boolean;
    sourceAvailable: boolean;
    homeOptions: readonly Readonly<{ serverId: string; label: string }>[];
    viewContext: SessionListViewContext;
    viewContextKey: string;
    /** Stable across focused-Home changes; changes only with this context's credential-bound corpus. */
    retentionScopeKey: string;
    fixedHomeServerIds?: ReadonlySet<string>;
    fixedAudienceKeys?: ReadonlySet<string>;
    fixedShow?: SessionListViewFilters['show'];
    spaces: readonly CollectionSpaceV1<'sessionWork'>[];
    selectedSpaceId: string;
    selectedSpace: CollectionSpaceV1<'sessionWork'> | null;
    activeSpace: CollectionSpaceV1<'sessionWork'> | null;
    spacesEnabled: boolean;
    spacesReady: boolean;
    spaceSettingsScope: AccountSettingsScope | null;
    includeNeedsYouEverywhere: boolean;
    isSpaceModified: boolean;
    /** When unavailable, the pane retains the mounted list and its recovery controls. */
    filterControlsRequired?: boolean;
}>;

/**
 * Canonical owner for one Sessions surface's retained filter state and query
 * projection. The Home selector remains the owner of the mounted Home set; this
 * hook seeds a temporary view selection from the credential-bound Home corpus
 * for each global or exact-Team context.
 */
export function useSessionListViewFilterController(
    corpusStorage: SessionListCorpusStorage = 'active',
    viewContext: SessionListViewContext = GLOBAL_SESSION_LIST_VIEW_CONTEXT,
    fixedShow?: SessionListViewFilters['show'],
): SessionListViewFilterController {
    const selection = useSessionListSelectionState();
    const hideInactiveSessions = useSetting('hideInactiveSessions');
    const { externalSessionsEnabled, storageKind } = useSessionListStorageKind();
    // Source has one device-local owner, so this controller seeds it rather than
    // taking a per-surface default: mount order can no longer decide which default
    // the shared global context gets. With no Home exposing external Sessions the
    // facet cannot mean anything, so the corpus stays unnarrowed.
    const defaultSource: SessionListViewFilters['source'] = externalSessionsEnabled ? storageKind : 'all';
    const serverProfilesGeneration = useServerProfilesGeneration();
    const mountedHomeServerIds = React.useMemo(() => {
        const values = selection.allowedServerIds?.length
            ? selection.allowedServerIds
            : selection.activeServerId
                ? [selection.activeServerId]
                : [];
        return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
    }, [selection.activeServerId, selection.allowedServerIds]);
    const authoritativeHomeServerIds = React.useMemo(() => {
        const profileScopeIds = listServerProfileScopeIds(listServerProfiles());
        // A same-origin bootstrap can be mounted before it has a stored profile.
        return [...new Set([
            ...profileScopeIds,
            ...(selection.activeServerId ? [selection.activeServerId] : []),
        ])];
    }, [selection.activeServerId, serverProfilesGeneration]);
    const teamServerId = viewContext.kind === 'team' ? viewContext.team.serverId : undefined;
    const teamId = viewContext.kind === 'team' ? viewContext.team.teamId : undefined;
    const context = React.useMemo(() => {
        const base = resolveSessionListViewContextDefaults(viewContext, mountedHomeServerIds, defaultSource);
        return fixedShow ? { contextKey: `${base.contextKey}:show:${fixedShow}`, defaults: { ...base.defaults, show: fixedShow } } : base;
    }, [defaultSource, fixedShow, mountedHomeServerIds, teamId, teamServerId, viewContext.kind]);
    const defaultSpaceName = t('sessionsList.filtersMyWork');
    const defaultSpaceFilter = React.useMemo(() => toStoredSessionListFilter(context.defaults), [context.defaults]);
    const { spaces, selectedSpaceId, selectedSpace, activeSpace, spacesEnabled, spacesReady, spaceSettingsScope, spaceAccountScopeKey, admittedSpaces, savedSpace }
        = useCollectionSpaceBinding('sessionWork', { defaultName: defaultSpaceName, defaultFilter: defaultSpaceFilter });
    const contextDefaultFilters = React.useMemo(() => normalizeSessionListViewFilters(context.defaults, viewContext, fixedShow,
        corpusStorage === 'archived' ? true : undefined), [context.defaults, corpusStorage, fixedShow, teamId, teamServerId, viewContext.kind]);
    const defaultFilters = React.useMemo(() => activeSpace
        ? normalizeSessionListViewFilters({ ...activeSpace.filter, searchQuery: '' }, viewContext, fixedShow, corpusStorage === 'archived' ? true : undefined)
        : contextDefaultFilters, [activeSpace, contextDefaultFilters, corpusStorage, fixedShow, teamId, teamServerId, viewContext.kind]);
    const retainedContextKey = corpusStorage === 'archived' ? `${context.contextKey}:archived` : context.contextKey;
    const credentialServerIds = React.useMemo(() => viewContext.kind === 'team'
        ? [viewContext.team.serverId]
        : authoritativeHomeServerIds,
    [authoritativeHomeServerIds, viewContext]);
    const accountScopeResolutions = useServerCredentialAccountScopeResolutions(credentialServerIds);
    const participatingServerIds = viewContext.kind === 'team'
        ? [viewContext.team.serverId]
        : mountedHomeServerIds;
    const retentionScopeKey = buildSessionListViewCredentialScopeKey(
        retainedContextKey,
        accountScopeResolutions,
        participatingServerIds,
    );
    const retained = useSessionListViewFilters({
        contextKey: retainedContextKey,
        defaults: contextDefaultFilters,
        viewContext,
        fixedShow,
        fixedIncludeInactive: corpusStorage === 'archived' ? true : undefined,
        accountScopeResolutions,
        // Global Homes mount asynchronously; a Team context is fixed to its Home.
        followDefaultHomeSelection: viewContext.kind === 'global'
            && (!activeSpace || activeSpace.id === 'my-work' && !admittedSpaces.spaces.some(space => space.id === 'my-work')),
        authoritativeHomeServerIds,
        savedSpace: spacesReady ? savedSpace ?? null : undefined,
        spaceSettingsAccountScopeKey: spaceSettingsScope ? spaceAccountScopeKey : null,
    });
    // Archived Sessions are inactive by definition, so the active list's
    // `Hide inactive sessions` preference cannot narrow this corpus: applying it
    // would make the archived destination authoritatively empty.
    const includeInactive = corpusStorage === 'archived'
        ? true
        : retained.filters.includeInactive ?? (hideInactiveSessions !== true);
    const spaceMembership = React.useMemo<SessionListSpaceMembership | undefined>(() => activeSpace?.membership
        ? { filter: activeSpace.filter, membership: activeSpace.membership } : undefined, [activeSpace]);
    const displayFilters = spaceMembership ? retained.refinements : retained.filters;
    const viewerAccountIdByServerId = React.useMemo(() => new Map([...accountScopeResolutions].flatMap(([serverId, resolution]) =>
        resolution.kind === 'bound' ? [[serverId, resolution.scope.accountId] as const] : [])), [accountScopeResolutions]);
    // Admission is decided per exact Home. One capable Home mounts the filtered
    // corpus for the whole surface; the remaining Homes contribute their own
    // truthful loading, disabled, unsupported or offline state instead of
    // suppressing it. Only a selection where no Home can serve the query and no
    // corpus has a released GET adapter falls back to the incumbent ordinary list.
    //
    // Support is probed for every selected mounted Home, before any facet narrows
    // the set. Whether a Home can serve filtered listing is a property of that Home,
    // not of the current selection, and deriving it from the post-facet set would
    // make the tag facet's own meaning depend on itself.
    const selectedHomeServerIds = React.useMemo(
        () => mountedHomeServerIds.filter((serverId) => displayFilters.homeServerIds.includes(serverId)),
        [mountedHomeServerIds, displayFilters.homeServerIds],
    );
    const homeSupportByServerId = useSessionListQueryHomeSupportByServerId(selectedHomeServerIds, true);
    const followingSupportByServerId = useSessionListFeatureHomeSupportByServerId(
        'sessions.following',
        selectedHomeServerIds,
        true,
    );
    const sourceSupportByServerId = useSessionListFeatureHomeSupportByServerId(
        'sessions.direct',
        selectedHomeServerIds,
        true,
    );
    const queryEnabled = resolveSelectedHomeFeatureAvailability(selectedHomeServerIds, homeSupportByServerId);
    const followingAvailable = resolveSelectedHomeFeatureAvailability(selectedHomeServerIds, followingSupportByServerId);
    const sourceAvailable = resolveSelectedHomeFeatureAvailability(selectedHomeServerIds, sourceSupportByServerId);
    const queryHomes = React.useMemo(
        () => buildSessionListFilterQueryHomes(displayFilters, {
            storage: corpusStorage,
            // Completed step Sessions still belong beneath their Run. The query
            // keeps them available; the list's canonical activity projection
            // applies the person's ordinary Session preference after nesting.
            includeInactive: includeInactive || (corpusStorage === 'active' && retained.filters.show !== 'sessions'),
            mountedHomeServerIds,
            // No selected Home can express tags structurally, so the released GET
            // adapter serves the corpus and the qualified tag selection narrows its
            // loaded rows locally instead of producing an unanswerable request.
            tagFacet: queryEnabled || spaceMembership ? 'query' : 'local',
            sectionFacet: queryEnabled || spaceMembership ? 'query' : 'local',
            spaceMembership,
            viewerAccountIdByServerId,
        }).map((home) => ({
            ...home,
            ordinaryAdapter: resolveSessionListFilterOrdinaryPageAdapter(displayFilters, home.query),
        })),
        [corpusStorage, includeInactive, mountedHomeServerIds, queryEnabled, retained.filters.show, displayFilters, spaceMembership, viewerAccountIdByServerId],
    );
    const useQuerySource = Boolean(spaceMembership) || shouldUseSessionListFilterQuerySource(displayFilters, {
        mountedHomeServerIds,
        queryEnabled,
        hasOrdinaryAdapter: queryHomes.some((home) => home.ordinaryAdapter !== null),
    });
    const pagingHomes = useQuerySource ? queryHomes : undefined;
    const corpusPresentation: SessionListCorpusPresentation = queryEnabled || spaceMembership
        ? 'semantic_query'
        : 'legacy_owner_or_direct';
    const emptyQuerySelectionComplete = isSessionListEmptyQuerySelectionComplete({
        useQuerySource,
        mountedHomeCount: mountedHomeServerIds.length,
        queryHomeCount: queryHomes.length,
    });
    const homeOptions = React.useMemo(() => buildSessionListFilterHomeOptions(
        viewContext.kind === 'team' ? [viewContext.team.serverId] : mountedHomeServerIds,
    ), [mountedHomeServerIds, viewContext]);
    const fixedHomeServerIds = React.useMemo(
        () => viewContext.kind === 'team'
            ? new Set([viewContext.team.serverId])
            : undefined,
        [viewContext],
    );
    const fixedAudienceKeys = React.useMemo(
        () => viewContext.kind === 'team'
            ? new Set([buildQualifiedAudienceSelectionKey({
                serverId: viewContext.team.serverId,
                kind: 'team',
                teamId: viewContext.team.teamId,
            })])
            : undefined,
        [viewContext],
    );
    const updateFilters = retained.updateFilters;
    const setIncludeInactive = React.useCallback((value: boolean) => {
        if (corpusStorage === 'archived') return;
        updateFilters(current => current.includeInactive === value ? current : { ...current, includeInactive: value });
    }, [corpusStorage, updateFilters]);
    const setSource = React.useCallback((source: SessionListViewFilters['source']) => {
        updateFilters((current) => (current.source === source ? current : { ...current, source }));
    }, [updateFilters]);

    return React.useMemo(() => ({
        ...retained,
        displayFilters,
        spaceMembership,
        defaultFilters,
        contextDefaultFilters,
        spaces,
        selectedSpaceId,
        selectedSpace,
        activeSpace,
        spacesEnabled,
        spacesReady,
        spaceSettingsScope,
        includeNeedsYouEverywhere: activeSpace?.includeNeedsYouEverywhere ?? false,
        isSpaceModified: !sameStrictJsonValue(toStoredSessionListFilter(retained.filters), toStoredSessionListFilter(defaultFilters)),
        // All accessible broadens the default corpus; other edits still need
        // their controls when empty, including conditions stored in a Space.
        filterControlsRequired: corpusStorage === 'archived' || retained.filters.searchQuery.trim().length > 0
            || !sameStrictJsonValue({ ...retained.filters, searchQuery: '',
                scope: retained.filters.scope === 'all_accessible' ? contextDefaultFilters.scope : retained.filters.scope,
            }, contextDefaultFilters),
        includeInactive,
        corpusStorage,
        setIncludeInactive,
        setSource,
        queryEnabled,
        corpusPresentation,
        queryHomes,
        pagingHomes,
        emptyQuerySelectionComplete,
        followingAvailable,
        sourceAvailable,
        homeOptions,
        viewContext,
        viewContextKey: context.contextKey,
        retentionScopeKey,
        fixedHomeServerIds,
        fixedAudienceKeys,
        fixedShow,
    }), [
        context.defaults,
        defaultFilters,
        contextDefaultFilters,
        spaces,
        selectedSpaceId,
        selectedSpace,
        activeSpace,
        spacesEnabled,
        spacesReady,
        spaceSettingsScope,
        context.contextKey,
        corpusStorage,
        fixedAudienceKeys,
        fixedHomeServerIds,
        fixedShow,
        followingAvailable,
        homeOptions,
        includeInactive,
        pagingHomes,
        emptyQuerySelectionComplete,
        queryEnabled,
        corpusPresentation,
        queryHomes,
        retained,
        displayFilters,
        spaceMembership,
        retentionScopeKey,
        setIncludeInactive,
        setSource,
        sourceAvailable,
        viewContext,
    ]);
}
