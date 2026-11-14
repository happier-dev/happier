import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconAction } from '@/components/ui/buttons/IconAction';
import { CopyIconButton } from '@/components/ui/copy/CopyIconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { HorizontalOverflowScrollView } from '@/components/ui/scroll/HorizontalOverflowScrollView';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { Modal } from '@/modal';
import { t } from '@/text';

import {
    MarkdownTableBodyRows,
    MarkdownTableHeaderRow,
    useMarkdownTableLayout,
    type MarkdownTableCellRendering,
    type MarkdownTableContent,
} from './MarkdownTableRows';
import { MarkdownTableViewerModal } from './MarkdownTableViewerModal';
import { serializeMarkdownTable, serializeMarkdownTableCsv } from './serializeMarkdownTable';

// Outer frame border on both sides.
const FRAME_BORDER_WIDTH = 1;
// Room for the footer actions (open 28 + CSV copy ~60 + copy ~30, plus gaps and padding), so a
// tiny table never clips them; its columns grow to fill the frame instead.
const FRAME_MIN_WIDTH = 140;
const OVERFLOW_FADE_SIZE = 16;
const FADE_EDGES = { left: true, right: true } as const;

/**
 * A transcript table: rows wrap their cells within content-estimated column widths, so the table is
 * as wide as its content up to the available width and scrolls horizontally only when even the
 * narrowest readable columns do not fit. A soft edge fade marks the side that has more columns.
 */
export function MarkdownTableBlock(props: MarkdownTableContent & MarkdownTableCellRendering & Readonly<{
    first: boolean;
    last: boolean;
}>) {
    const { theme } = useUnistyles();
    const { headers, rows, alignments } = props;
    const layout = useMarkdownTableLayout(headers, rows);
    const fades = useScrollEdgeFades({ enabledEdges: FADE_EDGES, overflowThreshold: 2, edgeThreshold: 2 });
    const { onContentSizeChange } = fades;
    const onContentLayout = React.useCallback((event: LayoutChangeEvent) => {
        onContentSizeChange(event.nativeEvent.layout.width, event.nativeEvent.layout.height);
    }, [onContentSizeChange]);

    const frameSizeStyle = React.useMemo(
        () => ({ width: Math.max(FRAME_MIN_WIDTH, layout.naturalWidth + FRAME_BORDER_WIDTH * 2) }),
        [layout.naturalWidth],
    );
    const contentSizeStyle = React.useMemo(
        () => ({ width: '100%' as const, minWidth: layout.floorWidth }),
        [layout.floorWidth],
    );

    const getTableMarkdown = React.useCallback(
        () => serializeMarkdownTable({ headers, rows, alignments }),
        [alignments, headers, rows],
    );
    const getTableCsv = React.useCallback(
        () => serializeMarkdownTableCsv({ headers, rows }),
        [headers, rows],
    );

    const { selectable, onLinkPress, textStyle, profile, agentTexMath } = props;
    const openViewer = React.useCallback(() => {
        Modal.show({
            component: MarkdownTableViewerModal,
            props: { headers, rows, alignments, selectable, onLinkPress, textStyle, profile, agentTexMath },
        });
    }, [agentTexMath, alignments, headers, onLinkPress, profile, rows, selectable, textStyle]);

    return (
        <View style={[styles.frame, frameSizeStyle, props.first && styles.first, props.last && styles.last]}>
            <View style={styles.viewport} onLayout={fades.onViewportLayout}>
                <HorizontalOverflowScrollView
                    testID="markdown-table-scroll"
                    showsHorizontalScrollIndicator={true}
                    style={styles.scrollView}
                    contentContainerStyle={[styles.content, contentSizeStyle]}
                    onScroll={fades.onScroll}
                >
                    <View onLayout={onContentLayout}>
                        <MarkdownTableHeaderRow {...props} layout={layout} />
                        <MarkdownTableBodyRows {...props} layout={layout} />
                    </View>
                </HorizontalOverflowScrollView>
                <ScrollEdgeFades color={theme.colors.surface.base} size={OVERFLOW_FADE_SIZE} edges={fades.visibility} />
            </View>
            <View style={styles.footer}>
                <IconAction
                    size="sm"
                    testID="markdown-table-open"
                    accessibilityLabel={t('markdown.table.open')}
                    onPress={openViewer}
                >
                    <Icon name="arrows-out" size={14} color={theme.colors.text.secondary} />
                </IconAction>
                <CopyIconButton
                    testID="markdown-table-copy-csv"
                    text={getTableCsv}
                    label={t('markdown.table.csvLabel')}
                    accessibilityLabel={t('markdown.table.copyCsv')}
                />
                <CopyIconButton
                    testID="markdown-table-copy"
                    text={getTableMarkdown}
                    accessibilityLabel={t('markdown.table.copyMarkdown')}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    frame: {
        marginVertical: 8,
        borderWidth: FRAME_BORDER_WIDTH,
        borderColor: theme.colors.border.default,
        borderRadius: 8,
        alignSelf: 'flex-start',
        maxWidth: '100%',
        overflow: Platform.OS === 'web' ? 'visible' : 'hidden',
    },
    first: {
        marginTop: 0,
    },
    last: {
        marginBottom: 0,
    },
    viewport: {
        position: 'relative',
    },
    scrollView: {
        flexGrow: 0,
        flexShrink: 0,
        maxWidth: '100%',
    },
    content: {
        flexDirection: 'column',
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 2,
        paddingHorizontal: 4,
        paddingVertical: 2,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
}));
