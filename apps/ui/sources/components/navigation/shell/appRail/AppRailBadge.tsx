import * as React from 'react';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import type { PluginUiToneV1 } from '@happier-dev/protocol/plugins/ui';

import { formatBadgeCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { Text } from '@/components/ui/text/Text';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { APP_RAIL_BADGE, APP_RAIL_BADGE_OVERLAP_PX } from './appRailMetrics';

/**
 * `attention`: something needs the person's action (the attention amber). `accent`: news worth a look
 * (strong ink). `neutral`: a quiet fact (muted ink). Blue is reserved for focus and links, rose for failure.
 */
export type AppRailBadgeTone = 'attention' | 'accent' | 'neutral';

export type AppRailBadgeSignal =
    | Readonly<{ kind: 'count'; value: number; tone: AppRailBadgeTone }>
    /** Attention (or news) without a number. */
    | Readonly<{ kind: 'dot'; tone: AppRailBadgeTone }>;

/** A folded rail keeps the strongest signal, never a sum of unrelated domain counts. */
export function resolveStrongestAppRailBadge(signals: readonly (AppRailBadgeSignal | null)[]): AppRailBadgeSignal | null {
    for (const tone of ['attention', 'accent', 'neutral'] as const) {
        const candidates = signals.filter((signal): signal is AppRailBadgeSignal => signal?.tone === tone
            && (signal.kind === 'dot' || signal.value > 0));
        if (candidates.length === 0) continue;
        const counts = candidates.filter((signal): signal is Extract<AppRailBadgeSignal, { kind: 'count' }> => signal.kind === 'count');
        return counts.length > 0 ? counts.reduce((strongest, signal) => signal.value > strongest.value ? signal : strongest) : candidates[0]!;
    }
    return null;
}

export type RailBadgeSignalRenderer = (signal: AppRailBadgeSignal | null) => React.ReactNode;

/** The one tone mapping for rail badges: amber only for what needs action. */
export function resolveAppRailBadgeTone(
    source:
        | Readonly<{ source: 'inbox' }>
        /** Connected accounts that need a new sign-in (never low limits). */
        | Readonly<{ source: 'signIn' }>
        | Readonly<{ source: 'updates'; failed: boolean }>
        | Readonly<{ source: 'plugin'; tone: PluginUiToneV1 }>
        /** A machine that needs you (counted) or is worth a look (dot) is amber; the guard having acted is muted. */
        | Readonly<{ source: 'machines'; level: 'needs_you' | 'look' | 'guard' }>,
): AppRailBadgeTone {
    switch (source.source) {
        case 'inbox':
        case 'signIn':
            return 'attention';
        case 'updates':
            return source.failed ? 'attention' : 'accent';
        case 'plugin':
            return source.tone === 'danger' || source.tone === 'warning'
                ? 'attention'
                : source.tone === 'neutral' ? 'neutral' : 'accent';
        case 'machines':
            return source.level === 'guard' ? 'neutral' : 'attention';
    }
}

/**
 * The rail's one badge: a count or a dot at the glyph box's top-right (`APP_RAIL_BADGE`), one size and
 * type, a tone from `resolveAppRailBadgeTone`, and a ring in the rail's colour that separates it from
 * the glyph. Rendered inside a rail slot; it takes no pointer events.
 */
export const AppRailBadge = React.memo(function AppRailBadge(props: Readonly<{
    signal: AppRailBadgeSignal;
    /**
     * A chrome glyph outside the rail (Activity in the title strip): the badge anchors to that glyph's own
     * box instead of a rail slot, at the same overlap, so the two read as one family.
     */
    glyphSizePx?: number;
    /**
     * With `glyphSizePx`: the glyph corner the badge marks. A Bot face carries its dot bottom-right
     * (`BotFaceMarker`), clear of the face's eyes; every other glyph keeps the top-right default.
     */
    corner?: 'topRight' | 'bottomRight';
    /** The plane the glyph stands on, when it is not the rail's (the black island). */
    ringColor?: string;
    testID?: string;
}>) {
    const styles = stylesheet;
    const appear = useBadgeAppear();
    const tone = props.signal.tone === 'attention'
        ? styles.attention
        : props.signal.tone === 'accent' ? styles.accent : styles.neutral;
    const anchor = props.glyphSizePx === undefined ? styles.anchor
        : [styles.anchor, {
            left: props.glyphSizePx - APP_RAIL_BADGE_OVERLAP_PX,
            top: props.corner === 'bottomRight' ? props.glyphSizePx - APP_RAIL_BADGE_OVERLAP_PX : -APP_RAIL_BADGE_OVERLAP_PX,
            ...(props.ringColor ? { borderColor: props.ringColor } : null),
        }];
    if (props.signal.kind === 'dot') {
        return <Animated.View pointerEvents="none" testID={props.testID} style={[anchor, styles.dot, tone, appear]} />;
    }
    return (
        <Animated.View pointerEvents="none" testID={props.testID} style={[anchor, styles.count, tone, appear]}>
            <Text style={styles.countText} numberOfLines={1}>
                {formatBadgeCount(props.signal.value)}
            </Text>
        </Animated.View>
    );
});

/** The badge arrives in 160 ms, fading in from 0.8 scale (MPG-32); under reduced motion it is simply there. */
const BADGE_APPEAR_MS = 160;
const BADGE_APPEAR_FROM_SCALE = 0.8;

function useBadgeAppear() {
    const reducedMotion = useReducedMotionPreference();
    const progress = useSharedValue(reducedMotion ? 1 : 0);
    React.useEffect(() => {
        if (reducedMotion) {
            progress.value = 1;
            return;
        }
        progress.value = withTiming(1, { duration: BADGE_APPEAR_MS, easing: reanimatedMotionTokens.easing.standard });
    }, [progress, reducedMotion]);
    return useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ scale: BADGE_APPEAR_FROM_SCALE + (1 - BADGE_APPEAR_FROM_SCALE) * progress.value }],
    }));
}

/**
 * The same signal on a row of the rail's More menu (a rail slot that moved there): a count in the
 * menu row's trailing slot, from the same tone mapping. Menu rows have no strong-ink badge, so news
 * reads as the quiet count there.
 */
export function AppRailMenuCount(props: Readonly<{ value: number; tone: AppRailBadgeTone }>) {
    return <TabBadge variant="count" tone={props.tone === 'attention' ? 'attention' : 'neutral'} value={props.value} />;
}

const RINGED_COUNT_PX = APP_RAIL_BADGE.countSizePx + 2 * APP_RAIL_BADGE.ringPx;
const RINGED_DOT_PX = APP_RAIL_BADGE.dotSizePx + 2 * APP_RAIL_BADGE.ringPx;

const stylesheet = StyleSheet.create((theme) => ({
    anchor: {
        position: 'absolute',
        left: APP_RAIL_BADGE.anchorLeftPx,
        top: APP_RAIL_BADGE.anchorTopPx,
        borderWidth: APP_RAIL_BADGE.ringPx,
        // The rail's own plane, so the badge sits clear of the glyph.
        borderColor: theme.colors.background.canvas,
    },
    count: {
        height: RINGED_COUNT_PX,
        minWidth: RINGED_COUNT_PX,
        borderRadius: RINGED_COUNT_PX / 2,
        paddingHorizontal: 3,
        alignItems: 'center',
        justifyContent: 'center',
    },
    dot: {
        width: RINGED_DOT_PX,
        height: RINGED_DOT_PX,
        borderRadius: RINGED_DOT_PX / 2,
    },
    attention: {
        backgroundColor: theme.colors.state.attention.foreground,
    },
    accent: {
        backgroundColor: theme.colors.text.primary,
    },
    neutral: {
        backgroundColor: theme.colors.text.tertiary,
    },
    countText: {
        ...Typography.default('semiBold'),
        fontSize: APP_RAIL_BADGE.countFontSizePx,
        lineHeight: APP_RAIL_BADGE.countSizePx,
        fontVariant: ['tabular-nums'],
        // Knocked out of the fill in the surface colour (the attention amber is asserted AA under it).
        color: theme.colors.surface.base,
    },
}));
