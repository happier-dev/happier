import * as React from 'react';
import { Platform, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { HAPPIER_COLUMN_MIN_WIDTH_PX, HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import type { PageAsideColumnsProps } from '@happier-dev/plugin-ui/components';

import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';

/**
 * The aside's sheet (lab `m-config` receipt, lab A2 live preview): one width for every page aside.
 * The column adds the sheet inset every `ItemGroup` carries on both sides.
 */
const PAGE_ASIDE_SHEET_WIDTH_PX = 304;
const PAGE_ASIDE_COLUMN_WIDTH_PX = PAGE_ASIDE_SHEET_WIDTH_PX + 2 * HAPPIER_PAGE_METRICS.sheetInsetPx;

/**
 * A page's sections beside one aside (a receipt, a live preview) that stays in view while the
 * sections scroll. Desktop keeps the aside in its own column; a phone, or a pane too narrow for
 * both, reads one column. `compact` is the caller's phone decision; width alone decides otherwise.
 *
 * The two columns together are the page column (such pages use the wide one), centred like the page
 * header above them, so the title, the sections and the aside's far edge share the header's edges
 * however wide the pane is. `closing` (the page's leave-or-destroy row) always
 * ends the page: under the sections on desktop, after the aside in one column.
 * `compactAside` says where the aside goes in one column; `"none"` leaves it out, for an aside that
 * only mirrors what the sections can show themselves: pass `children` as a function to learn which
 * layout is in effect.
 */
export const PageAsideColumns = React.memo(function PageAsideColumns(props: Omit<PageAsideColumnsProps, 'fallback'>) {
    const columnWidth = useLayoutMaxWidthStyle();
    // Split panes are wide enough by construction, so the first paint is already final there.
    const [wide, setWide] = React.useState(!props.compact);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = event.nativeEvent.layout.width;
        if (!Number.isFinite(width) || width <= 0) return;
        const next = width >= PAGE_ASIDE_COLUMN_WIDTH_PX + HAPPIER_COLUMN_MIN_WIDTH_PX;
        setWide((current) => (current === next ? current : next));
    }, []);
    const oneColumnAside = props.compactAside === 'none' ? null : props.aside;
    const measureColumns = !props.compact && Boolean(props.aside);
    const sideBySide = measureColumns && wide;
    const children = typeof props.children === 'function' ? props.children({ sideBySide }) : props.children;
    const asideFirst = !measureColumns && props.compactAside === 'first';
    const aside = sideBySide || oneColumnAside ? (
        <View key="aside" style={sideBySide ? styles.aside : undefined}>{props.aside}</View>
    ) : null;
    // Keep the same parents through responsive changes and receipt arrival. Keyed sibling slots can
    // change their reading order without resetting a field or an open control in either column.
    return (
        <View onLayout={measureColumns ? onLayout : undefined} style={sideBySide ? [styles.row, columnWidth] : undefined}>
            {asideFirst ? aside : null}
            <View key="main" style={sideBySide ? styles.main : undefined}>
                {children}
                {sideBySide ? props.closing : null}
            </View>
            {asideFirst ? null : aside}
            {sideBySide ? null : props.closing}
        </View>
    );
});

// Web only: the page's one scroll owner keeps the aside pinned below its top edge.
// React Native Web passes `sticky` through to CSS; native platforms scroll it with the page.
const stickyAside: ViewStyle = Platform.OS === 'web'
    ? { position: 'sticky' as 'relative', top: HAPPIER_PAGE_METRICS.sheetInsetPx }
    : {};

const styles = {
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        width: '100%',
        alignSelf: 'center',
    },
    main: {
        flex: 1,
        minWidth: 0,
    },
    aside: {
        width: PAGE_ASIDE_COLUMN_WIDTH_PX,
        flexShrink: 0,
        ...stickyAside,
    },
} satisfies Record<string, ViewStyle>;
