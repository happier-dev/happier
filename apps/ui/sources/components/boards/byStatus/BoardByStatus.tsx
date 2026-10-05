import * as React from 'react';
import { Collection, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import { useHappierCollection, type HappierCollectionGrouping } from '@happier-dev/plugin-ui/presentation';

import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { describeWorkStatusBucket, WORK_STATUS_BUCKETS } from '@/components/work/status/workStatusBuckets';
import { t } from '@/text';

import { BoardCardView } from '../cards/BoardCardView';
import type { BoardCard } from '../model/boardCards';
import type { BoardCanvasWidget, BoardCanvasWidgetRender } from '../canvas/BoardCanvas';

/** A work card, or a configured widget (which has a placement and no status). */
type StatusItem = BoardCard | BoardCanvasWidget;
const isWidget = (item: StatusItem): item is BoardCanvasWidget => 'placement' in item;
const WIDGETS_GROUP = 'widgets';
const NO_WIDGETS: readonly BoardCanvasWidget[] = Object.freeze([]);
const keyOf = (item: StatusItem) => item.key;
const groupOf = (item: StatusItem) => isWidget(item) ? WIDGETS_GROUP : item.status.bucket;
/** A widget is not opened: its own body holds its controls. */
const SELECTION = { isItemActivatable: (item: StatusItem) => !isWidget(item) };

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
    stacked: boolean;
    /** Route focus returning from the opened item, supplied by the navigation owner. */
    active?: boolean;
    /** Keep the model's per-view memory while Canvas is visible, without mounting hidden cards. */
    visible?: boolean;
}>) {
    const widgets = props.widgets ?? NO_WIDGETS;
    const hasWidgets = widgets.length > 0;
    const groups = React.useMemo((): HappierCollectionGrouping<StatusItem> => ({
        // Widgets lead, in the Board's order; a Board without them keeps its five status groups.
        axis: [
            ...(hasWidgets ? [{ key: WIDGETS_GROUP, title: t('boards.widgets.group') }] : []),
            ...WORK_STATUS_BUCKETS.map(bucket => ({ key: bucket, title: describeWorkStatusBucket(bucket) })),
        ],
        groupOf, retainEmpty: !props.stacked,
    }), [hasWidgets, props.stacked]);
    const items = React.useMemo((): readonly StatusItem[] => hasWidgets ? [...widgets, ...props.cards] : props.cards, [hasWidgets, props.cards, widgets]);
    const renderWidget = props.renderWidget;
    const anatomy = React.useMemo((): CollectionAnatomy<StatusItem> => ({
        boardContent: item => isWidget(item) ? renderWidget?.(item, { grip: null, lifted: false, active: true }) ?? null : <BoardCardView card={item} />,
        glyph: () => null,
        title: item => item.title,
        accessibilityLabel: item => `${item.title}, ${isWidget(item) ? t('boards.widgets.kind') : item.status.word}`,
        testID: item => isWidget(item) ? `board-status-widget:${item.key}` : `board-status-card:${item.key}`,
        columnTitles: { title: '' },
    }), [renderWidget]);
    const onOpenChange = React.useCallback((key: string | null) => {
        const card = props.cards.find(candidate => candidate.key === key);
        if (card) {
            current.current.actions.focus(card.key);
            props.onOpen(card);
        }
    }, [props.cards, props.onOpen]);
    const model = useHappierCollection({ items, keyOf, groups, selection: 'none', openKey: null, onOpenChange });
    const current = React.useRef(model);
    current.current = model;
    React.useEffect(() => {
        if (props.active !== false && current.current.focusKey !== null) current.current.actions.requestFocus(current.current.focusKey);
    }, [props.active]);
    if (props.visible === false) return null;
    return <CoreCollectionScope>
        <Collection model={model} anatomy={anatomy} accessibilityLabel={t('boards.header.byStatus')}
            presentation="board" boardLayout={props.stacked ? 'stacked' : 'columns'} detail="none" selection={SELECTION}
            minListWidth={280} minDetailWidth={0} preferredListRatio={1} testID="board-by-status" />
    </CoreCollectionScope>;
});
