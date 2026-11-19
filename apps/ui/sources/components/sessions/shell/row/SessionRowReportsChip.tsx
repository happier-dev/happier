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
import type { SessionAwarenessProjectionV1 } from '@happier-dev/protocol/sessions/awareness/projectionV1';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';
import { presentSessionAwarenessStateV1 } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';

/**
 * A Session row's progress chip and a lead row's reports disclosure. The count is read from the awareness owner's
 * projection (and a lead's attention from the server's managed-Session counts), never from the rows the list holds.
 */

/**
 * The caret's box fits inside the narrowest row's leading padding (a phone sheet's roster pads 12), so the box
 * never hangs past the sheet's edge; the 11 px glyph still has room either side.
 */
const DISCLOSURE_WIDTH_PX = 12;
/** How far the hit area reaches past the caret's box into the row's leading edge. */
const DISCLOSURE_LEADING_PAD_PX = 8;
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

const PROGRESS_RING_PX = 12;
const PROGRESS_STROKE_PX = 2;

/** A Session's progress as the awareness owner projected it: explicit count > task list > managed Sessions. */
export type SessionRowProgress = NonNullable<SessionAwarenessProjectionV1['progress']>;

/** The managed Sessions' canonical aggregate status: spoken with the count, drawn (dot) only when it needs the person. */
function readReportsStatus(reports: Session['managedSessions'] | undefined) {
    if (!reports) return null;
    const presentation = readSessionManagedSessionsPresentationV1(reports);
    return resolveWorkStatusTone({ kind: 'session_reports', facts: {
        reports,
        word: presentation.state ? presentSessionAwarenessStateV1(presentation.state).statusText : '',
    } });
}

/** Whether managed Sessions need the person or failed: the lead's amber or rose dot and the count waiting on them. */
function readReportsAttention(reports: Session['managedSessions'] | undefined) {
    const status = readReportsStatus(reports);
    return status && status.tone !== 'neutral' ? status : null;
}

/** The chip's words, label first ("QA, 9 of 24 done"); the row's accessible name carries them too. */
export function describeSessionRowProgress(progress: SessionRowProgress): string {
    return t('sessionWork.list.progressA11y', { label: progress.label ?? '', done: progress.done, total: progress.total });
}

/** Whether a row draws the chip: a projected count, or managed Sessions that need the person or failed. */
export function hasSessionRowProgressChip(
    progress: SessionRowProgress | null | undefined,
    reports: Session['managedSessions'] | undefined,
): boolean {
    return Boolean(progress) || readReportsAttention(reports) !== null;
}

/**
 * A row's one count (lab ideas-1118-shell scene 7; the lead's reports chip, lab `clgroups`, for any Session): a small
 * ring and "3/7", with the author's short label when it set one ("QA 9/24"). It reads the awareness owner's progress,
 * so an explicit count, the task list and managed Sessions never show as two counts, and a completed count stays only
 * while the Session is unread (D1). Not working dims it. A lead whose managed Sessions need the person or failed adds
 * the amber or rose dot, and the count waiting on them.
 */
export const SessionRowProgressChip = React.memo((props: Readonly<{
    sessionId: string;
    occurrenceId?: string;
    progress: SessionRowProgress | null | undefined;
    runningWorkCount?: SessionAwarenessProjectionV1['runningWorkCount'];
    reports?: Session['managedSessions'];
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { progress } = props;
    const reportsStatus = readReportsStatus(props.reports);
    const attention = reportsStatus && reportsStatus.tone !== 'neutral' ? reportsStatus : null;
    if (!progress && !attention) return null;
    const needsYou = attention ? props.reports?.needsYou ?? 0 : 0;
    const accessibilityLabel = [
        progress ? describeSessionRowProgress(progress) : '',
        props.runningWorkCount ? t('sessionWork.strip.stillWorking', { count: props.runningWorkCount }) : '',
        reportsStatus?.word ?? '',
        needsYou > 0 ? t('sessionWork.list.reportsNeedYou', { count: needsYou }) : '',
    ].filter(Boolean).join('. ');
    return (
        <View
            testID={`session-row-progress-chip:${props.occurrenceId ?? props.sessionId}`}
            accessible
            accessibilityLabel={accessibilityLabel}
            style={styles.chip}
        >
            {progress ? (
                <>
                    <CapacityRing
                        size={PROGRESS_RING_PX}
                        strokeWidth={PROGRESS_STROKE_PX}
                        ratio={progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0}
                        color={progress.dim ? theme.colors.text.tertiary : theme.colors.text.secondary}
                        trackColor={theme.colors.border.default}
                    />
                    {progress.label ? <Text numberOfLines={1} style={styles.total}>{progress.label}</Text> : null}
                    <Text numberOfLines={1} style={styles.total}>
                        {`${progress.done}/${progress.total}`}
                    </Text>
                </>
            ) : null}
            {attention ? <StatusDot color={workStatusGlyphColor(theme.colors, attention.tone)} size={7} /> : null}
            {needsYou > 0 ? <Text style={styles.needsYou}>{needsYou}</Text> : null}
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
