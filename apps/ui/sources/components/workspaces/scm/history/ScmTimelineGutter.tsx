import * as React from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

export type ScmTimelinePointTone = 'now' | 'local' | 'shared' | 'incoming' | 'head' | 'landed';

/** The time column's width: "10:44", "10:44 AM", "Mon", "26 Sep" fit on one line at the meta step (Git lab: 52). */
const WHEN_COLUMN_WIDTH_PX = 52;
const RAIL_COLUMN_WIDTH_PX = 22;
const POINT_PX = 9;

/**
 * The leading gutter of a history item (user ruling 2026-09-29): when it happened on the left, then
 * its point on the rail that joins the items. Commit history and stashes both read as one timeline;
 * the row owns its content, this owns only the time and the point.
 */
export const ScmTimelineGutter = React.memo(function ScmTimelineGutter(props: Readonly<{
    /** Already formatted ("10:44", "Mon", "26 Sep"); empty keeps the column. */
    when: string;
    /** The point's top offset, so it sits level with the item's first line. */
    pointTopPx: number;
    /** The newest or current item (HEAD): a filled point. Shorthand for `tone="head"`. */
    emphasized?: boolean;
    /**
     * What the point says about the item (Git lab timeline): `now` the uncommitted work (warm, filled),
     * `local` only on this machine (hollow), `shared` already on origin (filled, quiet), `incoming` on origin
     * but not here yet (link, hollow, dashed rail), `head`/`landed` the newest item or one that just landed (link, filled).
     */
    tone?: ScmTimelinePointTone;
    showLeadingLine?: boolean;
    showTrailingLine?: boolean;
    /** The rail below reads as not-yet-here (incoming commits). */
    dashedTrailingLine?: boolean;
    /** Only the rail passes here (a marker between items, such as origin's). */
    hidePoint?: boolean;
    /**
     * The point just became filled (pushed, pulled): its fill rises in after this delay (Git lab SX staggered fills).
     * Omitted: drawn at rest.
     */
    fillDelayMs?: number;
    /** The landed point's ring waits this long (the commit chip is still travelling). */
    ringDelayMs?: number;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const tone: ScmTimelinePointTone = props.tone ?? (props.emphasized ? 'head' : 'local');
    const pointColor = tone === 'now'
        ? theme.colors.state.warning.foreground
        : tone === 'head' || tone === 'landed' || tone === 'incoming'
            ? theme.colors.text.link
            : tone === 'shared' ? theme.colors.text.secondary : theme.colors.text.tertiary;
    const filled = tone === 'now' || tone === 'head' || tone === 'landed' || tone === 'shared';
    return (
        <View testID={props.testID} style={styles.gutter} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Text numberOfLines={1} style={[styles.when, { marginTop: props.pointTopPx - 4 }]}>{props.when}</Text>
            <View style={styles.rail}>
                {props.showLeadingLine ? <View style={[styles.line, { top: 0, height: props.pointTopPx }]} /> : null}
                {props.hidePoint ? null : <View
                    style={[
                        styles.point,
                        { marginTop: props.pointTopPx, borderColor: pointColor },
                        tone === 'incoming' ? styles.pointIncoming : null,
                    ]}
                >
                    {filled ? <PointFill color={pointColor} delayMs={props.fillDelayMs} /> : null}
                </View>}
                {(tone === 'now' || tone === 'landed') && !props.hidePoint ? <View pointerEvents="none" style={{ position: 'absolute', top: props.pointTopPx - 3, width: POINT_PX + 6, height: POINT_PX + 6, borderRadius: (POINT_PX + 6) / 2, borderWidth: 2, borderColor: pointColor, opacity: 0.25 }} /> : null}
                {tone === 'landed' && !props.hidePoint ? <LandedRing topPx={props.pointTopPx} color={pointColor} delayMs={props.ringDelayMs ?? 0} /> : null}
                {props.showTrailingLine ? (
                    <View style={[styles.line, props.dashedTrailingLine ? styles.lineDashed : null, { top: props.hidePoint ? props.pointTopPx : props.pointTopPx + POINT_PX, bottom: 0 }]} />
                ) : null}
            </View>
        </View>
    );
});

/**
 * Git lab SX "Land": the item that just landed rings once (scale 1 → 1.8, fading out, one time). Nothing under
 * reduced motion — the filled point already says it.
 */
function LandedRing(props: Readonly<{ topPx: number; color: string; delayMs: number }>) {
    const reducedMotion = useReducedMotionPreference();
    const progress = useSharedValue(0);
    const { delayMs } = props;
    React.useEffect(() => {
        if (reducedMotion) return;
        progress.value = withDelay(delayMs, withTiming(1, { duration: motionTokens.successMoment.ringMs, easing: reanimatedMotionTokens.easing.standard }));
    }, [delayMs, progress, reducedMotion]);
    const style = useAnimatedStyle(() => ({
        opacity: 0.35 * (1 - progress.value),
        transform: [{ scale: 1 + 0.8 * progress.value }],
    }));
    if (reducedMotion) return null;
    return (
        <Animated.View
            pointerEvents="none"
            style={[{ position: 'absolute', top: props.topPx, width: POINT_PX, height: POINT_PX, borderRadius: POINT_PX / 2, backgroundColor: props.color }, style]}
        />
    );
}

/**
 * A point's fill. At rest it is simply there; when the point has just become filled (`delayMs` given) it rises in
 * after the delay — bottom-up after a push, top-down after a pull — and under reduced motion every fill cross-fades
 * together.
 */
function PointFill(props: Readonly<{ color: string; delayMs?: number }>) {
    const reducedMotion = useReducedMotionPreference();
    const opacity = useSharedValue(props.delayMs === undefined ? 1 : 0);
    const { delayMs } = props;
    React.useEffect(() => {
        if (delayMs === undefined) return;
        const moment = motionTokens.successMoment;
        opacity.value = 0;
        opacity.value = reducedMotion
            ? withTiming(1, { duration: moment.reducedCrossFadeMs })
            : withDelay(delayMs, withTiming(1, { duration: moment.fillMs, easing: reanimatedMotionTokens.easing.standard }));
    }, [delayMs, opacity, reducedMotion]);
    const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
    return <Animated.View style={[{ position: 'absolute', top: -1.5, left: -1.5, right: -1.5, bottom: -1.5, borderRadius: POINT_PX / 2, backgroundColor: props.color }, style]} />;
}

const stylesheet = StyleSheet.create((theme) => ({
    gutter: {
        flexDirection: 'row',
        alignSelf: 'stretch',
        flexShrink: 0,
    },
    when: {
        ...Typography.default(),
        width: WHEN_COLUMN_WIDTH_PX,
        fontSize: 11,
        lineHeight: 16,
        textAlign: 'right',
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    rail: {
        width: RAIL_COLUMN_WIDTH_PX,
        alignItems: 'center',
        position: 'relative',
    },
    line: {
        position: 'absolute',
        width: StyleSheet.hairlineWidth * 2,
        backgroundColor: theme.colors.border.strong,
    },
    lineDashed: {
        backgroundColor: 'transparent',
        borderLeftWidth: StyleSheet.hairlineWidth * 2,
        borderStyle: 'dashed',
        borderColor: theme.colors.text.link,
    },
    pointIncoming: {
        borderStyle: 'dashed',
    },
    point: {
        width: POINT_PX,
        height: POINT_PX,
        borderRadius: POINT_PX / 2,
        borderWidth: 1.5,
        backgroundColor: theme.colors.surface.base,
        zIndex: 1,
    },
}));
