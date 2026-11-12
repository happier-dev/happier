import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HorizontalOverflowScrollView } from '@/components/ui/scroll/HorizontalOverflowScrollView';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';

import {
    MarkdownTableBodyRows,
    MarkdownTableHeaderRow,
    useMarkdownTableLayout,
    type MarkdownTableCellRendering,
    type MarkdownTableContent,
} from './MarkdownTableRows';

type MarkdownTableViewerModalProps = CustomModalInjectedProps
    & MarkdownTableContent
    & Omit<MarkdownTableCellRendering, 'streamingReveal' | 'streamingRevealPreset'>;

// Wide enough for any table the viewport can show; the card clamps to the viewport (minus margins and
// safe areas), so a rotated phone gets the extra landscape width.
const VIEWER_CARD_DIMENSIONS = {
    size: 'lg',
    width: 4096,
    maxHeightRatio: 1,
    viewportMargin: { horizontal: 8, vertical: 48 },
} as const;

const VIEWER_CHROME_BASE = {
    kind: 'card',
    testID: 'markdown-table-viewer',
    layout: 'fill',
    dimensions: VIEWER_CARD_DIMENSIONS,
} as const;

const STICKY_HEADER_INDICES = [0];
// Closes the table's right edge when it is narrower than the card.
const CONTENT_BORDER_WIDTH = 1;

/**
 * Full-size reader for one transcript table. Uses the same content-estimated column widths against
 * the card width; the header row stays pinned while the body scrolls vertically and moves
 * horizontally with it. Mounted only while open.
 */
export function MarkdownTableViewerModal(props: MarkdownTableViewerModalProps) {
    const layout = useMarkdownTableLayout(props.headers, props.rows);
    const title = t('markdown.table.viewerTitle');
    const chrome = React.useMemo(() => ({ ...VIEWER_CHROME_BASE, title }), [title]);
    useModalCardChrome(props.setChrome, chrome);

    const contentSizeStyle = React.useMemo(
        () => ({ width: '100%' as const, maxWidth: layout.naturalWidth + CONTENT_BORDER_WIDTH, minWidth: layout.floorWidth + CONTENT_BORDER_WIDTH }),
        [layout.floorWidth, layout.naturalWidth],
    );

    const rowProps = {
        headers: props.headers,
        rows: props.rows,
        alignments: props.alignments,
        selectable: props.selectable,
        onLinkPress: props.onLinkPress,
        textStyle: props.textStyle,
        profile: props.profile,
        agentTexMath: props.agentTexMath,
        streamingReveal: false,
        layout,
    };

    return (
        <View style={styles.body}>
            <HorizontalOverflowScrollView
                testID="markdown-table-viewer-scroll-x"
                showsHorizontalScrollIndicator={true}
                keepNativeTextSelection={props.selectable}
                style={styles.horizontalScroll}
                contentContainerStyle={[styles.horizontalContent, contentSizeStyle]}
            >
                <ScrollView
                    testID="markdown-table-viewer-scroll-y"
                    style={styles.verticalScroll}
                    stickyHeaderIndices={STICKY_HEADER_INDICES}
                    showsVerticalScrollIndicator={true}
                >
                    <MarkdownTableHeaderRow {...rowProps} style={styles.stickyHeader} />
                    <View style={styles.bodyRows}>
                        <MarkdownTableBodyRows {...rowProps} />
                    </View>
                </ScrollView>
            </HorizontalOverflowScrollView>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    body: {
        flex: 1,
        minHeight: 0,
    },
    horizontalScroll: {
        flex: 1,
    },
    horizontalContent: {
        flexDirection: 'column',
        borderRightWidth: CONTENT_BORDER_WIDTH,
        borderRightColor: theme.colors.border.default,
    },
    verticalScroll: {
        flex: 1,
    },
    stickyHeader: {
        // The body scrolls beneath the pinned header row; keep the divider visible.
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    bodyRows: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
}));
