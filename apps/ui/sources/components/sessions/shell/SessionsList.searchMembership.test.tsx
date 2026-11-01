import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Third-party rendering is outside this listing contract; its streaming renderer is unused here.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    buildSessionListIndexNodeId,
    type SessionListIndexItem,
} from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListQueryHomeState } from '@/sync/domains/session/listing/sessionListQueryController';
import type { VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import { storage } from '@/sync/domains/state/storageStore';

import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import type { SessionListViewFilterController } from './search/useSessionListViewFilterController';
import { createSessionListViewFilterDefaults } from './search/sessionListViewFilters';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HOME = 'server_a';
const TEAM_HOME = 'server_b';
const APPLIED_QUERY_KEY = 'query-b';

/**
 * The contextual transcript provider is the genuine boundary here: this captures the
 * eligibility the main-list host hands it and replays a provider result. Everything
 * that decides whether a hit may become a row stays real.
 */
const memorySearchCalls = vi.hoisted(() => ({
    lastEligibleSessionIds: undefined as readonly string[] | undefined,
    searchedServerIds: [] as string[],
    targets: [] as Array<{ sessionKey: string; serverId: string; accountId: string; sessionId: string; reasons: readonly ['transcript']; sourceMachineId: string | null }>,
}));
const universalSearchOpenSpy = vi.hoisted(() => vi.fn());

vi.mock('./search/useSessionListMemorySearchAugmentation', () => ({
    SESSION_LIST_MEMORY_SEARCH_MIN_QUERY_LENGTH: 2,
    useSessionListMemorySearchContext: (target?: { serverId?: string | null }) => ({
        providerDecision: { provider: 'home', queryAvailable: true, homeServerId: String(target?.serverId ?? '') },
        isHomeProvider: true,
        serverId: String(target?.serverId ?? ''),
        machineId: null,
        activeScopeKey: `scope:${String(target?.serverId ?? '')}`,
        accountBinding: target?.serverId
            ? {
                accountId: target.serverId === TEAM_HOME ? 'account-b' : 'account-a',
                isCurrent: () => true,
                onRetire: () => () => {},
                revision: 1,
            }
            : null,
    }),
    useSessionListMemorySearchAugmentationForContext: (
        input: { searchQuery: string; eligibleSessionIds?: readonly string[] },
        context: { activeScopeKey: string; serverId: string },
    ) => {
        memorySearchCalls.lastEligibleSessionIds = input.eligibleSessionIds;
        memorySearchCalls.searchedServerIds.push(context.serverId);
        return {
            memoryMatchedSessionKeys: new Set(memorySearchCalls.targets.map((target) => target.sessionKey)),
            memoryMatchedSessionTargets: memorySearchCalls.targets,
            isSearchingMemory: false,
            lastSuccessfulQuery: input.searchQuery.trim(),
            lastSuccessfulScopeKey: context.activeScopeKey,
            activeScopeKey: context.activeScopeKey,
        };
    },
}));

vi.mock('@/hooks/session/useSessionListSelectionState', () => ({
    useSessionListSelectionState: () => ({
        enabled: false,
        presentation: 'single',
        activeTarget: null,
        activeServerId: HOME,
        allowedServerIds: [HOME],
        selectedServerCount: 1,
    }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    getCurrentAuth: () => null,
    useAuth: () => ({ refreshFromActiveServer: async () => undefined }),
}));

installSessionShellCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: '/' }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    // The real store owns rows, membership and searchable text; this suite seeds it
    // through the canonical row writers rather than stubbing the projection.
    storage: async (importOriginal) => await importOriginal(),
});

function renderableSession(id: string, name: string): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 0,
        archivedAt: null,
        metadata: { name },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'offline',
    } as unknown as SessionListRenderableSession;
}

function sessionNodeId(serverId: string, sessionId: string): string {
    return buildSessionListIndexNodeId({ type: 'session', serverId, sessionId });
}

function homeState(
    appliedQueryKey: string,
    sessionIds: readonly string[],
    serverId = HOME,
): SessionListQueryHomeState {
    return {
        requestedQueryKey: APPLIED_QUERY_KEY,
        appliedQueryKey,
        addresses: sessionIds.map((sessionId) => ({ serverId, sessionId })),
        nextCursor: 'cursor-1',
        hasNext: true,
        attentionNextCursor: null,
        attentionHasNext: false,
        phase: 'ready',
        freshnessAt: 10,
        failureReason: null,
        failureCode: null,
        appliedSourceKind: 'query',
    };
}

const VISIBLE_INDEX: readonly SessionListIndexItem[] = [
    { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'group-a', serverId: HOME },
    { type: 'session', sessionId: 'in-view', serverId: HOME, groupKey: 'group-a', groupKind: 'date' },
];

function buildPaneState(
    state: SessionListQueryHomeState,
    serverId = HOME,
): VisibleSessionListPaneState {
    const visibleIndex: readonly SessionListIndexItem[] = serverId === HOME
        ? VISIBLE_INDEX
        : [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'group-a', serverId },
            { type: 'session', sessionId: 'in-view', serverId, groupKey: 'group-a', groupKind: 'date' },
        ];
    return {
        summary: { sessionsReady: true, sessionCount: 1 },
        visibleSessionListIndex: visibleIndex,
        hasHiddenInactiveSessions: false,
        folderFocus: null,
        showLoading: false,
        showEmptyState: false,
        query: {
            active: true,
            statesByServerId: { [serverId]: state },
            byServerId: { [serverId]: visibleIndex },
            source: visibleIndex,
            coverageComplete: false,
            loadNext: async () => {},
            refresh: async () => {},
            retry: async () => {},
        },
    } as unknown as VisibleSessionListPaneState;
}

function buildFilterController(
    overrides: Partial<SessionListViewFilterController> = {},
): SessionListViewFilterController {
    const filters = {
        ...createSessionListViewFilterDefaults(),
        scope: 'my_work' as const,
        attention: 'any' as const,
        homeServerIds: [HOME],
        audiences: [],
        tagIds: [],
        source: 'all' as const,
        searchQuery: 'needle',
    };
    return {
        filters,
        defaultFilters: { ...filters, searchQuery: '' },
        updateFilters: () => {},
        setSearchQuery: () => {},
        resetFilters: () => {},
        includeInactive: true,
        setIncludeInactive: () => {},
        setSource: () => {},
        queryEnabled: true,
        queryHomes: [{
            serverId: HOME,
            queryKey: APPLIED_QUERY_KEY,
            query: {
                v: 1,
                storage: 'active',
                includeInactive: true,
                scope: 'my_work',
                attention: 'any',
                audiences: [],
                tagIds: [],
            },
        }],
        followingAvailable: true,
        sourceAvailable: false,
        homeOptions: [{ serverId: HOME, label: HOME }],
        viewContext: { kind: 'global' },
        viewContextKey: 'global',
        retentionScopeKey: 'global:home-a',
        ...overrides,
    } as unknown as SessionListViewFilterController;
}

const { useSessionListViewStateFromPaneState } = await import('./useSessionListViewState');

async function renderMainListViewState(
    state: SessionListQueryHomeState,
    filterController = buildFilterController(),
    serverId = HOME,
) {
    const observed: {
        renders: number;
        nodeIds: readonly string[];
        searchScopeLabel?: string;
        filterControl?: React.ReactNode;
        onSearchEverything?: (query: string) => void;
    } = {
        renders: 0,
        nodeIds: [],
    };

    function Probe() {
        observed.renders += 1;
        const viewState = useSessionListViewStateFromPaneState(
            'all',
            buildPaneState(state, serverId),
            filterController,
            {
                pathname: '/',
                surfaceOwnership: {
                    ownerKey: 'phone-root',
                    visible: true,
                    dataActive: true,
                    interactive: true,
                },
            },
        );
        observed.nodeIds = viewState.nodeIds;
        observed.searchScopeLabel = viewState.searchChrome.searchScopeLabel;
        observed.filterControl = viewState.searchChrome.filterControl;
        observed.onSearchEverything = viewState.searchChrome.onSearchEverything;
        return null;
    }

    const { UniversalSearchRuntimeProvider } = await import('@/components/appShell/search/UniversalSearchRuntimeContext');
    const screen = await renderScreen(
        <UniversalSearchRuntimeProvider value={{ open: universalSearchOpenSpy, buildCommands: () => [] } as never}>
            <Probe />
        </UniversalSearchRuntimeProvider>,
    );
    await act(async () => {});
    return { observed, screen };
}

describe('main-list contextual search structural membership', () => {
    beforeEach(() => {
        memorySearchCalls.lastEligibleSessionIds = undefined;
        memorySearchCalls.searchedServerIds = [];
        memorySearchCalls.targets = [];
        universalSearchOpenSpy.mockClear();
        // The canonical row cache is a union of everything this Account has loaded,
        // including rows that only ever satisfied an earlier query.
        storage.getState().mergeSessionListRowsForServerScope(HOME, [
            renderableSession('in-view', 'needle alpha'),
            renderableSession('hidden-by-filters', 'needle beta'),
            renderableSession('stale-a', 'needle gamma'),
        ]);
        storage.getState().mergeSessionListRowsForServerScope(TEAM_HOME, [
            renderableSession('in-view', 'needle team alpha'),
            renderableSession('team-other-match', 'needle team beta'),
        ]);
    });

    afterEach(() => {
        storage.getState().clearSessionListRowsForServerScope(HOME);
        storage.getState().clearSessionListRowsForServerScope(TEAM_HOME);
        standardCleanup();
    });

    it('does not render for unrelated Profile changes and still follows Account identity', async () => {
        const initialProfile = storage.getState().profile;
        const { observed } = await renderMainListViewState(homeState(APPLIED_QUERY_KEY, ['in-view']));
        try {
            const before = observed.renders;
            await act(async () => storage.setState({ profile: { ...initialProfile, firstName: 'Updated' } }));
            expect(observed.renders - before).toBe(0);
            await act(async () => storage.setState({ profile: { ...initialProfile, id: 'other-account' } }));
            expect(observed.renders).toBeGreaterThan(before);
        } finally {
            await act(async () => storage.setState({ profile: initialProfile }));
        }
    });

    it('keeps the filter control mounted when no selected Home serves filtered listing or Source', async () => {
        const { observed } = await renderMainListViewState(
            homeState(APPLIED_QUERY_KEY, ['in-view']),
            buildFilterController({
                queryEnabled: false,
                sourceAvailable: false,
                corpusPresentation: 'legacy_owner_or_direct',
                corpusStorage: 'active',
            } as never),
        );

        // Hide inactive lives only in this editor now; the sections inside are
        // individually availability-gated, so the host itself must not disappear.
        expect(observed.filterControl).toBeDefined();
    });

    it('admits only rows in the current structural corpus as metadata Other matches', async () => {
        const { observed } = await renderMainListViewState(
            homeState(APPLIED_QUERY_KEY, ['in-view', 'hidden-by-filters']),
        );

        expect(observed.nodeIds).toContain(sessionNodeId(HOME, 'in-view'));
        // In the corpus but outside the current rendered view: still a valid match.
        expect(observed.nodeIds).toContain(sessionNodeId(HOME, 'hidden-by-filters'));
        // Only ever satisfied an earlier query: cache presence is not membership.
        expect(observed.nodeIds).not.toContain(sessionNodeId(HOME, 'stale-a'));
    });

    it('never promotes a provider transcript hit outside the current structural corpus', async () => {
        memorySearchCalls.targets = [{
            sessionKey: `${HOME}:stale-a`,
            serverId: HOME,
            accountId: 'account-a',
            sessionId: 'stale-a',
            reasons: ['transcript'],
            sourceMachineId: null,
        }];

        const { observed } = await renderMainListViewState(
            homeState(APPLIED_QUERY_KEY, ['in-view', 'hidden-by-filters']),
        );

        expect(observed.nodeIds).not.toContain(sessionNodeId(HOME, 'stale-a'));
        expect(observed.nodeIds).toContain(sessionNodeId(HOME, 'hidden-by-filters'));
    });

    it('scopes the provider eligibility to the exact Home structural corpus', async () => {
        const { observed } = await renderMainListViewState(homeState(APPLIED_QUERY_KEY, ['in-view', 'hidden-by-filters']));

        expect(memorySearchCalls.lastEligibleSessionIds).toEqual(['in-view', 'hidden-by-filters']);
        expect(observed.searchScopeLabel).toBe(`sessionsList.searchMatchTranscript · teams.homeLabel · ${HOME}`);
    });

    it('binds Team transcript search to the Team Home while another Home is focused', async () => {
        memorySearchCalls.targets = [{
            sessionKey: `${TEAM_HOME}:team-other-match`,
            serverId: TEAM_HOME,
            accountId: 'account-b',
            sessionId: 'team-other-match',
            reasons: ['transcript'],
            sourceMachineId: null,
        }];
        const filters = {
            ...createSessionListViewFilterDefaults(),
            scope: 'all_accessible' as const,
            attention: 'any' as const,
            homeServerIds: [TEAM_HOME],
            audiences: [{ serverId: TEAM_HOME, kind: 'team' as const, teamId: 'team-acme' }],
            tagIds: [],
            source: 'all' as const,
            searchQuery: 'needle',
        };
        const filterController = buildFilterController({
            filters,
            defaultFilters: filters,
            queryHomes: [{
                serverId: TEAM_HOME,
                queryKey: APPLIED_QUERY_KEY,
                query: {
                    v: 1,
                    storage: 'active',
                    includeInactive: true,
                    scope: 'all_accessible',
                    attention: 'any',
                    audiences: [{ kind: 'team', teamId: 'team-acme' }],
                    tagIds: [],
                },
            }],
            homeOptions: [{ serverId: TEAM_HOME, label: 'Studio Home B' }],
            viewContext: {
                kind: 'team',
                team: { serverId: TEAM_HOME, teamId: 'team-acme' },
                teamDisplayName: 'Acme',
            },
            viewContextKey: `team:${TEAM_HOME}:team-acme`,
        });

        const { observed } = await renderMainListViewState(
            homeState(APPLIED_QUERY_KEY, ['in-view', 'team-other-match'], TEAM_HOME),
            filterController,
            TEAM_HOME,
        );

        expect(new Set(memorySearchCalls.searchedServerIds)).toEqual(new Set([TEAM_HOME]));
        expect(memorySearchCalls.lastEligibleSessionIds).toEqual(['in-view', 'team-other-match']);
        expect(observed.searchScopeLabel).toBe('sessionsList.searchMatchTranscript · teams.homeLabel · Studio Home B');
        expect(observed.nodeIds).toContain(sessionNodeId(TEAM_HOME, 'team-other-match'));
    });

    it('opens Search everything with the explicit Team Home credential scope while Home A stays focused', async () => {
        const filters = {
            ...createSessionListViewFilterDefaults(),
            scope: 'all_accessible' as const,
            attention: 'any' as const,
            homeServerIds: [TEAM_HOME],
            audiences: [{ serverId: TEAM_HOME, kind: 'team' as const, teamId: 'team-acme' }],
            tagIds: [],
            source: 'all' as const,
            searchQuery: 'needle',
        };
        const filterController = buildFilterController({
            filters,
            defaultFilters: filters,
            queryHomes: [{
                serverId: TEAM_HOME,
                queryKey: APPLIED_QUERY_KEY,
                query: {
                    v: 1,
                    storage: 'active',
                    includeInactive: true,
                    scope: 'all_accessible',
                    attention: 'any',
                    audiences: [{ kind: 'team', teamId: 'team-acme' }],
                    tagIds: [],
                },
            }],
            homeOptions: [{ serverId: TEAM_HOME, label: 'Studio Home B' }],
            viewContext: {
                kind: 'team',
                team: { serverId: TEAM_HOME, teamId: 'team-acme' },
                teamDisplayName: 'Acme',
            },
            viewContextKey: `team:${TEAM_HOME}:team-acme`,
        });

        const { observed } = await renderMainListViewState(
            homeState(APPLIED_QUERY_KEY, ['in-view'], TEAM_HOME),
            filterController,
            TEAM_HOME,
        );

        act(() => observed.onSearchEverything?.('needle'));

        expect(universalSearchOpenSpy).toHaveBeenCalledWith('needle', {
            accountId: 'account-b',
            serverId: TEAM_HOME,
            sessionId: null,
            machineId: null,
            rootPath: null,
        });
        expect(universalSearchOpenSpy).not.toHaveBeenCalledWith(
            'needle',
            expect.objectContaining({ accountId: 'account-a', serverId: HOME }),
        );
    });

    it('treats a Home whose applied corpus is stale as contributing no membership', async () => {
        memorySearchCalls.targets = [{
            sessionKey: `${HOME}:hidden-by-filters`,
            serverId: HOME,
            accountId: 'account-a',
            sessionId: 'hidden-by-filters',
            reasons: ['transcript'],
            sourceMachineId: null,
        }];

        const { observed } = await renderMainListViewState(homeState('query-a', ['in-view', 'hidden-by-filters']));

        expect(memorySearchCalls.lastEligibleSessionIds).toEqual([]);
        expect(observed.nodeIds).not.toContain(sessionNodeId(HOME, 'hidden-by-filters'));
        expect(observed.nodeIds).not.toContain(sessionNodeId(HOME, 'stale-a'));
    });

    it('keeps the incumbent filter control reachable for local Source filtering without server queries', async () => {
        const { observed } = await renderMainListViewState(
            homeState(APPLIED_QUERY_KEY, ['in-view']),
            buildFilterController({ queryEnabled: false, sourceAvailable: true }),
        );

        expect(observed.filterControl).toBeTruthy();
    });
});
