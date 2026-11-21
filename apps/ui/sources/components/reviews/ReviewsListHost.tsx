import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HostCollection as Collection, useHappierCollection, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import type { HappierCollectionGrouping, HappierCollectionWindow } from '@happier-dev/plugin-ui/presentation';
import type { ReviewListItemV1, ReviewListResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { useIsFocused, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { artifactViewRoute } from '@/components/artifacts/artifactBrowserModel';
import { useOptionalUniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { CollectionSearchToggle } from '@/components/ui/lists/collection/CollectionList';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useActiveServerAccountScope, useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { useProjectSourceNames } from '@/components/projects/sources/useProjectSources';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { alertActionFailure, readSafeFailureDetails } from '@/utils/errors/alertActionFailure';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';
import { reviewStateLabel } from './list/reviewStateLabel';
import {
    reviewSpaceTakesMembers,
    reviewSubjectLabel,
    useReviewSpaceMembership,
    useReviewsCollectionView,
    useReviewsSpaceHeader,
    type ReviewsCollectionView,
} from './list/useReviewsCollectionView';

const keyOf = (item: ReviewListItemV1) => item.reviewId;
const reviewCountsLabel = (item: ReviewListItemV1) => [
    t('reviewWalkthrough.detail.findingsCount', { count: item.counts.total }),
    t('reviewWalkthrough.detail.glanceToDecide', { count: item.counts.needsDecision }),
].join(' · ');
const passThrough = (children: React.ReactNode) => children;
type ReviewRow = ReviewListResponseV1['items'][number];
const EMPTY_ITEMS: readonly ReviewRow[] = Object.freeze([]);

/**
 * The Reviews collection (plan 04 U3, lab list-strip / list-search / list-drag): the page's one toolbar owns the
 * saved views. The title chevron is the view menu, the strip holds the spaces and + New space, a dragged Review joins
 * a space by dropping on its tab, and search waits behind its icon. Rows open their Review.
 */
export function ReviewsListHost({ surface = 'home' }: Readonly<{ surface?: 'home' | 'column' | 'hub' }> = {}): React.ReactElement {
    const focused = useIsFocused();
    const presented = useLayoutPresentationActive();
    const { columnVisible } = useAppShellColumn();
    const overview = surface === 'hub' || surface === 'home' && columnVisible;
    const view = useReviewsCollectionView(focused, surface === 'home');
    const { list } = view;
    const router = useRouter();
    // The shared Start command opens Review authoring, including its subject and placement choices.
    const universalSearch = useOptionalUniversalSearchRuntime();
    const startReview = React.useCallback(() => universalSearch?.open(t('commandPalette.commands.startReviewRunTitle')), [universalSearch]);
    const reviewLabel = t('detailsSurface.review.title');
    const moreLabel = t('common.more');
    const searching = view.searchQuery.trim().length > 0;
    const window = React.useMemo((): HappierCollectionWindow => list.cursor ? {
        kind: 'partial', continuations: [{ key: 'more', label: moreLabel,
            load: list.loadMore, busy: list.status === 'loading_more' }],
    } : { kind: 'complete' }, [list.cursor, list.loadMore, list.status, moreLabel]);
    const open = React.useCallback((key: string | null) => {
        if (key !== null) router.push(artifactViewRoute(key) as never);
    }, [router]);
    const loaded = view.items ?? EMPTY_ITEMS;
    // P02's per-person result owns attention; aggregate pending counts do not say who must decide.
    const items = React.useMemo(() => overview
        ? loaded.filter(item => item.needsYou.needsYou || item.state === 'running') : loaded, [loaded, overview]);
    const projectIds = React.useMemo(() => [...new Set(list.items?.map(item => item.projectSourceId) ?? [])], [list.items]);
    const sourceIds = React.useMemo(() => projectIds.filter((id): id is string => id !== null), [projectIds]);
    const lifetime = useActiveServerAccountScopeLifetime();
    const names = useProjectSourceNames(lifetime, sourceIds, !overview && projectIds.length > 1 && focused && presented);
    const sourceNames = React.useMemo(() => new Map(sourceIds.map((id, index) => [id, names[index]])), [names, sourceIds]);
    const groups = React.useMemo((): HappierCollectionGrouping<ReviewRow> | undefined => overview ? {
        axis: [{ key: 'needs-you', title: t('reviewWalkthrough.collection.needsYourDecision') },
            { key: 'running', title: t('reviewWalkthrough.collection.stateRunning') }],
        groupOf: item => item.needsYou.needsYou ? 'needs-you' : 'running',
    } : projectIds.length > 1 ? {
        axis: projectIds.map(id => ({ key: id ?? '', title: id === null ? t('reviewWalkthrough.collection.noProject')
            : sourceNames.get(id) ?? t('projects.title') })),
        groupOf: item => item.projectSourceId ?? '',
    } : undefined, [overview, projectIds, sourceNames]);
    const model = useHappierCollection<ReviewRow>({
        items, keyOf, groups, window, openKey: null, onOpenChange: open,
    });
    const scope = useActiveServerAccountScope();
    // The Artifact owner opens sealed headers; the collection only presents those exact titles.
    const anatomy = React.useMemo((): CollectionAnatomy<ReviewRow> => ({
        wrapItem: (item, children) => <WorkspaceDestinationRow href={artifactViewRoute(item.reviewId)} existingMenu
            entityTitle={view.titles.get(item.reviewId) || reviewLabel} entityItem={scope ? { kind: 'artifact', scope, artifactId: item.reviewId } : null}>
            {children}
        </WorkspaceDestinationRow>,
        glyph: () => null, loadingGlyph: false, title: item => view.titles.get(item.reviewId) || reviewLabel,
        columnTitles: { title: reviewLabel },
        accessibilityLabel: item => `${view.titles.get(item.reviewId) || reviewLabel} · ${reviewCountsLabel(item)} · ${formatRelativeTimeShort(item.createdAt, Date.now())}`,
        titleMeta: reviewCountsLabel,
        byline: item => [reviewSubjectLabel(item.subjectKind), reviewStateLabel(item.state),
            formatRelativeTimeShort(item.createdAt, Date.now())].join(' · '),
        action: item => <ReviewRowSpaceMenu item={item} view={view} />,
        testID: item => `${surface === 'hub' ? 'reviews:home:row' : surface === 'column' ? 'reviews:column:row' : 'reviews:row'}:${item.reviewId}`,
    }), [reviewLabel, scope, surface, view]);
    const failure = list.error ? <SurfaceStateCard kind="error" title={t('common.error')}
        diagnosticCode={list.error.code ?? undefined} action={{ label: t('common.retry'), onPress: list.refresh }}
        {...(list.items?.length ? { size: 'line' as const } : { replacesContent: true })} /> : null;
    const collection = <Collection model={model} anatomy={anatomy} presentation="list" detail="none"
        accessibilityLabel={t('homeSettings.groups.reviews')}
        scroll={surface === 'column' ? 'collection' : 'page-virtualized'} minListWidth={0} minDetailWidth={0} preferredListRatio={1}
        loading={list.items === null && list.error === null} testID={surface === 'hub' ? 'reviews:home' : surface === 'column' ? 'reviews:column' : 'reviews:list'}
        empty={failure ?? (searching ? <SurfaceStateCard kind="empty" title={t('ui.pluginUi.empty')} replacesContent />
            : overview && list.items?.length ? <SurfaceStateCard kind="empty"
                title={t('reviewWalkthrough.collection.caughtUp')} replacesContent />
            : <SurfaceStateCard testID="reviews:empty" kind="empty" title={t('reviewWalkthrough.detail.emptyTitle')}
                reason={t('reviewWalkthrough.detail.emptyReason')} replacesContent
                action={universalSearch ? { testID: 'reviews:empty:start', label: t('reviewWalkthrough.detail.startReview'),
                    onPress: startReview } : undefined} />)} />;
    if (surface !== 'home') return <CoreCollectionScope>
        {list.items?.length ? failure : null}{collection}
    </CoreCollectionScope>;
    return <ReviewsCollectionPage view={view} failure={failure}
        startReview={universalSearch && list.items?.length ? startReview : undefined}>{collection}</ReviewsCollectionPage>;
}

/** Only the home owns the saved-view toolbar; its draft also narrows the adjacent column. */
function ReviewsCollectionPage({ view, failure, children, startReview }: Readonly<{
    view: ReviewsCollectionView; failure: React.ReactNode; children: React.ReactNode; startReview?: () => void;
}>): React.ReactElement {
    const header = useReviewsSpaceHeader(view, 'reviews-space');
    const [searchOpen, setSearchOpen] = React.useState(false);
    const searching = searchOpen || view.searchQuery.length > 0;
    const closeSearch = React.useCallback(() => { setSearchOpen(false); view.setSearchQuery(''); }, [view]);
    return <ItemList pageColumn="wide"><CoreCollectionScope renderPageScroller={passThrough}>
        <PageContentColumn>
            <PageHeader title={t('homeSettings.groups.reviews')}
                primaryAction={startReview ? { title: t('reviewWalkthrough.detail.startReview'),
                    onPress: startReview, testID: 'reviews:start' } : undefined} />
            <View testID="reviews:scope-line" style={styles.controlLine}>
                {header.titleControl}
                <View style={styles.strip}>{header.strip}</View>
                {header.filterButton}
                <CollectionSearchToggle testID="reviews:search-toggle" accessibilityLabel={t('reviewWalkthrough.collection.search')}
                    open={searching} onPress={() => (searching ? closeSearch() : setSearchOpen(true))} />
            </View>
            {searching ? <View style={styles.searchLine}>
                <CompactSearchField testID="reviews:search" accessibilityLabel={t('reviewWalkthrough.collection.search')}
                    placeholder={t('reviewWalkthrough.collection.search')} value={view.searchQuery}
                    onChangeText={view.setSearchQuery} autoFocus
                    onKeyPress={event => { if (event.nativeEvent.key === 'Escape') closeSearch(); }} />
                {view.searchQuery.trim() ? <Text testID="reviews:search-scope" style={styles.searchScope}>
                    {t('reviewWalkthrough.collection.filteredWithinLoaded')}</Text> : null}
            </View> : null}
            {header.conditionRow}
            {header.overlays}
            {view.list.items?.length ? failure : null}
            {children}
        </PageContentColumn>
    </CoreCollectionScope></ItemList>;
}

/** A row's spaces in its "…" (the touch and keyboard way to do what dragging onto a tab does). */
const ReviewRowSpaceMenu = React.memo(function ReviewRowSpaceMenu(props: Readonly<{ item: ReviewListItemV1; view: ReviewsCollectionView }>) {
    const { item, view } = props;
    const setMembership = useReviewSpaceMembership();
    const [open, setOpen] = React.useState(false);
    const anchor = React.useRef<View | null>(null);
    const items = React.useMemo((): readonly DropdownMenuItem[] => [
        ...view.spaces.filter(space => reviewSpaceTakesMembers(space) && space.id !== view.activeSpace?.id).map(space => ({
            id: `add:${space.id}`, testID: `reviews:row:${item.reviewId}:add:${space.id}`,
            title: t('reviewWalkthrough.collection.addToSpace', { space: space.name }),
        })),
        ...(reviewSpaceTakesMembers(view.activeSpace) ? [{ id: `remove:${view.activeSpace.id}`,
            testID: `reviews:row:${item.reviewId}:remove`, title: t('reviewWalkthrough.collection.removeFromSpace') }] : []),
    ], [item.reviewId, view.activeSpace, view.spaces]);
    const select = React.useCallback((id: string) => {
        setOpen(false);
        const [operation, spaceId] = id.split(/:(.*)/s) as ['add' | 'remove', string];
        void setMembership({ resourceKind: 'artifact', resourceId: item.reviewId, operation, spaceId })
            .then(result => {
                if (result.ok) return;
                const presentation = presentActionExecutionFailure(result);
                alertActionFailure({ reason: presentation.reason, code: result.errorCode,
                    requestId: result.requestId, context: readSafeFailureDetails(result.details) });
            });
    }, [item.reviewId, setMembership]);
    if (items.length === 0) return null;
    return <View ref={anchor} collapsable={false}>
        <IconButton testID={`reviews:row:${item.reviewId}:menu`} iconName="dots-three" variant="plain"
            accessibilityLabel={t('reviewWalkthrough.collection.rowOptions')} onPress={() => setOpen(value => !value)} />
        <DropdownMenu testID={`reviews:row:${item.reviewId}:menu:list`} open={open} onOpenChange={setOpen} items={items}
            onSelect={select} popoverAnchorRef={anchor} placement="bottom" popoverAnchorAlign="end" matchTriggerWidth={false} />
    </View>;
});

const styles = StyleSheet.create((theme) => ({
    // The saved view's menu, its spaces, then the filter and search (the Workflows home's control line).
    controlLine: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    strip: { flex: 1, minWidth: 0 },
    searchLine: { gap: theme.space.s4, paddingTop: theme.space.s8 },
    searchScope: { ...Typography.variant('meta'), color: theme.colors.text.tertiary },
}));
