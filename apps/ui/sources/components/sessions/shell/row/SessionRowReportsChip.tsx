import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { CapacityRing } from '@/components/ui/progress/CapacityRing';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionManagedSessionsPresentationV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { readSessionLiveManagedSessionCountV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';
import { presentSessionAwarenessStateV1 } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';

/**
 * The lead row's sub-session chip (ORC §3.8, D-S4; lab `session-H`): what its direct reports are doing,
 * read from the server's awareness `reports` count — never from the rows the list happens to hold.
 *
 * The canonical aggregate status remains visible independently of the count of reports that need
 * the person, including unseen failures and news whose exact count is not projected.
 */

const DISCLOSURE_WIDTH_PX = 14;
/** How far the hit area reaches past the caret's box into the row's leading edge. */
const DISCLOSURE_LEADING_PAD_PX = 6;
/**
 * The identity follows the caret with no gap, and the row's own press must keep it: the hit area reaches
 * only backwards, into the leading padding nothing else presses and the row's edge bounds; never forwards,
 * above or below. That is 20 px wide against the 24 px floor, which the caret's position cannot meet
 * without moving the identity.
 */
const DISCLOSURE_HIT_REACH = { top: 0, bottom: 0, right: 0, left: DISCLOSURE_LEADING_PAD_PX } as const;

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
        // Text takes the warning text role; the fill amber stays on the dot beside it.
        color: theme.colors.state.warning.textForeground,
    },
    total: {
        ...Typography.tabular(),
        ...Typography.variant('micro'),
        color: theme.colors.text.tertiary,
    },
    // The caret hangs in the row's leading padding, tight against the identity (lab `.cm-car`): the box ends
    // where the identity begins, so a lead with reports keeps its face on the same edge as every other row,
    // and its hit area takes the free space before it (`DISCLOSURE_HIT_REACH`).
    disclosure: {
        alignSelf: 'center',
        width: DISCLOSURE_WIDTH_PX,
        height: 24,
        marginLeft: -DISCLOSURE_WIDTH_PX,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

/** The chip speaks only while reports are in progress or one of them needs the person or failed (ruling 2026-11-01). */
export function hasSessionRowReportsChip(reports: Session['managedSessions'] | undefined): boolean {
    if (!reports) return false;
    const live = readSessionLiveManagedSessionCountV1(reports);
    return Math.min(Math.max(0, reports.finished), live) < live
        || resolveWorkStatusTone({ kind: 'session_reports', facts: { reports, word: '' } }).tone !== 'neutral';
}

const PROGRESS_RING_PX = 12;
const PROGRESS_STROKE_PX = 2;

/**
 * A lead row's progress over its sub-sessions (lab `clgroups` coordinator): a small ring and "3/5" while they are
 * in progress, nothing once they have settled (calm ruling 2026-11-01; the count stays in the caret's label and the
 * sub-sessions themselves). Healthy progress stays ink; a sub-session that needs the person or failed adds the
 * amber or rose dot, and the count waiting on them.
 */
export const SessionRowReportsChip = React.memo((props: Readonly<{
    sessionId: string;
    occurrenceId?: string;
    reports: NonNullable<Session['managedSessions']>;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const presentation = readSessionManagedSessionsPresentationV1(props.reports);
    const status = resolveWorkStatusTone({ kind: 'session_reports', facts: {
        reports: props.reports,
        word: presentation.state ? presentSessionAwarenessStateV1(presentation.state).statusText : '',
    } });
    const needsYou = props.reports.needsYou;
    const attention = status.tone !== 'neutral';
    // Archived reports stay in the lead's record but are not sub-sessions a person can open from here.
    const liveReports = readSessionLiveManagedSessionCountV1(props.reports);
    const finished = Math.min(Math.max(0, props.reports.finished), liveReports);
    const inProgress = finished < liveReports;
    if (!inProgress && !attention) return null;
    const accessibilityLabel = [
        status.word,
        needsYou > 0 ? t('sessionWork.list.reportsNeedYou', { count: needsYou }) : '',
        liveReports > 0 ? t('sessionWork.list.reportsDoneA11y', { finished, total: liveReports }) : '',
    ].filter(Boolean).join('. ');
    return (
        <View
            testID={`session-row-reports-chip:${props.occurrenceId ?? props.sessionId}`}
            accessible
            accessibilityLabel={accessibilityLabel}
            style={styles.chip}
        >
            {inProgress ? (
                <>
                    <CapacityRing
                        size={PROGRESS_RING_PX}
                        strokeWidth={PROGRESS_STROKE_PX}
                        ratio={finished / liveReports}
                        color={theme.colors.text.secondary}
                        trackColor={theme.colors.border.default}
                    />
                    <Text numberOfLines={1} style={styles.total}>
                        {`${finished}/${liveReports}`}
                    </Text>
                </>
            ) : null}
            {attention ? <StatusDot color={workStatusGlyphColor(theme.colors, status.tone)} size={7} /> : null}
            {attention && needsYou > 0 ? <Text style={styles.needsYou}>{needsYou}</Text> : null}
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
            hitTarget={HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE}
            hitReach={DISCLOSURE_HIT_REACH}
            onPress={toggle}
            style={styles.disclosure}
        >
            <DisclosureCaret expanded={!collapsed} size={11} />
        </HappierPressable>
    );
});
