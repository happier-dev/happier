import * as React from 'react';
import { FlatList, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { compileDiscussionListFilterV1, DEFAULT_DISCUSSION_LIST_FILTER_V1, DiscussionListFilterPatchV1Schema,
    discussionListFilterFieldsV1, type DiscussionListFilterV1, type DiscussionListFilterFactsV1 } from '@happier-dev/protocol/discussions/listing/discussionListFilterV1';
import { getUnsupportedEntityFilterFieldsV1 } from '@happier-dev/protocol/collections/filter/fieldRegistryV1';
import type { EntityListFilterResultV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import { useCollectionSpaceFilter } from '@/components/ui/lists/collection/useCollectionSpaceFilter';
import { useCollectionSpaceHeader } from '@/components/ui/lists/collection/useCollectionSpaceHeader';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { CollectionConditionBindings } from '@happier-dev/plugin-ui/components';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { registerDiscussionListScopeActionOwner } from '@/sync/ops/actions/scopeActionFamily';

import { DiscussionRow, DiscussionRowSkeleton } from '@/components/discussions/DiscussionRow';
import { useDiscussionListRows } from '@/sync/ops/discussions/useDiscussionListRows';
import { discussionWaitingSessionName } from './discussionSessionLabel';
import type { DiscussionListRow } from '@/activity/attention/buildDiscussionListAttention';
import { useOpenDiscussion } from './useOpenDiscussion';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { COLLECTION_LIST_SEARCH_THRESHOLD, CollectionList, CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { PaneSectionHeader } from '@/components/ui/lists/PaneSectionHeader';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import {
    useServerCredentialAccountScopeBindings,
    type ServerCredentialAccountScopeBinding,
} from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { DiscussionRepositoryStatus } from '@/sync/ops/discussions/discussionRepository';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { useDiscussionRepositorySnapshot } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import { useDiscussionListSearch } from '@/sync/ops/discussions/useDiscussionListSearch';
import { t } from '@/text';
import {
    buildDiscussionActivityItems,
    buildDiscussionColumnItems,
    discussionActivityItemKey,
    type DiscussionRecencyGroup,
    selectDiscussionSummariesForAnchor,
    type DiscussionActivityItem,
} from '@/components/discussions/discussionActivityItems';
import { useSessionConversationsAvailability } from '@/components/sessions/conversations/useSessionConversationsAvailability';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useSessionDisplayNameProjections, useSetting } from '@/sync/domains/state/storage';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

const SKELETON_ROWS = [0, 1, 2] as const;

const styles = StyleSheet.create((theme) => ({
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s2 },
    root: { flex: 1, minHeight: 0, minWidth: 0 },
    list: { flex: 1, minHeight: 0 },
    listContent: { flexGrow: 1, paddingBottom: theme.space.s8 },
    // With the host's sections after it, the list is one section of a flow: it never grows to push them down.
    listContentFlow: { paddingBottom: theme.space.s8 },
    stateLine: { paddingHorizontal: theme.space.s8 },
    invite: { paddingTop: theme.space.s20, paddingHorizontal: theme.space.s12 },
    // The pane's invite opens right under its section label; the state's own frame holds its air.
    paneInvite: { paddingHorizontal: theme.space.s12 },
    freshness: { paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s6 },
    archivedDisclosure: {
        minHeight: HAPPIER_PAGE_METRICS.controlHeightPx,
        marginTop: theme.space.s4,
        marginHorizontal: theme.space.s8,
        paddingHorizontal: theme.space.s8,
        borderRadius: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    archivedLabel: {
        ...Typography.default(),
        ...ITEM_SUBTITLE_TEXT_METRICS.compact,
        color: theme.colors.text.secondary,
    },
    center: { minHeight: 64, alignItems: 'center', justifyContent: 'center', padding: theme.space.s16 },
    more: { minHeight: HAPPIER_PAGE_METRICS.controlHeightPx, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
    moreText: { ...Typography.default('semiBold'), ...ITEM_SUBTITLE_TEXT_METRICS.compact, color: theme.colors.text.link },
}));

type DiscussionListItem = DiscussionActivityItem
    | Readonly<{ kind: 'archived_disclosure' }>
    | Readonly<{ kind: 'archived_discussion'; discussion: DiscussionOpenedSummaryV1 }>
    | Readonly<{ kind: 'archived_loading' | 'archived_empty' | 'archived_error' | 'archived_load_more' | 'filter_empty' | 'search_empty' | 'search_more' }>;

/** What the Discussions column shows (lab T2-A filter): everything, or only what needs you, unread or archived. */
type DiscussionColumnFilter = 'all' | 'needs_you' | 'unread' | 'archived';

/** The Discussion fields' words in the shared condition editor (R9): Status, Needs you, Unread. */
function buildDiscussionConditionBindings(): CollectionConditionBindings {
    const needsYou = t('session.collaboration.discussion.home.needsYou');
    const unread = t('session.collaboration.discussion.home.filterUnread');
    return { fields: {
        state: { label: t('sessionsList.filtersStatus'), valueOptions: [
            { value: 'active', label: t('sessionsList.conditionActive') },
            { value: 'archived', label: t('session.collaboration.discussion.archived') },
        ] },
        attention: { label: needsYou, valueOptions: [{ value: true, label: needsYou }] },
        unreadOnly: { label: unread, valueOptions: [{ value: true, label: unread }] },
    } };
}
const DISCUSSION_SPACE_ICON = { kind: 'icon', name: 'conversations' } as const;

/** Summary facts stay held by the repository; attention exists only where the current scoped join knows it. */
function discussionListFilterFacts(row: DiscussionOpenedSummaryV1, attention?: DiscussionListRow): DiscussionListFilterFactsV1 {
    const needsYou = attention ? resolveWorkStatusTone({ kind: 'discussion', facts: attention }).bucket === 'needs_you'
        ? true : attention.approvalAttentionAvailable ? false : undefined : undefined;
    return { state: row.archivedAt === null ? 'active' : 'archived', unread: row.unreadCount > 0,
        ...(needsYou === undefined ? {} : { needsYou }) };
}

function discussionListItemKey(item: DiscussionListItem): string {
    switch (item.kind) {
        case 'archived_discussion': return `archived:${item.discussion.id}`;
        case 'archived_disclosure':
        case 'archived_loading':
        case 'archived_empty':
        case 'archived_error':
        case 'archived_load_more':
        case 'filter_empty':
        case 'search_empty':
        case 'search_more': return item.kind;
        default: return discussionActivityItemKey(item);
    }
}

/** The failures a read can end in that retain nothing new to show; the section says what failed. */
function isUnreadable(status: DiscussionRepositoryStatus): boolean {
    return status === 'error' || status === 'offline' || status === 'locked' || status === 'revoked';
}

function recencyGroupTitle(group: DiscussionRecencyGroup): string {
    switch (group) {
        case 'needs_you': return t('session.collaboration.discussion.home.needsYou');
        case 'today': return t('session.collaboration.discussion.home.today');
        case 'this_week': return t('session.collaboration.discussion.home.thisWeek');
        case 'earlier': return t('session.collaboration.discussion.home.earlier');
    }
}

/**
 * Where the list stands. `pane`: a section of the Session's People pane, under its own heading with
 * its "+" (lab collab C1). `column`: the Discussions destination's column (lab T2-A), titled by the
 * column with "+" at its header and grouped by what needs you and recency; `surface` says whether it
 * stands beside the open Discussion (`plane`) or is the destination's first screen (`page`, a phone).
 */
export type DiscussionsListPresentation = 'pane' | 'column';

/** One sentence for a list that could not be read (the archived list and the active section's line). */
function readFailureLine(status: DiscussionRepositoryStatus, errorCode: string | null | undefined): string {
    switch (status) {
        case 'offline': return t('session.collaboration.discussion.offline');
        case 'revoked': return t('session.collaboration.pane.revokedTitle');
        case 'locked': return errorCode === 'discussion_encryption_mode_mismatch'
            ? t('session.collaboration.discussion.modeMismatch')
            : t('session.collaboration.pane.lockedTitle');
        default: return t('session.collaboration.discussion.loadError');
    }
}

/**
 * The canonical Home list, also consumed by the Session People anchor adapter.
 *
 * Repository, paging, and action decisions live here exactly once; the Collaboration surface owns
 * placement (presence, Responsible and the access card around it), never list state.
 */
export function DiscussionsList(props: Readonly<{
    address: Readonly<{ serverId: string }>;
    scope: ServerAccountScope;
    anchor?: Readonly<{ kind: 'session'; sessionId: string }>;
    presentation?: DiscussionsListPresentation;
    surface?: 'plane' | 'page';
    /**
     * What the host draws after the conversations, inside the list's one scroller (a Session's People
     * pane: Followers and Following). Placement only; it holds no list state.
     */
    footer?: React.ReactElement | null;
}>): React.ReactElement {
    const requestedServerIds = React.useMemo(() => [props.address.serverId], [props.address.serverId]);
    const bindings = useServerCredentialAccountScopeBindings(requestedServerIds);
    const binding = React.useMemo(() => [...bindings.values()][0] ?? null, [bindings]);
    const available = useSessionConversationsAvailability(props.address.serverId);
    const unavailableReason = !available
        ? t('session.collaboration.discussion.featureUnavailable')
        : !binding
            ? t('session.collaboration.discussion.bindingUnavailable')
            : !areServerAccountScopesEqual(binding.scope, props.scope)
                ? t('session.collaboration.discussion.scopeMismatch')
                : null;
    if (unavailableReason || !binding) return <DiscussionsListPaneState footer={props.footer}><SurfaceStateCard
        testID="session-conversations-unavailable"
        kind="unavailable"
        title={t('session.collaboration.discussion.unavailable')}
        reason={unavailableReason ?? t('session.collaboration.discussion.bindingUnavailable')}
    /></DiscussionsListPaneState>;
    return <DiscussionsListReady address={props.address} scope={props.scope} anchor={props.anchor} accountLifetime={binding} presentation={props.presentation ?? 'pane'} surface={props.surface ?? 'plane'} footer={props.footer ?? null} />;
}

/** A whole-list state in the pane: the state, and the host's footer still in reach below it. */
function DiscussionsListPaneState(props: Readonly<{ footer?: React.ReactElement | null; children: React.ReactElement }>) {
    if (!props.footer) return props.children;
    return <ScrollView style={paneStateStyles.scroll} testID="session-conversations-state-scroll">{props.children}{props.footer}</ScrollView>;
}

/**
 * The Conversations list (lab `collab` C1): one virtualized list whose heading, rows, reserved
 * first-load rows, invitation and archived disclosure are all list items, so exactly one scroller and
 * virtualization owner sits under the surface's flex body.
 *
 * Whole-list failures that leave nothing to read — locked encryption, removed access — replace the
 * list with one pane state. A failure with conversations retained keeps them at full strength under
 * one freshness line.
 */
function DiscussionsListReady(props: Readonly<{
    address: Readonly<{ serverId: string }>;
    scope: ServerAccountScope;
    anchor?: Readonly<{ kind: 'session'; sessionId: string }>;
    accountLifetime: ServerCredentialAccountScopeBinding;
    presentation: DiscussionsListPresentation;
    surface: 'plane' | 'page';
    footer: React.ReactElement | null;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const column = props.presentation === 'column';
    const statusWords = useSetting('sessionListStatusWords');
    const presented = useLayoutPresentationActive();
    const focused = useIsFocused();
    const focusEligible = usePluginSurfaceFocusEligibility();
    const view = useCollectionSpaceFilter('discussion', { lifetime: props.accountLifetime,
        defaultName: t('sessionsList.spacesAllDiscussions'), defaultFilter: DEFAULT_DISCUSSION_LIST_FILTER_V1 });
    const filters = column ? view.filters : DEFAULT_DISCUSSION_LIST_FILTER_V1;
    // The existing menu is a presentation of common selections, not a separate filter owner.
    const filter: DiscussionColumnFilter = filters.state === 'archived' ? 'archived'
        : filters.attention === 'needs_you' ? 'needs_you' : filters.unreadOnly ? 'unread' : 'all';
    const query = column ? view.searchQuery : '';
    const update = React.useCallback((patch: Readonly<{ filters?: Partial<DiscussionListFilterV1>; searchQuery?: string }>): boolean => {
        const selected = patch.filters ? DiscussionListFilterPatchV1Schema.safeParse(patch.filters) : null;
        if (selected && (!selected.success || getUnsupportedEntityFilterFieldsV1(discussionListFilterFieldsV1,
            { ...DEFAULT_DISCUSSION_LIST_FILTER_V1, ...selected.data }, 'list').length > 0)) return false;
        return view.update({ ...(selected?.success ? { filters: selected.data } : {}), searchQuery: patch.searchQuery });
    }, [view.update]);
    const setQuery = React.useCallback((searchQuery: string) => { update({ searchQuery }); }, [update]);
    const homeProfile = React.useMemo(() => getServerProfileById(props.address.serverId), [props.address.serverId]);
    const homeLabel = useHomeDisplayLabel(homeProfile);
    const client = React.useMemo(() => createDiscussionClient({ scope: props.scope, availability: 'available' }), [props.scope]);
    const repository = React.useMemo(() => getDiscussionRepository({
        scope: props.scope,
        address: props.address,
        client,
        accountLifetime: props.accountLifetime,
    }), [client, props.accountLifetime, props.address, props.scope]);
    useDiscussionRepositorySnapshot(repository);
    const anchorSessionId = props.anchor?.sessionId;
    const collection = repository.getListSnapshot(anchorSessionId);
    const refreshList = React.useCallback((state: 'active' | 'archived') => anchorSessionId
        ? repository.refreshAnchoredList(anchorSessionId, state)
        : repository.refreshList(state), [anchorSessionId, repository]);
    const loadMoreList = React.useCallback((state: 'active' | 'archived') => anchorSessionId
        ? repository.loadMoreAnchoredList(anchorSessionId, state)
        : repository.loadMoreList(state), [anchorSessionId, repository]);
    const { openDiscussion, openNewDiscussion, activeDiscussionKey } = useOpenDiscussion({ address: props.address, anchor: props.anchor, sourceSurface: props.anchor ? 'collaboration' : 'discussions' });
    const [archivedExpanded, setArchivedExpanded] = React.useState(false);
    // The column's search (R6): what this device already opened for each Discussion (its title, the people
    // in it, its source), across the whole list; the list pages to its end while a query is typed.
    const searching = column && query.trim().length > 0;
    const searched = useDiscussionListSearch({ repository, scope: props.scope, accountLifetime: props.accountLifetime,
        query, state: filters.state, ...(anchorSessionId ? { anchorSessionId } : {}) });
    const active = React.useMemo(() => ({ ...collection.lists.active, items: selectDiscussionSummariesForAnchor(collection.lists.active.items, props.anchor) }), [props.anchor, collection.lists.active]);
    const archived = React.useMemo(() => ({ ...collection.lists.archived, items: selectDiscussionSummariesForAnchor(collection.lists.archived.items, props.anchor) }), [props.anchor, collection.lists.archived]);
    const viewerAccountId = props.scope.accountId;
    // The scoped join supplies C1 request types independently of mention news.
    const source = filters.state === 'archived' ? archived : active;
    const activeRows = useDiscussionListRows(props.scope, searching ? searched.items : source.items);
    // A draft or request names who is waiting, through the same title projection a thread names its Sessions by;
    // one key-scoped projection for the whole list, never a read per row.
    const waitingAddresses = React.useMemo(() => [...new Set(activeRows.flatMap(row => row.waitingSessionId ? [row.waitingSessionId] : []))]
        .map(sessionId => ({ serverId: props.scope.serverId, sessionId })), [activeRows, props.scope.serverId]);
    const waitingNames = useSessionDisplayNameProjections(waitingAddresses, discussionWaitingSessionName);
    const attention = React.useMemo(() => {
        const names = new Map(waitingAddresses.map((address, index) => [address.sessionId, waitingNames[index] ?? null] as const));
        return new Map(activeRows.map(row => [row.id, { ...row, agentName: row.waitingSessionId ? names.get(row.waitingSessionId) ?? null : null }] as const));
    }, [activeRows, waitingAddresses, waitingNames]);
    const match = React.useMemo(() => compileDiscussionListFilterV1(filters), [filters]);
    const projection = React.useMemo(() => {
        const items: DiscussionOpenedSummaryV1[] = [];
        const keys = new Set<string>();
        let unavailable = !view.spacesReady || !view.bound;
        for (const row of !column || view.bound ? activeRows : []) {
            const result = column ? match(discussionListFilterFacts(row, row)) : 'match';
            if (result === 'match' && !keys.has(row.id)) { keys.add(row.id); items.push(row); }
            else if (result === 'unavailable') unavailable = true;
        }
        const readable = searching ? searched.status === 'ready' : source.status === 'ready';
        const complete = readable && (searching ? !searched.incomplete : source.nextCursor === null);
        const coverage = unavailable || !readable && items.length === 0 ? items.length ? 'partial' : 'unavailable'
            : complete ? 'complete' : 'partial';
        const filterResult: EntityListFilterResultV1 = { matchedCount: keys.size, coverage };
        return { items, filterResult };
    }, [activeRows, column, match, searched.incomplete, searched.status, searching, source.nextCursor, source.status, view.bound, view.spacesReady]);
    const actionOwner = React.useRef({ lifetime: props.accountLifetime, focused, filters, searchQuery: query,
        selectedSpaceId: view.selectedSpaceId, coverage: projection.filterResult.coverage, update, reset: view.reset });
    React.useLayoutEffect(() => { actionOwner.current = { lifetime: props.accountLifetime, focused, filters, searchQuery: query,
        selectedSpaceId: view.selectedSpaceId, coverage: projection.filterResult.coverage, update, reset: view.reset }; });
    React.useEffect(() => column && !anchorSessionId && focused && props.accountLifetime.isCurrent()
        ? registerDiscussionListScopeActionOwner(() => actionOwner.current) : undefined, [anchorSessionId, column, focused, props.accountLifetime]);

    const conditionBindings = React.useMemo(buildDiscussionConditionBindings, []);
    const readHeldFacts = React.useCallback(function* () {
        const seen = new Set<string>();
        for (const row of [...active.items, ...archived.items]) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            yield discussionListFilterFacts(row, attention.get(row.id));
        }
    }, [active.items, archived.items, attention]);
    const setFilters = React.useCallback((next: DiscussionListFilterV1) => update({ filters: next }), [update]);
    const spaceHeader = useCollectionSpaceHeader({
        entityKind: 'discussion',
        keyboardEnabled: column && !anchorSessionId && focused && focusEligible,
        testIDPrefix: 'discussions-column-space',
        defaultName: t('sessionsList.spacesAllDiscussions'),
        view: { spaces: view.spaces, selectedSpaceId: view.selectedSpaceId, selectedSpace: view.selectedSpace,
            activeSpace: view.activeSpace, spacesEnabled: view.spacesEnabled,
            spacesReady: view.spacesReady, spaceSettingsScope: view.spaceSettingsScope, filters, setFilters },
        registry: discussionListFilterFieldsV1,
        bindings: conditionBindings,
        ...(column && view.bound && view.spacesReady ? { readHeldFacts } : {}),
        result: projection.filterResult,
        defaultIcon: DISCUSSION_SPACE_ICON,
    });

    React.useEffect(() => {
        const unmount = repository.mount(anchorSessionId ? { anchorSessionId } : undefined);
        if (repository.getListSnapshot(anchorSessionId).lists.active.status === 'idle') void refreshList('active');
        return unmount;
    }, [anchorSessionId, refreshList, repository]);

    React.useEffect(() => {
        if ((archivedExpanded || filters.state === 'archived') && repository.getListSnapshot(anchorSessionId).lists.archived.status === 'idle') {
            void refreshList('archived');
        }
    }, [anchorSessionId, archivedExpanded, filters.state, refreshList, repository]);

    const toggleArchived = React.useCallback(() => {
        setArchivedExpanded((current) => !current);
    }, []);
    const retryActive = React.useCallback(() => { void refreshList('active'); }, [refreshList]);

    const items = React.useMemo<readonly DiscussionListItem[]>(() => {
        const humanListPending = active.status === 'idle' || (active.status === 'loading' && active.items.length === 0);
        if (searching) {
            // Matches keep the column's grouping and the chosen filter; a whole-list answer still on its way
            // says so under the matches rather than claiming there are no more.
            const kept = projection.items;
            const rows: DiscussionListItem[] = kept.length === 0 ? []
                : filters.state === 'archived'
                    ? kept.map((discussion) => ({ kind: 'archived_discussion' as const, discussion }))
                    : [...buildDiscussionColumnItems({ discussions: kept, humanListPending: false, now: new Date(), attention })];
            if (searched.incomplete && !isUnreadable(searched.status)) rows.push({ kind: 'search_more' });
            else if (kept.length === 0) rows.push({ kind: 'search_empty' });
            return rows;
        }
        if (column && filters.state === 'archived') {
            if (archived.status === 'loading' && archived.items.length === 0) return [{ kind: 'archived_loading' }];
            if (isUnreadable(archived.status) && archived.items.length === 0) return [{ kind: 'archived_error' }];
            if (projection.items.length === 0) return [{ kind: archived.items.length > 0 ? 'filter_empty' : 'archived_empty' }];
            return [...projection.items.map((discussion) => ({ kind: 'archived_discussion' as const, discussion })),
                ...(archived.nextCursor ? [{ kind: 'archived_load_more' as const }] : [])];
        }
        if (column && (filters.attention !== 'any' || filters.unreadOnly || filters.extensions || !view.bound)) {
            // Filtering narrows the loaded rows; reaching the end keeps loading pages until the list is whole.
            const kept = projection.items;
            if (kept.length === 0 && !humanListPending) return [{ kind: 'filter_empty' }];
            return [...buildDiscussionColumnItems({ discussions: kept, humanListPending, now: new Date(), attention })];
        }
        const primary: DiscussionListItem[] = column
            ? [...buildDiscussionColumnItems({ discussions: projection.items, humanListPending, now: new Date(), attention })]
            : [...buildDiscussionActivityItems({ discussions: active.items, humanListPending })];
        // The disclosure is a claim that there is something archived to open.
        // Only a proven-empty answer withdraws it; `unknown` keeps offering it,
        // because refusing to show it on an unanswered read would state an
        // emptiness this surface does not know.
        if (!archivedExpanded) {
            return collection.archivedExistence === 'empty'
                ? primary
                : [...primary, { kind: 'archived_disclosure' }];
        }
        const archivedItems: DiscussionListItem[] = [{ kind: 'archived_disclosure' }];
        if (archived.status === 'loading' && archived.items.length === 0) archivedItems.push({ kind: 'archived_loading' });
        else if (isUnreadable(archived.status) && archived.items.length === 0) archivedItems.push({ kind: 'archived_error' });
        else if (archived.items.length === 0) archivedItems.push({ kind: 'archived_empty' });
        else {
            archivedItems.push(...archived.items.map((discussion) => ({ kind: 'archived_discussion' as const, discussion })));
            if (archived.nextCursor) archivedItems.push({ kind: 'archived_load_more' });
        }
        return [...primary, ...archivedItems];
    }, [active.items, active.status, archived.items, archived.nextCursor, archived.status, archivedExpanded, attention, collection.archivedExistence,
        column, filters, projection.items, searched, searching, view.bound]);

    const activeCount = active.nextCursor === null && active.items.length > 0 ? active.items.length : undefined;
    const renderItem = React.useCallback(({ item }: Readonly<{ item: DiscussionListItem }>) => {
        switch (item.kind) {
            case 'human_section':
                return (
                    <PaneSectionHeader testID="session-human-conversations-section" title={t('session.collaboration.conversations')}
                        count={activeCount} action={<>
                        {active.status === 'loading' && active.items.length > 0 ? <ActivitySpinner size="small" /> : null}
                        <IconButton
                                testID="session-discussion-new"
                                iconName="plus"
                                size={28}
                                iconSize={15}
                                variant="plain"
                                accessibilityLabel={t('session.collaboration.discussion.newDiscussion')}
                                tooltip={t('session.collaboration.discussion.newDiscussion')}
                                onPress={openNewDiscussion}
                        />
                    </>} />
                );
            case 'recency_group':
                return <CollectionListGroupLabel testID={`discussions-column-group-${item.group}`} title={recencyGroupTitle(item.group)} />;
            case 'human_discussion':
                return (
                    <DiscussionRow
                        discussion={item.discussion}
                        viewerAccountId={viewerAccountId}
                        geometry={column ? 'column' : 'pane'}
                        serverId={props.address.serverId}
                        approvalArtifactId={attention.get(item.discussion.id)?.approvalArtifactIds[0]}
                        statusWords={statusWords}
                        presented={presented}
                        workStatus={resolveWorkStatusTone({ kind: 'discussion', facts: attention.get(item.discussion.id)
                            ?? { attentionReason: null, attentionType: null } })}
                        selected={activeDiscussionKey === item.discussion.id}
                        onPress={() => openDiscussion(item.discussion.id, item.discussion.title)}
                    />
                );
            case 'human_pending':
                return (
                    <View testID="session-conversations-loading" accessibilityRole="progressbar" accessibilityLabel={t('session.collaboration.discussion.loading')}>
                        {SKELETON_ROWS.map((index) => <DiscussionRowSkeleton key={index} index={index} />)}
                    </View>
                );
            case 'human_empty':
                if (isUnreadable(active.status)) {
                    return (
                        <View style={styles.stateLine}>
                            <SurfaceStateCard
                                testID="session-conversations-error"
                                size="line"
                                kind="error"
                                title={readFailureLine(active.status, active.errorCode)}
                                action={{ label: t('session.collaboration.discussion.retry'), onPress: retryActive }}
                            />
                        </View>
                    );
                }
                if (column) {
                    // Beside the main page the invitation is the page's (lab T2-E); the column only says
                    // what will appear here. As the destination's first screen it invites itself.
                    return props.surface === 'plane' ? (
                        <EmptyState testID="discussions-column-empty" layout="line" title={t('session.collaboration.discussion.home.columnEmpty')} />
                    ) : (
                        <View style={styles.invite}>
                            <EmptyState
                                testID="discussions-column-invite"
                                layout="centered"
                                title={t('session.collaboration.discussion.home.inviteTitle')}
                                subtitle={t('session.collaboration.discussion.home.inviteBody')}
                                primaryAction={{ label: t('session.collaboration.discussion.newDiscussion'), onPress: openNewDiscussion }}
                            />
                        </View>
                    );
                }
                return (
                    <View style={styles.paneInvite}>
                        <SurfaceStateCard
                            testID="session-conversations-empty"
                            kind="empty"
                            iconName="chat-circle"
                            title={t('session.collaboration.pane.inviteTitle')}
                            reason={t('session.collaboration.pane.inviteBody')}
                            action={{ label: t('session.collaboration.discussion.newDiscussion'), onPress: openNewDiscussion }}
                        />
                    </View>
                );
            case 'archived_disclosure':
                return (
                    <Pressable
                        testID="session-discussion-archived-disclosure"
                        accessibilityRole="button"
                        accessibilityState={{ expanded: archivedExpanded }}
                        accessibilityLabel={t('session.collaboration.discussion.archivedDisclosure')}
                        onPress={toggleArchived}
                        style={({ pressed }) => [styles.archivedDisclosure, pressed ? { opacity: motionTokens.press.opacity } : null]}
                    >
                        <Icon name={archivedExpanded ? 'caret-down' : 'caret-right'} size={13} color={theme.colors.text.tertiary} />
                        <Text style={styles.archivedLabel}>{t('session.collaboration.discussion.archived')}</Text>
                    </Pressable>
                );
            case 'archived_discussion':
                return <DiscussionRow discussion={item.discussion} viewerAccountId={viewerAccountId} geometry={column ? 'column' : 'pane'}
                    serverId={props.address.serverId} approvalArtifactId={attention.get(item.discussion.id)?.approvalArtifactIds[0]}
                    statusWords={statusWords} presented={presented} workStatus={resolveWorkStatusTone({ kind: 'discussion', facts: attention.get(item.discussion.id)
                    ?? { attentionReason: null, attentionType: null } })} selected={activeDiscussionKey === item.discussion.id} onPress={() => openDiscussion(item.discussion.id, item.discussion.title)} />;
            case 'archived_loading':
                return <View style={styles.center}><ActivitySpinner size="small" /></View>;
            case 'search_more':
                return <View style={styles.center}><ActivitySpinner size="small" accessibilityLabel={t('session.collaboration.discussion.loading')} /></View>;
            // A narrowed column says so on the column's own quiet line, at the rows' text edge.
            case 'search_empty':
                return <EmptyState testID="discussions-column-search-empty" layout="line" title={t('common.noMatches')} />;
            case 'filter_empty':
                return <EmptyState testID="discussions-column-filter-empty" layout="line" title={t('session.collaboration.discussion.home.filterEmpty')} />;
            case 'archived_empty':
                return (
                    <View style={styles.stateLine}>
                        <SurfaceStateCard size="line" kind="empty" title={t('session.collaboration.discussion.emptyArchived')} />
                    </View>
                );
            case 'archived_error':
                return (
                    <View style={styles.stateLine}>
                        <SurfaceStateCard
                            testID="session-conversations-archived-error"
                            size="line"
                            kind="error"
                            title={readFailureLine(archived.status, archived.errorCode)}
                            action={{ label: t('session.collaboration.discussion.retry'), onPress: () => { void refreshList('archived'); } }}
                        />
                    </View>
                );
            case 'archived_load_more':
                return <Pressable testID="session-discussion-archived-load-more" style={styles.more} accessibilityRole="button" onPress={() => void loadMoreList('archived')}><Text style={styles.moreText}>{t('session.collaboration.discussion.loadMore')}</Text></Pressable>;
        }
    }, [active.errorCode, active.items.length, active.status, activeCount, activeDiscussionKey, archived.errorCode, attention, archived.status, archivedExpanded, column, loadMoreList, openDiscussion, openNewDiscussion, presented, props.address.serverId, props.surface, refreshList, retryActive, statusWords, theme.colors.text.tertiary, toggleArchived, viewerAccountId]);

    // Nothing retained and nothing readable: the whole list is one pane state.
    if (!column && active.items.length === 0 && active.status === 'locked') {
        return (
            <DiscussionsListPaneState footer={props.footer}><SurfaceStateCard
                testID="session-conversations-locked"
                kind="error"
                iconName="lock"
                title={t('session.collaboration.pane.lockedTitle')}
                reason={active.errorCode === 'discussion_encryption_mode_mismatch'
                    ? t('session.collaboration.pane.lockedBody')
                    : undefined}
                diagnosticCode={active.errorCode}
                action={{ label: t('session.collaboration.discussion.retry'), onPress: retryActive }}
                accessibilitySemantics="status"
            /></DiscussionsListPaneState>
        );
    }
    if (!column && active.status === 'revoked') {
        return (
            <DiscussionsListPaneState footer={props.footer}><SurfaceStateCard
                testID="session-conversations-revoked"
                kind="denied"
                title={t('session.collaboration.pane.revokedTitle')}
                reason={t('session.collaboration.pane.revokedBody')}
                accessibilitySemantics="status"
            /></DiscussionsListPaneState>
        );
    }
    if (column) {
        const searchable = query.length > 0 || active.nextCursor !== null || active.items.length > COLLECTION_LIST_SEARCH_THRESHOLD;
        const narrowedCount = projection.filterResult.coverage === 'complete' ? projection.filterResult.matchedCount : null;
        const whole = active.items.length === 0 && active.status === 'locked'
            ? <SurfaceStateCard testID="session-conversations-locked" size="line" kind="error" iconName="lock" title={t('session.collaboration.pane.lockedTitle')} action={{ label: t('session.collaboration.discussion.retry'), onPress: retryActive }} />
            : active.status === 'revoked'
                ? <SurfaceStateCard testID="session-conversations-revoked" size="line" kind="denied" title={t('session.collaboration.pane.revokedTitle')} />
                : null;
        const stale = active.items.length > 0 && isUnreadable(active.status);
        return (
            <CollectionList
                testID="discussions-column"
                surface={props.surface}
                title={t('session.collaboration.discussion.title')}
                // The title names the space and opens its menu (R9, the Sessions title chevron).
                titleControl={spaceHeader.titleControl}
                strip={<>{spaceHeader.strip}{spaceHeader.overlays}</>}
                // A narrowed column counts what it shows, once that answer is whole.
                count={searching || filter !== 'all' ? narrowedCount : activeCount ?? null}
                search={searchable ? {
                    testID: 'discussions-column-search',
                    collapsible: true,
                    value: query,
                    onChangeText: setQuery,
                    placeholder: t('session.collaboration.discussion.home.search'),
                } : null}
                // Whose Discussions these are, and who reads them (lab T2-A).
                subtitle={{
                    testID: 'discussions-column-home',
                    text: `${homeLabel} · ${t('session.collaboration.discussion.home.audience')}`,
                    leading: <Icon name="house" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />,
                }}
                headerAction={<View style={styles.headerActions}>
                    {/* The space's conditions, the same editor as Sessions (R9). */}
                    {spaceHeader.filterButton}
                    <IconButton
                        testID="session-discussion-new"
                        iconName="plus"
                        variant="plain"
                        accessibilityLabel={t('session.collaboration.discussion.newDiscussion')}
                        tooltip={t('session.collaboration.discussion.newDiscussion')}
                        onPress={openNewDiscussion}
                    />
                </View>}
                scrollContent={whole ? <View style={collectionListStyles.stateLine}>{whole}</View> : (
                    <View style={styles.root} testID="session-discussion-activity-list">
                        {stale ? (
                            <View style={collectionListStyles.stateLine}>
                                <SurfaceFreshnessLine
                                    testID="session-conversations-freshness"
                                    reason={active.status === 'offline' ? t('session.collaboration.pane.offline') : readFailureLine(active.status, active.errorCode)}
                                    tone={active.status === 'offline' ? 'neutral' : 'warning'}
                                    action={{ label: t('session.collaboration.discussion.retry'), onPress: retryActive }}
                                />
                            </View>
                        ) : null}
                        <FlatList
                            style={styles.list}
                            contentContainerStyle={styles.listContent}
                            accessibilityRole="list"
                            accessibilityLabel={t('session.collaboration.discussion.title')}
                            data={items}
                            keyExtractor={discussionListItemKey}
                            renderItem={renderItem}
                            onEndReachedThreshold={0.35}
                            onEndReached={() => { if (source.nextCursor && source.status !== 'loading') void loadMoreList(filters.state); }}
                        />
                    </View>
                )}
            />
        );
    }
    const staleReason = active.items.length > 0 && isUnreadable(active.status)
        ? active.status === 'offline' ? t('session.collaboration.pane.offline') : readFailureLine(active.status, active.errorCode)
        : null;
    return (
        <View style={styles.root} testID="session-discussion-activity-list">
            {staleReason ? (
                <View style={styles.freshness}>
                    <SurfaceFreshnessLine
                        testID="session-conversations-freshness"
                        reason={staleReason}
                        tone={active.status === 'offline' ? 'neutral' : 'warning'}
                        action={{ label: t('session.collaboration.discussion.retry'), onPress: retryActive }}
                    />
                </View>
            ) : null}
            <FlatList
                style={styles.list}
                contentContainerStyle={props.footer ? styles.listContentFlow : styles.listContent}
                accessibilityRole="list"
                accessibilityLabel={t('session.collaboration.conversations')}
                data={items}
                keyExtractor={discussionListItemKey}
                renderItem={renderItem}
                onEndReachedThreshold={0.35}
                onEndReached={() => { if (active.nextCursor && active.status !== 'loading') void loadMoreList('active'); }}
                ListFooterComponent={props.footer}
            />
        </View>
    );
}

const paneStateStyles = StyleSheet.create({
    scroll: { flex: 1, minHeight: 0 },
});
