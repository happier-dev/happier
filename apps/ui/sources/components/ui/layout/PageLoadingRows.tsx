import * as React from 'react';
import { View } from 'react-native';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet } from 'react-native-unistyles';

import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { t } from '@/text';

import { PageFrame } from './PageFrame';
import { PageHeaderPlaceholder } from './PageHeader';

const PAGE_LOADING_ROWS = 4;

/**
 * A page holding its place while it loads (lab nav-N5): rows in the page's column, never a page-sized
 * spinner, so what lands replaces them in place. Only how the wait looks lives here. `header` holds the
 * page header's room too, for a wait above any page that has not drawn its own header yet.
 */
export const PageLoadingRows = React.memo(function PageLoadingRows(props: Readonly<{ testID: string; header?: boolean }>) {
    return (
        <View testID={props.testID} style={stylesheet.page} accessible role="status"
            accessibilityLabel={t('common.loading')} accessibilityLiveRegion="polite">
            {props.header ? <PageHeaderPlaceholder testID={`${props.testID}-header`} /> : null}
            <PageFrame testID={`${props.testID}-rows`} content="column">
                <View style={stylesheet.rows}><SkeletonRows rows={PAGE_LOADING_ROWS} /></View>
            </PageFrame>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    page: {
        flex: 1,
    },
    // The rows' own inset (s12) plus this puts their leading edge on the page title's.
    rows: {
        paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx - theme.space.s12,
    },
}));
