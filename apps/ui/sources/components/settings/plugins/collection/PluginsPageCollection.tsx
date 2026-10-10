import * as React from 'react';
import { View } from 'react-native';
import { Collection, type CollectionAnatomy, type CollectionGroupAction, type CollectionRowActions } from '@happier-dev/plugin-ui';
import type { HappierCollectionModel } from '@happier-dev/plugin-ui/presentation';

import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { ItemList } from '@/components/ui/lists/ItemList';
import { usePageNoticeActive } from '@/components/ui/lists/listPresentation';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';

import { PLUGIN_CARD_MIN_WIDTH_PX } from './PluginCardStatus';
import type { PluginsCollectionPresentation } from '../PluginMarketplaceSections';

/** The page's content column, so the page header, the items and the entries below share one edge. */
function PluginsPageColumn(props: Readonly<{ children?: React.ReactNode }>) {
    const maxWidthStyle = useLayoutMaxWidthStyle();
    return <View style={[{ width: '100%', alignSelf: 'center' }, maxWidthStyle]}>{props.children}</View>;
}

/** The Plugins page's one scroller: the settings page anatomy, the page's content column. */
function renderPluginsPageScroller(children: React.ReactNode, pageNoticeActive: boolean): React.ReactNode {
    return (
        <ItemList style={{ paddingTop: 0 }} pageColumn="wide" pageNoticeActive={pageNoticeActive}>
            <PluginsPageColumn>{children}</PluginsPageColumn>
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
