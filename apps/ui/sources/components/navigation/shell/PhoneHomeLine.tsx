import * as React from 'react';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ConnectionStatusTriggerState } from '@/components/navigation/ConnectionStatusControl';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

const styles = StyleSheet.create((theme) => ({
    homeLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        alignSelf: 'flex-start',
        minWidth: 0,
        flexShrink: 1,
    },
    homeLineText: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
}));

/**
 * The Sessions tab has no bar of its own (calm-shell `clviews:recentP`): its column draws one nav row —
 * this Home line, the column's view switch, search and View, then these glyphs — above the large "My work".
 * Tapping the Home line opens the Home/account popover in place, below it (its chevron says so); Activity and the shortcuts menu (Search, Workflows,
 * Artifacts, Bots and every destination the tab bar does not show) follow. New sessions start from the
 * glass "+" beside the tab bar.
 */
export function PhoneHomeLine(props: Readonly<{ state: ConnectionStatusTriggerState }>) {
    const { state } = props;
    const { theme } = useUnistyles();
    const ink = state.needsAttention ? state.statusColor : theme.colors.text.secondary;
    // The line keeps its text height; a finger reaches 44 through the shared hit area.
    return (
        <HappierPressable
            testID="main-header-home-line"
            accessibilityRole="button"
            accessibilityLabel={state.accessibilityLabel}
            expanded={state.open}
            hasPopup="dialog"
            onPress={state.activate}
            // Free space above (the row's own padding). The large title starts 9 px under the line and its own
            // hit area reaches 4 px up, so the line takes the other half and the two never overlap.
            hitReach={{ top: 12, bottom: 4 }}
            style={styles.homeLine}
        >
            {/* Healthy is quiet: the dot carries the status; only a Home that needs you tints its name. */}
            {state.needsAttention
                ? <Icon name="warning" size={ICON_SIZE.xs} color={state.statusColor} />
                : <StatusDot color={state.statusColor} isPulsing={state.connecting} size={6} />}
            <Text numberOfLines={1} style={[styles.homeLineText, state.needsAttention ? { color: state.statusColor } : null]}>
                {state.homeLabel}
            </Text>
            <Icon name={state.open ? 'caret-up' : 'caret-down'} size={ICON_SIZE.xs} color={ink} />
        </HappierPressable>
    );
}
