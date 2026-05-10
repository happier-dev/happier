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

export type StoryDeckListCardProps = Readonly<{
    card: ListCardData;
    testID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        paddingHorizontal: 28,
        paddingTop: 40,
        paddingBottom: 30,
        gap: 30,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 24,
        lineHeight: 30,
        letterSpacing: -0.35,
        textAlign: 'center',
        color: theme.colors.text,
    },
    rowsStatic: {
        gap: 30,
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
        gap: 30,
        paddingBottom: 8,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 18,
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
        gap: 4,
    },
    rowTitle: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        lineHeight: 22,
        color: theme.colors.text,
    },
    rowBody: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.textSecondary,
    },
}));

export function StoryDeckListCard(props: StoryDeckListCardProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const shouldScrollRows = props.card.rows.length > STORY_DECK_LIST_CARD_SCROLL_ROW_THRESHOLD;
    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 2,
        edgeThreshold: 2,
        initialVisibility: shouldScrollRows ? { bottom: true } : undefined,
    });

    return (
        <View style={styles.container} testID={props.testID}>
            <Text style={styles.title}>{tLoose(props.card.titleKey)}</Text>
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
                        {props.card.rows.map((row, index) => renderRow(row, index, theme.colors.text, styles))}
                    </ScrollView>
                    <View testID={`${props.testID ?? 'story-list'}-rows-scroll-fades`} pointerEvents="none">
                        <ScrollEdgeFades
                            color={theme.colors.surface}
                            size={18}
                            edges={scrollFades.visibility}
                        />
                    </View>
                    <View testID={`${props.testID ?? 'story-list'}-rows-scroll-indicators`} pointerEvents="none">
                        <ScrollEdgeIndicators
                            edges={scrollFades.visibility}
                            color={theme.colors.textSecondary}
                            size={14}
                            opacity={0.35}
                        />
                    </View>
                </View>
            ) : (
                <View style={styles.rowsStatic} testID={`${props.testID ?? 'story-list'}-rows-static`}>
                    {props.card.rows.map((row, index) => renderRow(row, index, theme.colors.text, styles))}
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
): React.ReactNode {
    return (
        <View key={`${row.iconId}-${index}`} style={styles.row}>
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
