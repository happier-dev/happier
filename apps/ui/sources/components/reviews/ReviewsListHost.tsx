import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HostCollection as Collection, useHappierCollection, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import type { HappierCollectionWindow } from '@happier-dev/plugin-ui/presentation';
import type { ReviewListItemV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { useIsFocused, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { artifactViewRoute } from '@/components/artifacts/artifactBrowserModel';
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
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';
import {
    reviewSpaceTakesMembers,
    reviewStateLabel,
    reviewSubjectLabel,
    useReviewSpaceMembership,
    useReviewsCollectionView,
    useReviewsSpaceHeader,
    type ReviewsCollectionView,
} from './list/useReviewsCollectionView';

const keyOf = (item: ReviewListItemV1) => item.reviewId;
const passThrough = (children: React.ReactNode) => children;
const EMPTY_ITEMS: readonly ReviewListItemV1[] = Object.freeze([]);

/**
 * The Reviews collection (plan 04 U3, lab list-strip / list-search / list-drag): the page's one toolbar owns the
 * saved views. The title chevron is the view menu, the strip holds the spaces and + New space, a dragged Review joins
 * a space by dropping on its tab, and search waits behind its icon. Rows open their Review.
 */
export function ReviewsListHost(): React.ReactElement {
    const focused = useIsFocused();
    const view = useReviewsCollectionView(focused);
    const header = useReviewsSpaceHeader(view, 'reviews-space');
    const { list } = view;
    const router = useRouter();
    const reviewLabel = t('detailsSurface.review.title');
    const moreLabel = t('common.more');
    const [searchOpen, setSearchOpen] = React.useState(false);
    const searching = searchOpen || view.searchQuery.length > 0;
    const closeSearch = React.useCallback(() => { setSearchOpen(false); view.setSearchQuery(''); }, [view]);
    const window = React.useMemo((): HappierCollectionWindow => list.cursor ? {
        kind: 'partial', continuations: [{ key: 'more', label: moreLabel,
            load: list.loadMore, busy: list.status === 'loading_more' }],
    } : { kind: 'complete' }, [list.cursor, list.loadMore, list.status, moreLabel]);
    const open = React.useCallback((key: string | null) => {
        if (key !== null) router.push(artifactViewRoute(key) as never);
    }, [router]);
    const model = useHappierCollection<ReviewListItemV1>({
        items: view.items ?? EMPTY_ITEMS, keyOf, window, openKey: null, onOpenChange: open,
    });
    const scope = useActiveServerAccountScope();
    // Titles are sealed in the Review body; a row names its subject and state from the metadata it carries.
    const anatomy = React.useMemo((): CollectionAnatomy<ReviewListItemV1> => ({
        wrapItem: (item, children) => <WorkspaceDestinationRow href={artifactViewRoute(item.reviewId)} existingMenu
            entityTitle={reviewLabel} entityItem={scope ? { kind: 'artifact', scope, artifactId: item.reviewId } : null}>
            {children}
        </WorkspaceDestinationRow>,
        glyph: () => null, loadingGlyph: false, title: () => reviewLabel,
        columnTitles: { title: reviewLabel },
        accessibilityLabel: item => `${reviewLabel} · ${formatRelativeTimeShort(item.createdAt, Date.now())}`,
        byline: item => [reviewSubjectLabel(item.subjectKind), reviewStateLabel(item.state),
            formatRelativeTimeShort(item.createdAt, Date.now())].join(' · '),
        action: item => <ReviewRowSpaceMenu item={item} view={view} />,
        testID: item => `reviews:row:${item.reviewId}`,
    }), [reviewLabel, scope, view]);
    const failure = list.error ? <SurfaceStateCard kind="error" title={t('common.error')}
        diagnosticCode={list.error.code ?? undefined} action={{ label: t('common.retry'), onPress: list.refresh }}
        {...(list.items?.length ? { size: 'line' as const } : { replacesContent: true })} /> : null;
    return <ItemList pageColumn="wide"><CoreCollectionScope renderPageScroller={passThrough}>
        <PageContentColumn>
            <PageHeader title={t('homeSettings.groups.reviews')} />
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
            {list.items?.length ? failure : null}
            <Collection model={model} anatomy={anatomy} presentation="list" detail="none"
                accessibilityLabel={t('homeSettings.groups.reviews')}
                scroll="page-virtualized" minListWidth={0} minDetailWidth={0} preferredListRatio={1}
                loading={list.items === null && list.error === null} testID="reviews:list"
                empty={failure ?? <SurfaceStateCard kind="empty" title={t('ui.pluginUi.empty')} replacesContent />} />
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
            .then(result => { if (result.ok) void view.list.refresh(); });
    }, [item.reviewId, setMembership, view.list]);
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
