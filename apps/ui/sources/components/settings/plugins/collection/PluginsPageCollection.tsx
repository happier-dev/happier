import * as React from 'react';
import { Collection, type CollectionAnatomy, type CollectionGroupAction, type CollectionRowActions } from '@happier-dev/plugin-ui';
import type { HappierCollectionModel } from '@happier-dev/plugin-ui/presentation';

import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { ItemList } from '@/components/ui/lists/ItemList';
import { usePageNoticeActive } from '@/components/ui/lists/listPresentation';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';

import type { PluginsCollectionPresentation } from '../PluginMarketplaceSections';

/** Narrowest a plugin card may become before the Plugins grid drops a column. */
export const PLUGIN_CARD_MIN_WIDTH_PX = 240;

/** The page's content column, so the page header, the items and the entries below share one edge. */
/** The Plugins page's one scroller: the settings page anatomy, the page's content column. */
function renderPluginsPageScroller(children: React.ReactNode, pageNoticeActive: boolean): React.ReactNode {
    return (
        <ItemList style={{ paddingTop: 0 }} pageColumn="wide" pageNoticeActive={pageNoticeActive}>
            <PageContentColumn>{children}</PageContentColumn>
        </ItemList>
    );
}

/**
 * The Plugins page as one page-sized Collection (Installed and Browse alike): the page's own header above, the
 * plugins as the one grid or list, the page's entries below — one scroller and one reading and focus order. The
 * open plugin is the page's (its details pane), marked on its card or row.
 */
export function PluginsPageCollection<Item>(props: Readonly<{
    model: HappierCollectionModel<Item>;
    anatomy: CollectionAnatomy<Item>;
    presentation: PluginsCollectionPresentation;
    accessibilityLabel: string;
    header: React.ReactNode;
    footer: React.ReactNode;
    empty?: React.ReactNode;
    loading?: boolean;
    groupAction?: (groupKey: string) => CollectionGroupAction | null;
    useRowActions?: (item: Item) => CollectionRowActions;
    testID: string;
}>) {
    // This scroller continues the same Plugins page scope, including its notice above the toolbar.
    const pageNoticeActive = usePageNoticeActive();
    const renderPageScroller = React.useCallback(
        (children: React.ReactNode) => renderPluginsPageScroller(children, pageNoticeActive),
        [pageNoticeActive],
    );
    return (
        <CoreCollectionScope renderPageScroller={renderPageScroller}>
            <Collection<Item>
                model={props.model}
                anatomy={props.anatomy}
                accessibilityLabel={props.accessibilityLabel}
                presentation={props.presentation}
                // The open plugin opens in the page's own details pane (or its own page on a phone).
                detail="none"
                scroll="page"
                minListWidth={PLUGIN_CARD_MIN_WIDTH_PX}
                minDetailWidth={PLUGIN_CARD_MIN_WIDTH_PX}
                preferredListRatio={0.5}
                minCardWidth={PLUGIN_CARD_MIN_WIDTH_PX}
                header={props.header}
                footer={props.footer}
                {...(props.empty === undefined ? {} : { empty: props.empty })}
                {...(props.loading === undefined ? {} : { loading: props.loading })}
                {...(props.groupAction === undefined ? {} : { groupAction: props.groupAction })}
                {...(props.useRowActions === undefined ? {} : { useRowActions: props.useRowActions })}
                testID={props.testID}
            />
        </CoreCollectionScope>
    );
}
