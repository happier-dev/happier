import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { SCM_COMPARISON_RAIL_INSET_PX, ScmComparisonRailCaption, ScmComparisonRailKeys } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { WalkthroughStopNumber } from './WalkthroughAtoms';
import type { WalkthroughOtherChange, WalkthroughStop } from './walkthroughReading';
import type { WalkthroughReviewedSource } from './walkthroughReviewedProjection';
import { useWalkthroughReviewedCount, useWalkthroughReviewedStop } from './useWalkthroughReviewed';

export type WalkthroughContentsProps = Readonly<{
    stops: readonly WalkthroughStop[];
    others: readonly WalkthroughOtherChange[];
    reviewedCount: number | null;
    reviewedSource?: WalkthroughReviewedSource;
    currentStopId: string | null;
    onSelectStop: (stopId: string) => void;
    onSelectOthers?: () => void;
    placement: 'rail' | 'sheet';
    /** Sheet only: closes it. */
    onDone?: () => void;
    /** A mark after a stop's title, such as the dot of the most severe finding a review placed there. */
    stopAccessory?: (stopId: string) => React.ReactNode;
}>;

function otherCue(others: readonly WalkthroughOtherChange[], tagLockfiles: boolean): string {
    return others.map((other) => {
        const slash = other.path.lastIndexOf('/');
        const name = slash >= 0 ? other.path.slice(slash + 1) : other.path;
        return tagLockfiles && other.lockfile ? `${name} (${t('scmComparison.lockfileTag').toLowerCase()})` : name;
    }).join(' · ');
}

function WalkthroughContentsRow(props: Readonly<{
    stop: WalkthroughStop; source?: WalkthroughReviewedSource; sheet: boolean; on: boolean;
    onSelectStop: WalkthroughContentsProps['onSelectStop']; stopAccessory?: WalkthroughContentsProps['stopAccessory'];
}>) {
    const { theme } = useUnistyles();
    const stop = useWalkthroughReviewedStop(props.source, props.stop);
    const { sheet, on } = props;
    return (
        <HappierPressable
                testID={`walkthrough-contents-${stop.id}`}
                accessibilityRole="link"
                selected={on}
                accessibilityLabel={t('walkthrough.stopA11y', { number: stop.number, title: stop.title })}
                onPress={() => props.onSelectStop(stop.id)}
                style={(state) => [
                    styles.row,
                    sheet ? styles.rowSheet : null,
                    on ? styles.rowOn : null,
                    state.pressed ? styles.rowPressed : null,
                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                ]}
            >
                <View style={sheet ? styles.numberSheet : styles.number}>
                    <WalkthroughStopNumber number={stop.number} reviewed={stop.reviewed} size={sheet ? 'stream' : 'rail'} />
                </View>
                <View style={styles.rowText}>
                    <Text style={[styles.title, sheet ? styles.titleSheet : null, on ? styles.titleOn : null]}>{stop.title}</Text>
                    {stop.fileCue ? <Text style={[styles.cue, sheet ? styles.cueSheet : null]} numberOfLines={1}>{stop.fileCue}</Text> : null}
                </View>
                {props.stopAccessory ? <View style={styles.accessory}>{props.stopAccessory(stop.id)}</View> : null}
        </HappierPressable>
    );
}

function WalkthroughContentsCount(props: Readonly<{ source?: WalkthroughReviewedSource; count: number | null; total: number; sheet: boolean }>) {
    const count = useWalkthroughReviewedCount(props.source, props.count ?? 0);
    const caption = props.count === null ? null : t('walkthrough.reviewedOfTotal', { count, total: props.total });
    return props.sheet ? caption ? <Text style={styles.sheetCount}>{caption}</Text> : null
        : <ScmComparisonRailCaption title={t('walkthrough.contents')} count={caption} countTestID="walkthrough-contents-count" />;
}

/** The reading order and the person's marks: the desktop rail and, on phones, the contents sheet. */
export const WalkthroughContents = React.memo(function WalkthroughContents(props: WalkthroughContentsProps) {
    const { theme } = useUnistyles();
    const sheet = props.placement === 'sheet';
    const rows = props.stops.map(stop => <WalkthroughContentsRow key={stop.id} stop={stop} source={props.reviewedSource}
        sheet={sheet} on={stop.id === props.currentStopId} onSelectStop={props.onSelectStop} stopAccessory={props.stopAccessory} />);
    const others = props.others.length > 0 ? (
        <>
            {sheet ? <Text style={styles.sheetSub}>{t('walkthrough.otherChanges')}</Text> : <View style={styles.separator} />}
            <HappierPressable
                testID="walkthrough-contents-others"
                accessibilityRole="link"
                accessibilityLabel={t('walkthrough.otherChanges')}
                onPress={() => props.onSelectOthers?.()}
                style={(state) => [styles.row, sheet ? styles.rowSheet : null, state.pressed ? styles.rowPressed : null]}
            >
                <View style={[sheet ? styles.numberSheet : styles.number, styles.othersMark]}>
                    <Icon name="stack" size={sheet ? 15 : 14} color={theme.colors.text.tertiary} />
                </View>
                <View style={styles.rowText}>
                    {sheet ? (
                        <>
                            <Text style={[styles.title, styles.titleSheet, styles.titleDim]} numberOfLines={1}>{otherCue(props.others, false)}</Text>
                            <Text style={[styles.cue, styles.cueSheet]} numberOfLines={1}>{t('walkthrough.otherChangesCue')}</Text>
                        </>
                    ) : (
                        <>
                            <Text style={[styles.title, styles.titleDim]}>{t('walkthrough.otherChanges')}</Text>
                            <Text style={styles.cue} numberOfLines={1}>{otherCue(props.others, true)}</Text>
                        </>
                    )}
                </View>
            </HappierPressable>
        </>
    ) : null;
    const count = <WalkthroughContentsCount source={props.reviewedSource} count={props.reviewedCount} total={props.stops.length} sheet={sheet} />;

    if (sheet) {
        return (
            <View testID="walkthrough-contents-sheet" style={styles.sheet}>
                <View style={styles.sheetHeader}>
                    <Text accessibilityRole="header" style={styles.sheetTitle}>{t('walkthrough.contents')}</Text>
                    <View style={styles.grow} />
                    {count}
                    {props.onDone ? (
                        <HappierPressable accessibilityRole="button" accessibilityLabel={t('walkthrough.done')} onPress={props.onDone} style={styles.done}>
                            <Text style={styles.doneText}>{t('walkthrough.done')}</Text>
                        </HappierPressable>
                    ) : null}
                </View>
                <ScrollView contentContainerStyle={styles.sheetRows}>
                    {rows}
                    {others}
                </ScrollView>
            </View>
        );
    }
    return (
        <View testID="walkthrough-contents-rail" style={styles.rail}>
            {count}
            <ScrollView style={styles.railScroll} contentContainerStyle={styles.railRows}>
                {rows}
                {others}
            </ScrollView>
            {Platform.OS === 'web' ? (
                <ScmComparisonRailKeys testID="walkthrough-contents-keys" keys={[
                    { commands: ['review.change.next', 'review.change.previous'], label: t('walkthrough.keys.move') },
                    { commands: ['review.change.keep'], label: t('walkthrough.keys.reviewed') },
                    { commands: ['review.change.ask'], label: t('walkthrough.keys.ask') },
                ]} />
            ) : null}
        </View>
    );
});

/** The contents rail's width (lab WT1-A: about a sixth of a desktop details column). */
export const WALKTHROUGH_RAIL_WIDTH_PX = 248;

const styles = StyleSheet.create((theme) => ({
    rail: {
        width: WALKTHROUGH_RAIL_WIDTH_PX,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderRightColor: theme.colors.border.default,
        paddingTop: theme.space.s12,
        paddingHorizontal: SCM_COMPARISON_RAIL_INSET_PX,
    },
    grow: { flex: 1 },
    railScroll: { flex: 1 },
    railRows: { gap: 1 },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s8, paddingVertical: theme.space.s6, paddingHorizontal: theme.space.s8, borderRadius: 8 },
    rowSheet: { paddingVertical: theme.space.s10, paddingHorizontal: theme.space.s20, borderRadius: 0, gap: 14 },
    rowOn: { backgroundColor: theme.colors.surface.selected },
    rowPressed: { backgroundColor: theme.colors.surface.pressed },
    number: { paddingTop: 1 },
    numberSheet: { paddingTop: 1 },
    othersMark: { width: 18, alignItems: 'center' },
    rowText: { flex: 1, minWidth: 0 },
    accessory: { paddingTop: theme.space.s6 },
    title: { ...Typography.variant('body', 'medium'),  color: theme.colors.text.primary,  },
    titleSheet: Typography.variant('label'),
    titleOn: { ...Typography.default('semiBold') },
    titleDim: { color: theme.colors.text.secondary },
    cue: { marginTop: 1, ...Typography.variant('meta'),  color: theme.colors.text.tertiary,  },
    cueSheet: Typography.variant('body'),
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border.default, marginVertical: theme.space.s10, marginHorizontal: theme.space.s8 },
    sheet: { maxHeight: '100%' },
    sheetHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: theme.space.s20, paddingTop: theme.space.s16, paddingBottom: theme.space.s10 },
    sheetTitle: { ...Typography.variant('heading'), color: theme.colors.text.primary },
    sheetCount: { ...Typography.variant('body', 'medium'), color: theme.colors.text.tertiary, marginRight: theme.space.s16,  },
    done: { paddingVertical: theme.space.s4 },
    doneText: { ...Typography.variant('heading'), color: theme.colors.text.link,  },
    sheetRows: { paddingBottom: theme.space.s24 },
    sheetSub: { ...Typography.variant('label', 'semiBold'), color: theme.colors.text.tertiary, paddingHorizontal: theme.space.s20, paddingTop: 14, paddingBottom: theme.space.s4,  },
}));
