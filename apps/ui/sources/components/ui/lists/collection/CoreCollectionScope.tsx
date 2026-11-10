import * as React from 'react';
import { View } from 'react-native';
import { HAPPIER_PAGE_METRICS, HappierColumnEdgeContext, useHappierPageSection } from '@happier-dev/plugin-ui/presentation';

import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { BareRowBleedContext, useBareRowBleedPx } from '@/components/ui/lists/bareRowBleed';
import { useListPresentation, usePageListInsets } from '@/components/ui/lists/listPresentation';
import { useInPageContentColumn } from '@/components/ui/lists/PageContentColumn';

/**
 * Happier core's binding of the public `Collection` on a core page: the environment, host renderers and facts a
 * plugin surface mounted in the app receives (the app's theme, type roles and page colours, its locale for the
 * framework chrome, its icons and popovers), plus the page's own scroller for a page-sized collection. Core pages
 * render the one Collection instead of a page-local grid or list. Core forms that draw the public typed field
 * (`HappierInputField`: Action, Workflow and widget inputs) sit in it too, so a field's choices float in the app's
 * anchored popover like every other menu.
 */
export const CoreCollectionScope = React.memo(function CoreCollectionScope(props: Readonly<{
    /** The page's scroller (`ItemList` with the page's anatomy) for `Collection scroll="page"`. */
    renderPageScroller?: (children: React.ReactNode) => React.ReactNode;
    children: React.ReactNode;
}>) {
    // Mounted on a core page's column, the page's own sections already sit on the sheet edge (the Collection a
    // page scroller opens starts its own presentation scope, so it is not here). Public sections inside add no
    // second inset; the column edge is told once, here, instead of each consumer cancelling it. Inside a sheet's
    // row (an expanded row's body) there is no column edge: its content draws its own.
    const inSheet = useHappierPageSection() !== null;
    // A page content column (`PageContentColumn`) draws no edge, so a Collection in it insets from its own edge.
    const inContentColumn = useInPageContentColumn();
    const onPageColumn = useListPresentation() === 'page' && usePageListInsets() === 'standard' && !inSheet && !inContentColumn;
    const inner = (
        <CorePluginUiPresentationScope renderPageScroller={props.renderPageScroller}>
            {props.children}
        </CorePluginUiPresentationScope>
    );
    const scope = onPageColumn
        ? <HappierColumnEdgeContext.Provider value={HAPPIER_PAGE_METRICS.sheetInsetPx}>{inner}</HappierColumnEdgeContext.Provider>
        : inner;
    // A Collection owns its edge on the page (its sheet inset, its resting list on the page's edges). A bare
    // section's bleed is for its own rows, so a Collection inside one gets the inset back like any free content,
    // and the sections it draws in its header start unbled.
    const bleedPx = useBareRowBleedPx();
    return bleedPx > 0 ? (
        <BareRowBleedContext.Provider value={0}>
            <View style={{ paddingHorizontal: bleedPx }}>{scope}</View>
        </BareRowBleedContext.Provider>
    ) : scope;
});
