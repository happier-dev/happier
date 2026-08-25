import * as React from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    INSTRUMENT_DURATIONS,
    staggerDelayForIndex,
    useMotionPreferences,
} from '@/components/instrument';
import { Item } from '@/components/ui/lists/Item';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Typography } from '@/constants/Typography';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

const DOT_SIZE = 8;
const HALO_SIZE = 16;
/** How far a row travels on entrance. Small enough to read as settling, not as a slide-in. */
const ENTRANCE_TRAVEL_PX = 6;

function detailForRow(row: BrowserLaunchpadRow, openDisabled: boolean): string {
    if (openDisabled && !row.disabledReason) {
        return t('browserLaunchpad.status.openUnavailable');
    }
    if (row.disabledReason) {
        return resolveReasonCopy({ reasonCode: row.disabledReason, kind: 'browserLaunchpad' }).message;
    }
    switch (row.section) {
        case 'running':
            return t('browserLaunchpad.status.ready');
        case 'managed':
            return t('browserLaunchpad.status.managed');
        case 'plugin':
            return t('browserLaunchpad.status.plugin');
        case 'recent':
            return t('browserLaunchpad.status.recent');
        case 'unavailable':
            return resolveReasonCopy({ reasonCode: row.detail ?? null, kind: 'browserLaunchpad' }).message;
    }
}

/**
 * A launcher row's subtitle is an ADDRESS for the two sources that carry one — a `host:port` for a
 * detected local service, a URL for a recent. Setting those in mono is what turns the section from
 * a list of names into a board you can scan by port; prose subtitles (plugin descriptions) stay in
 * the row's own face.
 */
function subtitleIsAddress(row: BrowserLaunchpadRow): boolean {
    return row.sourceKind === 'localService' || row.sourceKind === 'recent';
}

const stylesheet = StyleSheet.create((theme) => ({
    halo: {
        width: HALO_SIZE,
        height: HALO_SIZE,
        borderRadius: HALO_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    haloLive: {
        // The same soft success tint the services pane already computes for a live row, so the two
        // surfaces read as one status vocabulary rather than two greens.
        backgroundColor: theme.colors.state.success.background,
    },
    monoSubtitle: {
        ...Typography.mono(),
    },
}));

/**
 * Live/stale status dot for a launcher row.
 *
 * The pulse itself belongs to the canonical {@link StatusDot} (which owns the web stepped-CSS vs
 * native `Animated.loop` split, reduced motion, the hidden/backgrounded pause, and the
 * "an unnamed colour is decoration" accessibility rule). This wrapper only supplies the row's
 * liveness tone and the halo.
 */
function BrowserTargetStatusDot(props: Readonly<{ live: boolean; testID: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View style={[stylesheet.halo, props.live ? stylesheet.haloLive : null]}>
            <StatusDot
                testID={props.live ? `${props.testID}-dot-live` : `${props.testID}-dot-stale`}
                color={props.live ? theme.colors.state.success.foreground : theme.colors.text.tertiary}
                size={DOT_SIZE}
                isPulsing={props.live}
                accessibilityLabel={props.live
                    ? t('browserLaunchpad.status.ready')
                    : t('browserLaunchpad.status.recent')}
            />
        </View>
    );
}

// B-RC6: memoized so a referentially-stable `row` (preserved by stable row identity across polls)
// does not re-render the card on every preview poll — the launchpad stops flickering.
export const BrowserTargetCard = React.memo(function BrowserTargetCard(props: Readonly<{
    row: BrowserLaunchpadRow;
    onOpenTarget?: (row: BrowserLaunchpadRow) => void;
    openDisabled?: boolean;
    /** Position within its section; drives the staggered entrance. */
    entranceIndex?: number;
    /** Injected by `ItemGroup` when it clones its rows. Forwarded so grouped rows keep dividers. */
    showDivider?: boolean;
    testID: string;
}>): React.ReactElement {
    const motion = useMotionPreferences();
    const disabled = Boolean(props.openDisabled || props.row.disabledReason || !props.row.target);
    const live = props.row.section === 'running' && !disabled;

    // Entrance plays once per mount. `staggerDelayForIndex` is the kit's shared step and cap, so a
    // long section stops waiting rather than accumulating an unbounded delay.
    const entrance = useSharedValue(0);
    React.useEffect(() => {
        const delay = staggerDelayForIndex(props.entranceIndex ?? 0);
        if (motion.entrance.kind === 'crossfade') {
            entrance.value = withDelay(delay, withTiming(1, { duration: INSTRUMENT_DURATIONS.crossfadeMinimal }));
            return;
        }
        entrance.value = withDelay(delay, withSpring(1, motion.springs.standard));
        // Entrance is a mount-time contract; re-running it on a preference change would replay it
        // under the user's cursor.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const entranceStyle = useAnimatedStyle(() => ({
        opacity: entrance.value,
        transform: [{ translateY: (1 - entrance.value) * ENTRANCE_TRAVEL_PX }],
    }));

    return (
        <Animated.View style={entranceStyle}>
            <Item
                testID={props.testID}
                title={props.row.title}
                subtitle={props.row.subtitle}
                subtitleStyle={subtitleIsAddress(props.row) ? stylesheet.monoSubtitle : undefined}
                detail={detailForRow(props.row, props.openDisabled === true)}
                detailTestID={disabled ? `${props.testID}-disabled` : `${props.testID}-available`}
                leftElement={<BrowserTargetStatusDot live={live} testID={props.testID} />}
                disabled={disabled}
                mode="interactive"
                showChevron={!disabled}
                showDivider={props.showDivider}
                onPress={() => {
                    if (!disabled) {
                        props.onOpenTarget?.(props.row);
                    }
                }}
            />
        </Animated.View>
    );
});
