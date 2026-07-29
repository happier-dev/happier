import * as React from 'react';
import { Animated, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

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

const stylesheet = StyleSheet.create((theme) => ({
    dotWrap: {
        width: 14,
        height: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    halo: {
        position: 'absolute',
        width: 14,
        height: 14,
        borderRadius: 7,
        backgroundColor: theme.colors.status.connected,
    },
    dotLive: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.status.connected,
    },
    dotStale: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.text.tertiary,
    },
}));

/**
 * Live/stale status dot for a launcher row. Running-section rows are live and pulse a soft halo;
 * everything else (recents, managed-but-not-running, unavailable/stale) shows a dim static dot.
 * Honors reduced-motion: the halo holds steady instead of animating.
 */
function BrowserTargetStatusDot(props: Readonly<{ live: boolean; testID: string }>): React.ReactElement {
    const reducedMotion = useReducedMotionPreference();
    const pulse = React.useRef(new Animated.Value(0)).current;

    React.useEffect(() => {
        if (!props.live || reducedMotion) {
            pulse.setValue(0);
            return;
        }
        const animation = Animated.loop(
            Animated.sequence([
                Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
                Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
            ]),
        );
        animation.start();
        return () => animation.stop();
    }, [props.live, pulse, reducedMotion]);

    if (!props.live) {
        return (
            <View style={stylesheet.dotWrap}>
                <View testID={`${props.testID}-dot-stale`} style={stylesheet.dotStale} />
            </View>
        );
    }

    return (
        <View style={stylesheet.dotWrap}>
            <Animated.View
                style={[
                    stylesheet.halo,
                    {
                        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.28, 0] }),
                        transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
                    },
                ]}
            />
            <View testID={`${props.testID}-dot-live`} style={stylesheet.dotLive} />
        </View>
    );
}

// B-RC6: memoized so a referentially-stable `row` (preserved by stable row identity across polls)
// does not re-render the card on every preview poll — the launchpad stops flickering.
export const BrowserTargetCard = React.memo(function BrowserTargetCard(props: Readonly<{
    row: BrowserLaunchpadRow;
    onOpenTarget?: (row: BrowserLaunchpadRow) => void;
    openDisabled?: boolean;
    testID: string;
}>): React.ReactElement {
    const disabled = Boolean(props.openDisabled || props.row.disabledReason || !props.row.target);
    const live = props.row.section === 'running' && !disabled;
    return (
        <Item
            testID={props.testID}
            title={props.row.title}
            subtitle={props.row.subtitle}
            detail={detailForRow(props.row, props.openDisabled === true)}
            detailTestID={disabled ? `${props.testID}-disabled` : `${props.testID}-available`}
            leftElement={<BrowserTargetStatusDot live={live} testID={props.testID} />}
            disabled={disabled}
            mode="interactive"
            showChevron={!disabled}
            onPress={() => {
                if (!disabled) {
                    props.onOpenTarget?.(props.row);
                }
            }}
        />
    );
});
