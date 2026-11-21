import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HostCollection as Collection, Text as UiText, useHappierCollection, type CollectionAnatomy, type CollectionRowActions } from '@happier-dev/plugin-ui';
import { HAPPIER_PAGE_METRICS, type HappierCollectionGrouping, type HappierCollectionWindow, type HappierTone } from '@happier-dev/plugin-ui/presentation';
import type { ReviewListItemV1, ReviewListResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { useIsFocused, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { artifactViewRoute } from '@/components/artifacts/artifactBrowserModel';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { detachedReviewStartSeed } from '@/components/sessions/runs/launcher/prepareExecutionRunLauncherDraft';
import { useOpenExecutionRunLauncherDraft } from '@/components/sessions/runs/launcher/useOpenExecutionRunLauncherDraft';
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
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { useViewportClass } from '@/utils/platform/useViewportClass';
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
const passThrough = (children: React.ReactNode) => children;
type ReviewRow = ReviewListResponseV1['items'][number];
const EMPTY_ITEMS: readonly ReviewRow[] = Object.freeze([]);
/**
 * Home's Reviews section is a glance, not the collection: the first rows that wait on the person, then the whole
 * collection one press away (U8 G2). It matches the other short Home lists' preview length.
 */
const HOME_REVIEWS_PREVIEW_ROWS = 5;

/**
 * A row's one fact (lab list-home): what needs the person, else how the Review came out. A running or failed Review
 * says so in its state word, so it adds nothing here. Amber only when the person is needed.
 */
export function reviewRowFact(item: ReviewRow): Readonly<{ label: string; tone: HappierTone }> | null {
    if (item.counts.needsDecision > 0) {
        return { label: t('reviewWalkthrough.detail.glanceToDecide', { count: item.counts.needsDecision }), tone: 'attention' };
    }
    if (item.needsYou.requestedVerdict) return { label: t('reviewWalkthrough.detail.requestedFromYou'), tone: 'attention' };
    if (item.state !== 'completed' && item.state !== 'partial') return null;
    return { label: item.counts.total === 0 ? t('reviewWalkthrough.detail.glanceNoFindings')
        : t('reviewWalkthrough.detail.glanceAllDecided'), tone: 'secondary' };
}

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
    const scope = useActiveServerAccountScope();
    // Every "Start a review" opens the one Review start sheet with no Session (the palette's command opens the same).
    const openRunDraft = useOpenExecutionRunLauncherDraft();
    const startReview = React.useCallback(() => { if (scope) void openRunDraft(detachedReviewStartSeed(scope)); }, [openRunDraft, scope]);
    // A narrow row (the column, a phone) has one line under its name: the fact leads it, and the subject and state
    // say what it is only when nothing needs the person (lab list-home column and 390).
    const phone = useViewportClass() === 'compact';
    const narrowRows = surface === 'column' || phone;
    const reviewLabel = t('detailsSurface.review.title');
    const moreLabel = t('common.more');
    const searching = view.searchQuery.trim().length > 0;
    const loaded = view.items ?? EMPTY_ITEMS;
    // P02's per-person result owns attention; aggregate pending counts do not say who must decide. Needs you leads.
    const attention = React.useMemo(() => overview ? [
        ...loaded.filter(item => item.needsYou.needsYou),
        ...loaded.filter(item => !item.needsYou.needsYou && item.state === 'running'),
    ] : loaded, [loaded, overview]);
    const items = React.useMemo(() => surface === 'hub' ? attention.slice(0, HOME_REVIEWS_PREVIEW_ROWS) : attention, [attention, surface]);
    const openAll = React.useCallback(() => router.push('/reviews' as never), [router]);
    const window = React.useMemo((): HappierCollectionWindow => surface === 'hub'
        ? (attention.length > items.length || list.cursor ? { kind: 'partial', continuations: [{ key: 'all',
            label: t('reviewWalkthrough.collection.showAll', { count: attention.length }), load: openAll }] } : { kind: 'complete' })
        : list.cursor ? { kind: 'partial', continuations: [{ key: 'more', label: moreLabel,
            load: list.loadMore, busy: list.status === 'loading_more' }] } : { kind: 'complete' },
    [attention.length, items.length, list.cursor, list.loadMore, list.status, moreLabel, openAll, surface]);
    const open = React.useCallback((key: string | null) => {
        if (key !== null) router.push(artifactViewRoute(key) as never);
    }, [router]);
    const projectIds = React.useMemo(() => [...new Set(list.items?.map(item => item.projectSourceId) ?? [])], [list.items]);
    const sourceIds = React.useMemo(() => projectIds.filter((id): id is string => id !== null), [projectIds]);
    const lifetime = useActiveServerAccountScopeLifetime();
    const names = useProjectSourceNames(lifetime, sourceIds, !overview && projectIds.length > 1 && focused && presented);
    const sourceNames = React.useMemo(() => new Map(sourceIds.map((id, index) => [id, names[index]])), [names, sourceIds]);
    // Home's section is one short list under its own title; the page's overview bands it by what the person does next.
    const groups = React.useMemo((): HappierCollectionGrouping<ReviewRow> | undefined => surface === 'hub' ? undefined : overview ? {
        axis: [{ key: 'needs-you', title: t('reviewWalkthrough.collection.needsYourDecision') },
            { key: 'running', title: t('reviewWalkthrough.collection.stateRunning') }],
        groupOf: item => item.needsYou.needsYou ? 'needs-you' : 'running',
    } : projectIds.length > 1 ? {
        axis: projectIds.map(id => ({ key: id ?? '', title: id === null ? t('reviewWalkthrough.collection.noProject')
            : sourceNames.get(id) ?? t('projects.title') })),
        groupOf: item => item.projectSourceId ?? '',
    } : undefined, [overview, projectIds, sourceNames, surface]);
    const model = useHappierCollection<ReviewRow>({
        items, keyOf, groups, window, openKey: null, onOpenChange: open,
    });
    // The Artifact owner opens sealed headers; the collection only presents those exact titles.
    const anatomy = React.useMemo((): CollectionAnatomy<ReviewRow> => {
        const titleOf = (item: ReviewRow) => view.titles.get(item.reviewId) || reviewLabel;
        const ageOf = (item: ReviewRow) => formatShortRelativeTimeAt(item.createdAt, Date.now());
        const factOf = (item: ReviewRow) => {
            const fact = reviewRowFact(item);
            return fact ? <UiText variant="meta" tone={fact.tone} value={fact.label} numberOfLines={1} /> : null;
        };
        const bylineOf = (item: ReviewRow) => [reviewSubjectLabel(item.subjectKind), reviewStateLabel(item.state)].join(' · ');
        return {
            wrapItem: (item, children) => <WorkspaceDestinationRow href={artifactViewRoute(item.reviewId)} existingMenu
                entityTitle={titleOf(item)} entityItem={scope ? { kind: 'artifact', scope, artifactId: item.reviewId } : null}>
                {children}
            </WorkspaceDestinationRow>,
            glyph: () => null, loadingGlyph: false, title: titleOf,
            columnTitles: { title: reviewLabel },
            accessibilityLabel: item => [titleOf(item), reviewRowFact(item)?.label, bylineOf(item), ageOf(item)]
                .filter(Boolean).join(' · '),
            byline: item => narrowRows && reviewRowFact(item) ? null : bylineOf(item),
            ...(narrowRows ? { bylineLead: factOf } : { reason: factOf }),
            age: ageOf,
            testID: item => `${surface === 'hub' ? 'reviews:home:row' : surface === 'column' ? 'reviews:column:row' : 'reviews:row'}:${item.reviewId}`,
        };
    }, [narrowRows, reviewLabel, scope, surface, view]);
    const failure = list.error ? <SurfaceStateCard kind="error" title={t('common.error')}
        diagnosticCode={list.error.code ?? undefined} action={{ label: t('common.retry'), onPress: list.refresh }}
        {...(list.items?.length ? { size: 'line' as const } : { replacesContent: true })} /> : null;
    const collection = <ReviewRowActionsContext.Provider value={view}><Collection model={model} anatomy={anatomy} presentation="list" detail="none"
        accessibilityLabel={t('homeSettings.groups.reviews')} useRowActions={useReviewRowActions}
        scroll={surface === 'column' ? 'collection' : groups ? 'page-virtualized' : 'page'} minListWidth={0} minDetailWidth={0} preferredListRatio={1}
        loading={list.items === null && list.error === null} testID={surface === 'hub' ? 'reviews:home' : surface === 'column' ? 'reviews:column' : 'reviews:list'}
        empty={failure ?? (searching ? <SurfaceStateCard kind="empty" title={t('ui.pluginUi.empty')} replacesContent />
            : overview && list.items?.length ? <SurfaceStateCard kind="empty"
                title={t('reviewWalkthrough.collection.caughtUp')} replacesContent />
            : <SurfaceStateCard testID="reviews:empty" kind="empty" title={t('reviewWalkthrough.detail.emptyTitle')}
                reason={t('reviewWalkthrough.detail.emptyReason')} replacesContent
                action={scope ? { testID: 'reviews:empty:start', label: t('reviewWalkthrough.detail.startReview'),
                    onPress: startReview } : undefined} />)} /></ReviewRowActionsContext.Provider>;
    if (surface !== 'home') return <CoreCollectionScope>
        {list.items?.length ? failure : null}{collection}
    </CoreCollectionScope>;
    return <ReviewsCollectionPage view={view} failure={failure}
        startReview={scope && list.items?.length ? startReview : undefined}>{collection}</ReviewsCollectionPage>;
}

/**
 * Only the home owns the saved-view toolbar; its draft also narrows the adjacent column. A wide page leads with its
 * title and purpose; a phone recomposes (lab list-home-390): the saved view is the page title, with search and Start a
 * review beside it and the spaces on their own line, all on the page's text edge.
 */
function ReviewsCollectionPage({ view, failure, children, startReview }: Readonly<{
    view: ReviewsCollectionView; failure: React.ReactNode; children: React.ReactNode; startReview?: () => void;
}>): React.ReactElement {
    const phone = useViewportClass() === 'compact';
    const header = useReviewsSpaceHeader(view, 'reviews-space', phone ? 'page' : 'section');
    const [searchOpen, setSearchOpen] = React.useState(false);
    const searching = searchOpen || view.searchQuery.length > 0;
    const closeSearch = React.useCallback(() => { setSearchOpen(false); view.setSearchQuery(''); }, [view]);
    const searchToggle = <CollectionSearchToggle testID="reviews:search-toggle" accessibilityLabel={t('reviewWalkthrough.collection.search')}
        open={searching} onPress={() => (searching ? closeSearch() : setSearchOpen(true))} />;
    return <ItemList pageColumn="wide"><CoreCollectionScope renderPageScroller={passThrough}>
        <PageContentColumn>
            {phone ? null : <PageHeader title={t('homeSettings.groups.reviews')} description={t('reviewWalkthrough.collection.description')}
                primaryAction={startReview ? { title: t('reviewWalkthrough.detail.startReview'),
                    onPress: startReview, testID: 'reviews:start' } : undefined} />}
            <View testID="reviews:scope-line" style={[styles.controlLine, phone ? styles.controlLinePhone : null]}>
                {header.titleControl}
                {phone ? <View style={styles.grow} /> : <View style={styles.strip}>{header.strip}</View>}
                {header.filterButton}
                {searchToggle}
                {phone && startReview ? <IconButton testID="reviews:start" iconName="plus" variant="plain"
                    accessibilityLabel={t('reviewWalkthrough.detail.startReview')} onPress={startReview} /> : null}
            </View>
            {phone ? <View style={styles.stripLine}>{header.strip}</View> : null}
            {searching ? <View style={styles.searchLine}>
                <CompactSearchField testID="reviews:search" accessibilityLabel={t('reviewWalkthrough.collection.search')}
                    placeholder={t('reviewWalkthrough.collection.search')} value={view.searchQuery}
                    onChangeText={view.setSearchQuery} autoFocus
                    onKeyPress={event => { if (event.nativeEvent.key === 'Escape') closeSearch(); }} />
                {view.searchQuery.trim() ? <Text testID="reviews:search-scope" style={styles.searchScope}>
                    {t('reviewWalkthrough.collection.filteredWithinLoaded')}</Text> : null}
            </View> : null}
            {header.conditionRow ? <View style={styles.stripLine}>{header.conditionRow}</View> : null}
            {header.overlays}
            {view.list.items?.length ? failure : null}
            {children}
        </PageContentColumn>
    </CoreCollectionScope></ItemList>;
}

/** The mounted Reviews view, for each row's own menu (the Collection calls `useRowActions` per row). */
const ReviewRowActionsContext = React.createContext<ReviewsCollectionView | null>(null);

/**
 * A row's spaces in its "…" (the touch and keyboard way to do what dragging onto a tab does). The shared row overflow
 * shows it on hover and focus and keeps it on touch and in the row's context menu; a row at rest carries no "…".
 */
function useReviewRowActions(item: ReviewRow): CollectionRowActions {
    const view = React.useContext(ReviewRowActionsContext);
    const setMembership = useReviewSpaceMembership();
    const secondaryActions = React.useMemo(() => view === null ? [] : [
        ...view.spaces.filter(space => reviewSpaceTakesMembers(space) && space.id !== view.activeSpace?.id).map(space => ({
            id: `add:${space.id}`, label: t('reviewWalkthrough.collection.addToSpace', { space: space.name }),
        })),
        ...(reviewSpaceTakesMembers(view.activeSpace) ? [{ id: `remove:${view.activeSpace.id}`,
            label: t('reviewWalkthrough.collection.removeFromSpace') }] : []),
    ], [view]);
    const onSecondaryAction = React.useCallback((id: string) => {
        const [operation, spaceId] = id.split(/:(.*)/s) as ['add' | 'remove', string];
        void setMembership({ resourceKind: 'artifact', resourceId: item.reviewId, operation, spaceId })
            .then(result => {
                if (result.ok) return;
                const presentation = presentActionExecutionFailure(result);
                alertActionFailure({ reason: presentation.reason, code: result.errorCode,
                    requestId: result.requestId, context: readSafeFailureDetails(result.details) });
            });
    }, [item.reviewId, setMembership]);
    return React.useMemo((): CollectionRowActions => secondaryActions.length === 0 ? {} : {
        secondaryActions, onSecondaryAction, secondaryActionAccessibilityLabel: t('reviewWalkthrough.collection.rowOptions'),
    }, [onSecondaryAction, secondaryActions]);
}

const styles = StyleSheet.create((theme) => ({
    // The saved view's menu, its spaces, then the filter and search (the Workflows home's control line), on the
    // sheets' edge so the title, the strip, the search and the rows share one left edge.
    controlLine: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8,
        paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx },
    controlLinePhone: { paddingTop: theme.space.s8 },
    grow: { flex: 1 },
    strip: { flex: 1, minWidth: 0 },
    stripLine: { paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx, paddingTop: theme.space.s8 },
    searchLine: { gap: theme.space.s4, paddingTop: theme.space.s8, paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx },
    searchScope: { ...Typography.variant('meta'), color: theme.colors.text.tertiary },
}));
