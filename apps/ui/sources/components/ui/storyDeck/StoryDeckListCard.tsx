import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ScrollView } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { STORY_DECK_LIST_CARD_SCROLL_ROW_THRESHOLD } from '@/changelog/releaseNotes/storyDeckCardLimits';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { tLoose } from '@/text';
import type { StoryDeckListCard as ListCardData } from '@/changelog/releaseNotes/types';

import { resolveStoryDeckIconName } from './storyDeckIconRegistry';
import type { StoryDeckCardLayout } from './storyDeckPresentation';
import {
    STORY_DECK_WIDE_CONTENT_BOTTOM_PADDING,
    STORY_DECK_WIDE_CONTENT_HORIZONTAL_PADDING,
    STORY_DECK_WIDE_TITLE_FONT_SIZE,
    STORY_DECK_WIDE_TITLE_LINE_HEIGHT,
    STORY_DECK_WIDE_LIST_CONTENT_GAP,
    STORY_DECK_WIDE_LIST_ROW_BASIS,
} from './storyDeckLayout';

export type StoryDeckListCardProps = Readonly<{
    card: ListCardData;
    testID?: string;
    layout?: StoryDeckCardLayout;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        paddingHorizontal: 28,
        paddingTop: 40,
        paddingBottom: 30,
        gap: 30,
    },
    containerWide: {
        paddingHorizontal: STORY_DECK_WIDE_CONTENT_HORIZONTAL_PADDING,
        paddingBottom: STORY_DECK_WIDE_CONTENT_BOTTOM_PADDING,
        gap: STORY_DECK_WIDE_LIST_CONTENT_GAP,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 24,
        lineHeight: 30,
        letterSpacing: -0.35,
        textAlign: 'center',
        color: theme.colors.text.primary,
    },
    titleWide: {
        fontSize: STORY_DECK_WIDE_TITLE_FONT_SIZE,
        lineHeight: STORY_DECK_WIDE_TITLE_LINE_HEIGHT,
    },
    rowsGrid: {
        rowGap: 25,
    },
    rowsGridWide: {
        width: '100%',
        alignSelf: 'center',
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: 25,
        rowGap: 25,
    },
    rowsScrollWrap: {
        flex: 1,
        minHeight: 0,
        position: 'relative',
    },
    rowsScroll: {
        flex: 1,
        minHeight: 0,
    },
    rowsScrollContent: {
        paddingBottom: 8,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 18,
    },
    rowWide: {
        flexBasis: STORY_DECK_WIDE_LIST_ROW_BASIS,
        maxWidth: STORY_DECK_WIDE_LIST_ROW_BASIS,
        flexGrow: 1,
        minWidth: 0,
    },
    iconWrapper: {
        width: 42,
        height: 42,
        borderRadius: 21,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'transparent',
    },
    rowText: {
        flex: 1,
        minWidth: 0,
        gap: 4,
    },
    rowTitle: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        lineHeight: 22,
        color: theme.colors.text.primary,
    },
    rowBody: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.text.secondary,
    },
}));

export function StoryDeckListCard(props: StoryDeckListCardProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const isWide = props.layout === 'wide';
    const titleKey = isWide && props.card.wideTitleKey ? props.card.wideTitleKey : props.card.titleKey;
    const shouldScrollRows = props.card.rows.length > STORY_DECK_LIST_CARD_SCROLL_ROW_THRESHOLD;
    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 2,
        edgeThreshold: 2,
        initialVisibility: shouldScrollRows ? { bottom: true } : undefined,
    });

    return (
        <View style={[styles.container, isWide ? styles.containerWide : null]} testID={props.testID}>
            <Text style={[styles.title, isWide ? styles.titleWide : null]}>{tLoose(titleKey)}</Text>
            {shouldScrollRows ? (
                <View style={styles.rowsScrollWrap}>
                    <ScrollView
                        testID={`${props.testID ?? 'story-list'}-rows-scroll`}
                        style={styles.rowsScroll}
                        contentContainerStyle={styles.rowsScrollContent}
                        showsVerticalScrollIndicator={false}
                        scrollEventThrottle={16}
                        onLayout={scrollFades.onViewportLayout}
                        onContentSizeChange={scrollFades.onContentSizeChange}
                        onScroll={scrollFades.onScroll}
                        onMomentumScrollEnd={scrollFades.onMomentumScrollEnd}
                    >
                        <View
                            style={[styles.rowsGrid, isWide ? styles.rowsGridWide : null]}
                            testID={`${props.testID ?? 'story-list'}-rows-grid`}
                        >
                            {props.card.rows.map((row, index) => renderRow(row, index, theme.colors.text.primary, styles, isWide))}
                        </View>
                    </ScrollView>
                    <View testID={`${props.testID ?? 'story-list'}-rows-scroll-fades`} pointerEvents="none">
                        <ScrollEdgeFades
                            color={theme.colors.surface.base}
                            size={18}
                            edges={scrollFades.visibility}
                        />
                    </View>
                    <View testID={`${props.testID ?? 'story-list'}-rows-scroll-indicators`} pointerEvents="none">
                        <ScrollEdgeIndicators
                            edges={scrollFades.visibility}
                            color={theme.colors.text.secondary}
                            size={14}
                            opacity={0.35}
                        />
                    </View>
                </View>
            ) : (
                <View
                    style={[styles.rowsGrid, isWide ? styles.rowsGridWide : null]}
                    testID={`${props.testID ?? 'story-list'}-rows-static`}
                >
                    {props.card.rows.map((row, index) => renderRow(row, index, theme.colors.text.primary, styles, isWide))}
                </View>
            )}
        </View>
    );
}

function renderRow(
    row: ListCardData['rows'][number],
    index: number,
    iconColor: string,
    styles: typeof stylesheet,
    isWide: boolean,
): React.ReactNode {
    return (
        <View key={`${row.iconId}-${index}`} style={[styles.row, isWide ? styles.rowWide : null]}>
            <View style={styles.iconWrapper}>
                <Ionicons
                    name={resolveStoryDeckIconName(row.iconId)}
                    size={30}
                    color={iconColor}
                />
            </View>
            <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{tLoose(row.titleKey)}</Text>
                <Text style={styles.rowBody}>{tLoose(row.bodyKey)}</Text>
            </View>
        </View>
    );
}
