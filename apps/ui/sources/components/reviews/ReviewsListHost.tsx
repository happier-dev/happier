import * as React from 'react';
import { HostCollection as Collection, useHappierCollection, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import type { HappierCollectionWindow } from '@happier-dev/plugin-ui/presentation';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import type { ReviewListItemV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { artifactViewRoute } from '@/components/artifacts/artifactBrowserModel';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';
import { useReviewList } from './useReviewList';

const input = Object.freeze({ limit: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 });
const keyOf = (item: ReviewListItemV1) => item.reviewId;
const passThrough = (children: React.ReactNode) => children;
const EMPTY_ITEMS: readonly ReviewListItemV1[] = Object.freeze([]);

/** The live header collection. The Review collection composition consumes the same list hook. */
export function ReviewsListHost(): React.ReactElement {
    const list = useReviewList(input);
    const router = useRouter();
    const reviewLabel = t('detailsSurface.review.title');
    const moreLabel = t('common.more');
    const window = React.useMemo((): HappierCollectionWindow => list.cursor ? {
        kind: 'partial', continuations: [{ key: 'more', label: moreLabel,
            load: list.loadMore, busy: list.status === 'loading_more' }],
    } : { kind: 'complete' }, [list.cursor, list.loadMore, list.status, moreLabel]);
    const open = React.useCallback((key: string | null) => {
        if (key !== null) router.push(artifactViewRoute(key) as never);
    }, [router]);
    const model = useHappierCollection<ReviewListItemV1>({
        items: list.items ?? EMPTY_ITEMS, keyOf, window, openKey: null, onOpenChange: open,
    });
    // This response carries metadata, not decrypted Artifact titles. Name its actual kind and creation time.
    const anatomy = React.useMemo((): CollectionAnatomy<ReviewListItemV1> => ({
        glyph: () => null, loadingGlyph: false, title: () => reviewLabel,
        columnTitles: { title: reviewLabel },
        accessibilityLabel: item => `${reviewLabel} · ${formatRelativeTimeShort(item.createdAt, Date.now())}`,
        byline: item => formatRelativeTimeShort(item.createdAt, Date.now()),
        testID: item => `reviews:row:${item.reviewId}`,
    }), [reviewLabel]);
    const failure = list.error ? <SurfaceStateCard kind="error" title={t('common.error')}
        diagnosticCode={list.error.code ?? undefined} action={{ label: t('common.retry'), onPress: list.refresh }}
        {...(list.items?.length ? { size: 'line' as const } : { replacesContent: true })} /> : null;
    return <ItemList pageColumn="wide"><CoreCollectionScope renderPageScroller={passThrough}>
        <PageContentColumn>
            <PageHeader title={t('homeSettings.groups.reviews')} />
            {list.items?.length ? failure : null}
            <Collection model={model} anatomy={anatomy} presentation="list" detail="none"
                accessibilityLabel={t('homeSettings.groups.reviews')}
                scroll="page-virtualized" minListWidth={0} minDetailWidth={0} preferredListRatio={1}
                loading={list.items === null && list.error === null} testID="reviews:list"
                empty={failure ?? <SurfaceStateCard kind="empty" title={t('ui.pluginUi.empty')} replacesContent />} />
        </PageContentColumn>
    </CoreCollectionScope></ItemList>;
}
