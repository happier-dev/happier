import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionManagedSessionsPresentationV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { readSessionLiveManagedSessionCountV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
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
        gap: theme.space.s4,
        marginRight: theme.space.s2,
    },
    needsYou: {
        ...Typography.tabular(),
        ...Typography.variant('micro', 'semiBold'),
        color: theme.colors.state.warning.foreground,
    },
    working: {
        ...Typography.tabular(),
        ...Typography.variant('micro'),
        color: theme.colors.text.secondary,
    },
    total: {
        ...Typography.tabular(),
        ...Typography.variant('meta'),
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

export function hasSessionRowReportsChip(reports: Session['managedSessions'] | undefined): boolean {
    if (!reports) return false;
    return readSessionManagedSessionsPresentationV1(reports).count > 0;
}

export const SessionRowReportsChip = React.memo((props: Readonly<{
    sessionId: string;
    occurrenceId?: string;
    reports: NonNullable<Session['managedSessions']>;
    /** Its reports are folded under the row: say how many, quietly, and keep any needs-you dot. */
    collapsed?: boolean;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const status = readSessionManagedSessionsPresentationV1(props.reports);
    const needsYou = status.bucket === 'needs_you' ? status.count : 0;
    // Archived reports stay in the lead's record but are not sub-sessions a person can open from here.
    const liveReports = readSessionLiveManagedSessionCountV1(props.reports);
    if (props.collapsed && liveReports > 0) {
        return (
            <View
                testID={`session-row-reports-chip:${props.occurrenceId ?? props.sessionId}`}
                accessible
                accessibilityLabel={needsYou > 0
                    ? t('sessionWork.list.reportsNeedYou', { count: needsYou })
                    : t('sessionWork.list.subSessions', { count: liveReports })}
                style={styles.chip}
            >
                <Text style={styles.total}>{liveReports}</Text>
                {needsYou > 0 ? <StatusDot color={theme.colors.state.warning.foreground} /> : null}
            </View>
        );
    }
    if (needsYou > 0) {
        return (
            <View
                testID={`session-row-reports-chip:${props.occurrenceId ?? props.sessionId}`}
                accessible
                accessibilityLabel={t('sessionWork.list.reportsNeedYou', { count: needsYou })}
                style={styles.chip}
            >
                <StatusDot color={theme.colors.state.warning.foreground} />
                <Text style={styles.needsYou}>{needsYou}</Text>
            </View>
        );
    }
    if (status.count <= 0) return null;
    return (
        <View testID={`session-row-reports-chip:${props.occurrenceId ?? props.sessionId}`} style={styles.chip}>
            <Text numberOfLines={1} style={styles.working}>{status.bucket === 'working'
                ? t('sessionWork.list.reportsWorking', { count: status.count })
                : `${status.count} · ${t('status.offline')}`}</Text>
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
    occurrenceId?: string;
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
            testID={`session-row-reports-disclosure:${props.occurrenceId ?? props.sessionId}`}
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
