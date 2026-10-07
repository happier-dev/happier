import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { PluginUiToneV1 } from '@happier-dev/protocol/plugins/ui';

import { formatBadgeCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { APP_RAIL_BADGE } from './appRailMetrics';

/**
 * `attention`: something needs the person's action (the attention amber). `accent`: news worth a look
 * (strong ink). `neutral`: a quiet fact (muted ink). Blue is reserved for focus and links, rose for failure.
 */
export type AppRailBadgeTone = 'attention' | 'accent' | 'neutral';

export type AppRailBadgeSignal =
    | Readonly<{ kind: 'count'; value: number; tone: AppRailBadgeTone }>
    /** Attention (or news) without a number. */
    | Readonly<{ kind: 'dot'; tone: AppRailBadgeTone }>;

/** The one tone mapping for rail badges: amber only for what needs action. */
export function resolveAppRailBadgeTone(
    source:
        | Readonly<{ source: 'inbox' }>
        /** Connected accounts that need a new sign-in (never low limits). */
        | Readonly<{ source: 'signIn' }>
        | Readonly<{ source: 'updates'; failed: boolean }>
        | Readonly<{ source: 'plugin'; tone: PluginUiToneV1 }>,
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
    }
}

/**
 * The rail's one badge: a count or a dot at the glyph box's top-right (`APP_RAIL_BADGE`), one size and
 * type, a tone from `resolveAppRailBadgeTone`, and a ring in the rail's colour that separates it from
 * the glyph. Rendered inside a rail slot; it takes no pointer events.
 */
export const AppRailBadge = React.memo(function AppRailBadge(props: Readonly<{ signal: AppRailBadgeSignal; testID?: string }>) {
    const styles = stylesheet;
    const tone = props.signal.tone === 'attention'
        ? styles.attention
        : props.signal.tone === 'accent' ? styles.accent : styles.neutral;
    if (props.signal.kind === 'dot') {
        return <View pointerEvents="none" testID={props.testID} style={[styles.anchor, styles.dot, tone]} />;
    }
    return (
        <View pointerEvents="none" testID={props.testID} style={[styles.anchor, styles.count, tone]}>
            <Text style={styles.countText} numberOfLines={1}>
                {formatBadgeCount(props.signal.value)}
            </Text>
        </View>
    );
});

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
