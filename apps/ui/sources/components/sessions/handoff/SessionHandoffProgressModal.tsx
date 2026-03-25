import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    SessionHandoffProgressCheckpointSchema,
    resolveSessionHandoffProgressTimeline,
    type SessionHandoffProgressCheckpoint,
    type SessionHandoffStatus,
} from '@happier-dev/protocol';

import type { CustomModalInjectedProps } from '@/modal';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';

type Props = CustomModalInjectedProps & Readonly<{
    title?: string;
    message?: string;
    status?: SessionHandoffStatus;
}>;

const CHECKPOINT_TIMELINE = SessionHandoffProgressCheckpointSchema.options;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        width: 420,
        maxWidth: '92%',
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 5,
    },
    header: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    body: {
        paddingHorizontal: 16,
        paddingVertical: 18,
        gap: 14,
    },
    messageRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
    },
    message: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
        flex: 1,
    },
    progressSection: {
        gap: 10,
    },
    timeline: {
        gap: 8,
    },
    timelineRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    timelineDot: {
        width: 10,
        height: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    timelineDotDone: {
        borderColor: theme.colors.accent.blue,
        backgroundColor: theme.colors.accent.blue,
    },
    timelineDotCurrent: {
        borderColor: theme.colors.accent.blue,
        backgroundColor: theme.colors.surface,
    },
    timelineLabel: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
        flex: 1,
    },
    timelineLabelCurrent: {
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    summaryRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    summaryChip: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    summaryChipText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    progressTrack: {
        height: 8,
        borderRadius: 999,
        backgroundColor: theme.colors.divider,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        borderRadius: 999,
        backgroundColor: theme.colors.accent.blue,
        minWidth: 6,
    },
    progressMetaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    progressMetaText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    currentPath: {
        fontSize: 12,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
        flex: 1,
        textAlign: 'right',
    },
}));

function computeProgressFraction(status: SessionHandoffStatus | undefined): number | null {
    const progress = status?.progress;
    if (!progress) {
        return null;
    }
    // The daemon may attach preflight/planning counters on checkpoints like `import_session` so the UI
    // can show a summary, but those values do not represent active transfer progress. Only show a
    // percent bar when we're explicitly transferring blobs.
    if (progress.checkpoint !== 'transfer_blobs') {
        return null;
    }
    if (
        typeof progress.planned.totalBytes === 'number'
        && progress.planned.totalBytes > 0
        && typeof progress.transferred.bytes === 'number'
    ) {
        return Math.max(0, Math.min(1, progress.transferred.bytes / progress.planned.totalBytes));
    }
    if (
        typeof progress.planned.totalFiles === 'number'
        && progress.planned.totalFiles > 0
        && typeof progress.transferred.files === 'number'
    ) {
        return Math.max(0, Math.min(1, progress.transferred.files / progress.planned.totalFiles));
    }
    return null;
}

function buildSummaryChips(status: SessionHandoffStatus | undefined): readonly string[] {
    const summary = status?.workspacePreflightSummary ?? null;
    if (!summary) {
        return [];
    }

    const addedCount = summary.addedPathsCount;
    const changedCount = summary.changedPathsCount;
    const removedCount = summary.removedPathsCount;
    const totalBytes = typeof summary.totalBytes === 'number' ? summary.totalBytes : null;

    if (addedCount === null && changedCount === null && removedCount === null && (!totalBytes || totalBytes <= 0)) {
        return [];
    }

    const chips = [
        ...(typeof addedCount === 'number' ? [`+${addedCount}`] : []),
        ...(typeof changedCount === 'number' ? [`~${changedCount}`] : []),
        ...(typeof removedCount === 'number' ? [`-${removedCount}`] : []),
    ];
    if (typeof totalBytes === 'number' && totalBytes > 0) {
        chips.push(formatByteSize(totalBytes));
    }
    return chips;
}

function isKnownCheckpoint(value: unknown): value is SessionHandoffProgressCheckpoint {
    return typeof value === 'string' && (CHECKPOINT_TIMELINE as readonly string[]).includes(value);
}

function translateCheckpoint(checkpoint: SessionHandoffProgressCheckpoint): string {
    switch (checkpoint) {
        case 'scan_source':
            return t('sessionHandoff.progress.timeline.scanSource');
        case 'plan':
            return t('sessionHandoff.progress.timeline.plan');
        case 'transfer_blobs':
            return t('sessionHandoff.progress.timeline.transferBlobs');
        case 'stage_target':
            return t('sessionHandoff.progress.timeline.stageTarget');
        case 'apply':
            return t('sessionHandoff.progress.timeline.apply');
        case 'import_session':
            return t('sessionHandoff.progress.timeline.importSession');
        case 'finalize':
            return t('sessionHandoff.progress.timeline.finalize');
        default: {
            const exhaustive: never = checkpoint;
            return exhaustive;
        }
    }
}

export function SessionHandoffProgressModal({ onClose, title, message, status }: Props) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const isFailureState = status?.status === 'failed' || status?.status === 'aborted' || status?.status === 'awaiting_recovery';
    const isReadyForCutover = status?.status === 'ready_for_cutover';
    const isCompleted = status?.status === 'completed';
    const canShowActiveProgress = !isFailureState && !isReadyForCutover;
    const progressFraction = canShowActiveProgress ? computeProgressFraction(status) : null;
    const summaryChips = buildSummaryChips(status);
    const progressLabel = progressFraction === null ? null : `${Math.round(progressFraction * 100)}%`;
    const checkpointFromProgress = isKnownCheckpoint(status?.progress?.checkpoint) ? status?.progress?.checkpoint : null;
    const currentCheckpoint = checkpointFromProgress;
    const canonicalTimelineForCheckpoint = resolveSessionHandoffProgressTimeline(checkpointFromProgress);
    // Once the daemon has emitted any "full timeline" checkpoint, keep rendering the full timeline
    // even when later checkpoints fall back to minimal-mode (e.g. import_session/finalize), so the
    // UI doesn't appear to "forget" completed phases mid-handoff.
    const hasSeenFullTimelineRef = React.useRef(false);
    // Use the protocol's canonical resolver so the UI stays aligned with daemon semantics.
    if (currentCheckpoint && canonicalTimelineForCheckpoint === CHECKPOINT_TIMELINE) {
        hasSeenFullTimelineRef.current = true;
    }
    const timeline = hasSeenFullTimelineRef.current
        ? CHECKPOINT_TIMELINE
        : canonicalTimelineForCheckpoint;
    const currentCheckpointIndex = currentCheckpoint ? timeline.indexOf(currentCheckpoint) : -1;
    const isAwaitingRecovery = status?.status === 'awaiting_recovery';
    const currentDetailLabel =
        status?.progress?.current?.relativePath
        ?? (isFailureState || isReadyForCutover ? status?.progress?.current?.phaseDetail : undefined)
        ?? (currentCheckpoint ? translateCheckpoint(currentCheckpoint) : null);
    const resolvedTitle =
        title
        ?? (isAwaitingRecovery
            ? t('sessionHandoff.recovery.title')
            : isFailureState
                ? t('sessionHandoff.failure.title')
                : t('sessionHandoff.progress.title'));
    const resolvedMessage =
        message
        ?? (isAwaitingRecovery
            ? t('sessionHandoff.recovery.messageAfterSourceStop')
            : isFailureState
                ? t('sessionHandoff.failure.message')
                : t('sessionHandoff.progress.message'));
    const showSpinner = !isFailureState && !isCompleted && !isReadyForCutover;

    return (
        <View testID="session-handoff-progress-modal" style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>{resolvedTitle}</Text>
                <Pressable
                    onPress={onClose}
                    hitSlop={10}
                    style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close')}
                >
                    <Octicons name="x" size={18} color={theme.colors.header.tint} />
                </Pressable>
            </View>
            <View style={styles.body}>
                <View style={styles.messageRow}>
                    {showSpinner ? (
                        <ActivityIndicator size="small" color={theme.colors.accent.blue} />
                    ) : (
                        <Octicons
                            name={isFailureState ? 'alert' : 'check'}
                            size={18}
                            color={isFailureState ? theme.colors.textDestructive : theme.colors.accent.blue}
                        />
                    )}
                    <Text style={styles.message}>{resolvedMessage}</Text>
                </View>
                {status ? (
                    <View style={styles.progressSection}>
                        {currentCheckpoint && currentCheckpointIndex >= 0 ? (
                            <View testID="session-handoff-progress-timeline" style={styles.timeline}>
                                {timeline.map((checkpoint, index) => {
                                    const isDone =
                                        status.status === 'completed'
                                        || (currentCheckpointIndex >= 0 && index < currentCheckpointIndex);
                                    const isCurrent = currentCheckpointIndex >= 0 && index === currentCheckpointIndex;
                                    return (
                                        <View
                                            key={checkpoint}
                                            testID={`session-handoff-progress-checkpoint-${checkpoint}`}
                                            accessibilityState={{ selected: isCurrent }}
                                            style={styles.timelineRow}
                                        >
                                            <View
                                                style={[
                                                    styles.timelineDot,
                                                    isDone ? styles.timelineDotDone : null,
                                                    isCurrent ? styles.timelineDotCurrent : null,
                                                ]}
                                            />
                                            <Text style={[styles.timelineLabel, isCurrent ? styles.timelineLabelCurrent : null]}>
                                                {translateCheckpoint(checkpoint)}
                                            </Text>
                                        </View>
                                    );
                                })}
                            </View>
                        ) : null}
                        {summaryChips.length > 0 ? (
                            <View testID="session-handoff-progress-summary" style={styles.summaryRow}>
                                {summaryChips.map((chip) => (
                                    <View key={chip} style={styles.summaryChip}>
                                        <Text style={styles.summaryChipText}>{chip}</Text>
                                    </View>
                                ))}
                            </View>
                        ) : null}
                        {progressFraction !== null ? (
                            <View testID="session-handoff-progress-bar" style={styles.progressTrack}>
                                <View style={[styles.progressFill, { width: `${Math.max(progressFraction * 100, 4)}%` }]} />
                            </View>
                        ) : null}
                        {progressLabel || currentDetailLabel ? (
                            <View style={styles.progressMetaRow}>
                                {progressLabel ? (
                                    <Text testID="session-handoff-progress-percent" style={styles.progressMetaText}>
                                        {progressLabel}
                                    </Text>
                                ) : null}
                                {currentDetailLabel ? (
                                    <Text testID="session-handoff-progress-path" style={styles.currentPath}>
                                        {currentDetailLabel}
                                    </Text>
                                ) : null}
                            </View>
                        ) : null}
                    </View>
                ) : null}
            </View>
        </View>
    );
}

export default SessionHandoffProgressModal;
