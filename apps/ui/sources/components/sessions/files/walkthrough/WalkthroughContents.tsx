import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { WalkthroughStopNumber } from './WalkthroughAtoms';
import type { WalkthroughOtherChange, WalkthroughStop } from './walkthroughReading';

export type WalkthroughContentsProps = Readonly<{
    stops: readonly WalkthroughStop[];
    others: readonly WalkthroughOtherChange[];
    reviewedCount: number | null;
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

/** The reading order and the person's marks: the desktop rail and, on phones, the contents sheet. */
export const WalkthroughContents = React.memo(function WalkthroughContents(props: WalkthroughContentsProps) {
    const { theme } = useUnistyles();
    const sheet = props.placement === 'sheet';
    const rows = props.stops.map((stop) => {
        const on = stop.id === props.currentStopId;
        return (
            <HappierPressable
                key={stop.id}
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
    });
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
    const total = props.stops.length;
    const caption = props.reviewedCount === null ? null : t('walkthrough.reviewedOfTotal', { count: props.reviewedCount, total });

    if (sheet) {
        return (
            <View testID="walkthrough-contents-sheet" style={styles.sheet}>
                <View style={styles.sheetHeader}>
                    <Text accessibilityRole="header" style={styles.sheetTitle}>{t('walkthrough.contents')}</Text>
                    <View style={styles.grow} />
                    {caption ? <Text style={styles.sheetCount}>{caption}</Text> : null}
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
            <View style={styles.caption}>
                <Text style={styles.captionTitle}>{t('walkthrough.contents')}</Text>
                <View style={styles.grow} />
                {caption ? <Text testID="walkthrough-contents-count" style={styles.captionCount}>{caption}</Text> : null}
            </View>
            <ScrollView style={styles.railScroll} contentContainerStyle={styles.railRows}>
                {rows}
                {others}
            </ScrollView>
            {Platform.OS === 'web' ? (
                <View testID="walkthrough-contents-keys" style={styles.keys}>
                    <View style={styles.key}><KeyHint label="J" /><KeyHint label="K" /><Text style={styles.keyText}>{t('walkthrough.keys.move')}</Text></View>
                    <View style={styles.key}><KeyHint label="R" /><Text style={styles.keyText}>{t('walkthrough.keys.reviewed')}</Text></View>
                    <View style={styles.key}><KeyHint label="/" /><Text style={styles.keyText}>{t('walkthrough.keys.ask')}</Text></View>
                </View>
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
        paddingTop: 18,
        paddingBottom: 12,
    },
    caption: { flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 18, paddingBottom: 8 },
    captionTitle: { fontSize: 12, color: theme.colors.text.secondary, ...Typography.default('semiBold') },
    captionCount: { fontSize: 12, color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'], ...Typography.default('medium') },
    grow: { flex: 1 },
    railScroll: { flex: 1 },
    railRows: { paddingHorizontal: 10, gap: 1 },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, paddingVertical: 7, paddingHorizontal: 8, borderRadius: 8 },
    rowSheet: { paddingVertical: 11, paddingHorizontal: 20, borderRadius: 0, gap: 14 },
    rowOn: { backgroundColor: theme.colors.surface.selected },
    rowPressed: { backgroundColor: theme.colors.surface.pressed },
    number: { paddingTop: 1 },
    numberSheet: { paddingTop: 1 },
    othersMark: { width: 18, alignItems: 'center' },
    rowText: { flex: 1, minWidth: 0 },
    accessory: { paddingTop: 7 },
    title: { fontSize: 13, lineHeight: 18, color: theme.colors.text.primary, ...Typography.default('medium') },
    titleSheet: { fontSize: 16, lineHeight: 22 },
    titleOn: { ...Typography.default('semiBold') },
    titleDim: { color: theme.colors.text.secondary },
    cue: { marginTop: 1, fontSize: 12, lineHeight: 16, color: theme.colors.text.tertiary, ...Typography.default() },
    cueSheet: { fontSize: 13.5, lineHeight: 19 },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border.default, marginVertical: 10, marginHorizontal: 8 },
    keys: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 10, rowGap: 6, paddingHorizontal: 18, paddingTop: 8 },
    key: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    keyText: { fontSize: 12, color: theme.colors.text.tertiary, ...Typography.default() },
    sheet: { maxHeight: '100%' },
    sheetHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 10 },
    sheetTitle: { fontSize: 19, color: theme.colors.text.primary, ...Typography.default('semiBold') },
    sheetCount: { fontSize: 13.5, color: theme.colors.text.tertiary, marginRight: 16, ...Typography.default('medium') },
    done: { paddingVertical: 4 },
    doneText: { fontSize: 16, color: theme.colors.text.link, ...Typography.default('semiBold') },
    sheetRows: { paddingBottom: 24 },
    sheetSub: { fontSize: 14, color: theme.colors.text.tertiary, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 4, ...Typography.default('semiBold') },
}));
