import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

/**
 * The lead row's sub-session chip (ORC §3.8, D-S4; lab `session-H`): what its direct reports are doing,
 * read from the server's awareness `reports` count — never from the rows the list happens to hold.
 *
 * Quiet unless a report needs the person (an amber dot and the count, like every "needs you" in the
 * list); otherwise how many are still working; nothing once they have all settled.
 */

const stylesheet = StyleSheet.create((theme) => ({
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginRight: 2,
    },
    needsYou: {
        ...Typography.default('semiBold'),
        ...Typography.tabular(),
        fontSize: 11,
        color: theme.colors.state.warning.foreground,
    },
    working: {
        ...Typography.default(),
        ...Typography.tabular(),
        fontSize: 10,
        color: theme.colors.text.secondary,
    },
    total: {
        ...Typography.default(),
        ...Typography.tabular(),
        fontSize: 12,
        color: theme.colors.text.tertiary,
    },
    // The caret sits in the row's leading edge, tight against the identity (lab `.cm-car`).
    disclosure: {
        alignSelf: 'center',
        width: 16,
        height: 24,
        marginLeft: -6,
        marginRight: -2,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export function hasSessionRowReportsChip(reports: Session['reports'] | undefined): boolean {
    if (!reports) return false;
    return reports.needsYou > 0 || reports.working + reports.stalled > 0;
}

export const SessionRowReportsChip = React.memo((props: Readonly<{
    sessionId: string;
    reports: NonNullable<Session['reports']>;
    /** Its reports are folded under the row: say how many, quietly, and keep any needs-you dot. */
    collapsed?: boolean;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { needsYou, working, stalled } = props.reports;
    if (props.collapsed && props.reports.total > 0) {
        return (
            <View
                testID={`session-row-reports-chip:${props.sessionId}`}
                accessible
                accessibilityLabel={needsYou > 0
                    ? t('sessionWork.list.reportsNeedYou', { count: needsYou })
                    : t('sessionWork.list.subSessions', { count: props.reports.total })}
                style={styles.chip}
            >
                <Text style={styles.total}>{props.reports.total}</Text>
                {needsYou > 0 ? <StatusDot color={theme.colors.state.warning.foreground} /> : null}
            </View>
        );
    }
    if (needsYou > 0) {
        return (
            <View
                testID={`session-row-reports-chip:${props.sessionId}`}
                accessible
                accessibilityLabel={t('sessionWork.list.reportsNeedYou', { count: needsYou })}
                style={styles.chip}
            >
                <StatusDot color={theme.colors.state.warning.foreground} />
                <Text style={styles.needsYou}>{needsYou}</Text>
            </View>
        );
    }
    const active = working + stalled;
    if (active <= 0) return null;
    return (
        <View testID={`session-row-reports-chip:${props.sessionId}`} style={styles.chip}>
            <Text numberOfLines={1} style={styles.working}>{t('sessionWork.list.reportsWorking', { count: active })}</Text>
        </View>
    );
});

/**
 * The lead row's reports disclosure (lab `b-launch N/Np`, D43 (3)): the caret shows or hides the reports
 * nested under it. It writes the explicit local fold choice, which wins over a Bot's folded default, so a
 * folded subtree is always one press away. The row's own press still opens the Session.
 */
export const SessionRowReportsDisclosure = React.memo(function SessionRowReportsDisclosure(props: Readonly<{
    sessionId: string;
    nodeId: string;
    name: string;
    count: number;
    collapsed: boolean;
    onSetCollapsed: (nodeId: string, collapsed: boolean) => void;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { nodeId, collapsed, onSetCollapsed } = props;
    const toggle = React.useCallback(() => onSetCollapsed(nodeId, !collapsed), [collapsed, nodeId, onSetCollapsed]);
    return (
        <HappierPressable
            testID={`session-row-reports-disclosure:${props.sessionId}`}
            accessibilityRole="button"
            expanded={!collapsed}
            accessibilityLabel={collapsed
                ? t('sessionWork.list.showReports', { name: props.name, count: props.count })
                : t('sessionWork.list.hideReports', { name: props.name })}
            hitSlop={8}
            onPress={toggle}
            style={styles.disclosure}
        >
            <Icon name={collapsed ? 'caret-right' : 'caret-down'} size={11} color={theme.colors.text.tertiary} />
        </HappierPressable>
    );
});
