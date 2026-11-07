import * as React from 'react';
import { ScrollView } from 'react-native';
import { Collection, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import { useHappierCollection, type HappierCollectionGrouping } from '@happier-dev/plugin-ui/presentation';

import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { describeWorkStatusBucket, WORK_STATUS_BUCKETS } from '@/components/work/status/workStatusBuckets';
import { t } from '@/text';

import { BoardCardActionButton, BoardCardBodyContent, BoardCardFacts, BoardCardMark, BoardCardStatus, shownBoardCardWord } from '../cards/BoardCardView';
import type { BoardCard } from '../model/boardCards';
import type { BoardCardAction } from '../model/boardCardOpenTarget';
import type { BoardCanvasWidget, BoardCanvasWidgetRender } from '../canvas/BoardCanvas';

const NO_WIDGETS: readonly BoardCanvasWidget[] = Object.freeze([]);
const keyOf = (item: BoardCard) => item.key;
const groupOf = (item: BoardCard) => item.status.bucket;
const passThroughScroller = (children: React.ReactNode) => <>{children}</>;
const fillStyle = { flex: 1 } as const;
const scrollContentStyle = { flexGrow: 1 } as const;

/**
 * By status (lab `boards-B2`): five columns from the one vocabulary — Needs you · Working · Finished ·
 * Idle · Offline — with every kind together. A card's column is its status, so cards are not dragged
 * between columns. On a phone the same groups stack as sections: By status is the phone projection.
 * A Board's widgets lead as their own group, in Board order (lab `dashboards` L1p).
 */
export const BoardByStatus = React.memo(function BoardByStatus(props: Readonly<{
    cards: readonly BoardCard[];
    /** The Board's widgets in Board order: their own group, first (lab L1p). */
    widgets?: readonly BoardCanvasWidget[];
    renderWidget?: BoardCanvasWidgetRender;
    onOpen: (card: BoardCard) => void;
    onAction?: (card: BoardCard, action: BoardCardAction) => void;
    stacked: boolean;
    /** Route focus returning from the opened item, supplied by the navigation owner. */
    active?: boolean;
    /** Keep the model's per-view memory while Canvas is visible, without mounting hidden cards. */
    visible?: boolean;
}>) {
    const widgets = props.widgets ?? NO_WIDGETS;
    const hasWidgets = widgets.length > 0;
    const groups = React.useMemo((): HappierCollectionGrouping<BoardCard> => ({
        axis: WORK_STATUS_BUCKETS.map(bucket => ({ key: bucket, title: describeWorkStatusBucket(bucket),
            tone: bucket === 'needs_you' ? 'attention' as const : 'neutral' as const })),
        groupOf, retainEmpty: !props.stacked,
    }), [props.stacked]);
    const onAction = props.onAction;
    const anatomy = React.useMemo((): CollectionAnatomy<BoardCard> => ({
        card: {
            headerRight: item => <BoardCardActionButton card={item} onAction={onAction} />,
            facts: item => <BoardCardFacts card={item} />,
            description: item => <BoardCardBodyContent card={item} showStatusWord={false} />,
        },
        // The column names the bucket; a qualifying word ("Outcome uncertain") leads the card's facts line, so a
        // narrow column's title keeps the card's width (lab boards-B2).
        reason: item => shownBoardCardWord(item, false) === null ? null : <BoardCardStatus card={item} showStatusWord={false} />,
        glyph: item => <BoardCardMark card={item} />,
        title: item => item.title,
        accessibilityLabel: item => `${item.title}, ${item.status.word}`,
        testID: item => `board-status-card:${item.key}`,
        columnTitles: { title: '' },
    }), [onAction]);
    const onOpenChange = React.useCallback((key: string | null) => {
        const card = props.cards.find(candidate => candidate.key === key);
        if (card) {
            current.current.actions.focus(card.key);
            props.onOpen(card);
        }
    }, [props.cards, props.onOpen]);
    const model = useHappierCollection({ items: props.cards, keyOf, groups, selection: 'none', openKey: null, onOpenChange });
    const current = React.useRef(model);
    current.current = model;
    const scroller = React.useRef<ScrollView | null>(null);
    const viewport = model.viewport('board');
    React.useLayoutEffect(() => {
        if (props.visible !== false) scroller.current?.scrollTo({ y: viewport.offsetRef.current, animated: false });
    }, [props.visible, props.stacked, viewport]);
    React.useEffect(() => {
        if (props.active !== false && current.current.focusKey !== null) current.current.actions.requestFocus(current.current.focusKey);
    }, [props.active]);
    if (props.visible === false) return null;
    return <CoreCollectionScope renderPageScroller={passThroughScroller}>
        <ScrollView ref={scroller} style={fillStyle} contentContainerStyle={scrollContentStyle} scrollEventThrottle={16}
            onScroll={event => { viewport.offsetRef.current = event.nativeEvent.contentOffset.y; }}>
            {hasWidgets ? <ItemGroup testID="board-by-status:column:widgets" surface="none" title={t('boards.widgets.group')}
                titleAccessory={<Text variant="meta">{widgets.length}</Text>}>
                {widgets.map(widget => <React.Fragment key={widget.key}>
                    {props.renderWidget?.(widget, { grip: null, lifted: false, active: true })}
                </React.Fragment>)}
            </ItemGroup> : null}
        <Collection model={model} anatomy={anatomy} accessibilityLabel={t('boards.header.byStatus')}
            presentation="board" boardLayout={props.stacked ? 'stacked' : 'columns'} detail="none" scroll="page"
            minListWidth={280} minDetailWidth={0} preferredListRatio={1} testID="board-by-status" />
        </ScrollView>
    </CoreCollectionScope>;
});
