import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
    HAPPIER_ICON_BUTTON_WELL_SIZE, HAPPIER_PAGE_METRICS, HAPPIER_SEARCH_FIELD_METRICS,
} from '@happier-dev/plugin-ui/presentation';

import { useDetailsPaneSlotBinding } from '@/components/appShell/panes/details/DetailsPaneSlot';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { useOptionalAppPaneScopeLayout } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { SkeletonRows, SkeletonTitle } from '@/components/ui/lists/SkeletonRows';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';

const COLUMN_INSET = resolveItemGroupContentHorizontalInsetPx();
const keepRoute = () => {};

/** While a selected entry is loading, use the same Details slot as the mounted Collection. */
export function PluginAppPageEntryLoading(props: Readonly<{
    testID: string;
    accessibilityLabel: string;
    header: React.ReactNode;
    children: React.ReactNode;
}>): React.ReactElement {
    const binding = useDetailsPaneSlotBinding();
    const beside = useDetailsPaneAvailable();
    const layout = useOptionalAppPaneScopeLayout();
    const { theme } = useUnistyles();
    const { spacing } = usePluginUiTheme(theme);
    // The layout owner has already allowed for the other panes and the rail. The Collection
    // measures its stage inside the page gutter, and folds at the same shared breakpoint.
    const compact = layout !== null
        && layout.mainRegionWidthPx - 2 * COLUMN_INSET < HAPPIER_PAGE_METRICS.toolbarFoldBelowWidthPx;
    const detail = (
        <View testID={`${props.testID}-detail-skeleton`} style={{
            paddingHorizontal: COLUMN_INSET, paddingTop: HAPPIER_PAGE_METRICS.pageHeaderUnderChromePaddingTopPx,
        }}>
            <View style={{ justifyContent: 'center', height: HAPPIER_PAGE_METRICS.paneHeaderHeightPx }}>
                <SkeletonTitle lineHeight={HAPPIER_PAGE_METRICS.controlHeightPx} />
            </View>
            <SkeletonRows rows={4} {...(beside && binding !== null ? {} : { accessibilityLabel: props.accessibilityLabel })} />
        </View>
    );
    if (!beside || binding === null) return detail;
    return (
        <View style={{ flex: 1, paddingTop: HAPPIER_PAGE_METRICS.pageHeaderUnderChromePaddingTopPx }}>
            {binding.renderDetailsPane({ open: true, children: detail, onClose: keepRoute })}
            {/* CollectionToolbar's search and round actions lead; the route controls take the next line. */}
            {compact ? <View testID={`${props.testID}-toolbar-search`} style={{
                height: Math.max(HAPPIER_SEARCH_FIELD_METRICS.heightPx, HAPPIER_ICON_BUTTON_WELL_SIZE),
                marginBottom: spacing.small,
            }} /> : null}
            {props.header}
            {props.children}
        </View>
    );
}
