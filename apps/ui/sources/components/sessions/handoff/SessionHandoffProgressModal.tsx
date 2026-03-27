import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    SessionHandoffProgressCheckpointSchema,
    SESSION_HANDOFF_PROGRESS_FULL_TIMELINE,
    SESSION_HANDOFF_PROGRESS_FULL_TIMELINE_WITH_SOURCE_SCAN,
    resolveSessionHandoffProgressTimeline,
    type SessionHandoffProgressCheckpoint,
    type SessionHandoffStatus,
} from '@happier-dev/protocol';

import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
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
const FULL_TIMELINE = SESSION_HANDOFF_PROGRESS_FULL_TIMELINE;
const FULL_TIMELINE_WITH_SOURCE_SCAN = SESSION_HANDOFF_PROGRESS_FULL_TIMELINE_WITH_SOURCE_SCAN;

const stylesheet = StyleSheet.create((theme) => ({
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

function checkpointsEqual(
    left: readonly SessionHandoffProgressCheckpoint[],
    right: readonly SessionHandoffProgressCheckpoint[],
): boolean {
    return left.length === right.length && left.every((checkpoint, index) => checkpoint === right[index]);
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

export function SessionHandoffProgressModal({ setChrome, title, message, status }: Props) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    // Keep a monotonic "effective" status so the checkpoint selection never regresses when
    // daemon status updates arrive out of order or omit progress on terminal transitions.
    const [effectiveStatus, setEffectiveStatus] = React.useState<SessionHandoffStatus | undefined>(status);
    const effectiveStatusRef = React.useRef<SessionHandoffStatus | undefined>(status);
    const lastProgressUpdatedAtMsRef = React.useRef<number | null>(status?.progress?.updatedAtMs ?? null);

    React.useEffect(() => {
        effectiveStatusRef.current = effectiveStatus;
    }, [effectiveStatus]);

    React.useEffect(() => {
        if (!status) {
            setEffectiveStatus(undefined);
            effectiveStatusRef.current = undefined;
            lastProgressUpdatedAtMsRef.current = null;
            return;
        }

        const previous = effectiveStatusRef.current;
        if (!previous || previous.handoffId !== status.handoffId) {
            setEffectiveStatus(status);
            effectiveStatusRef.current = status;
            lastProgressUpdatedAtMsRef.current = status.progress?.updatedAtMs ?? null;
            return;
        }

        const previousCode = previous.status;
        const nextCode = status.status;
        const previousIsTerminal = previousCode === 'completed' || previousCode === 'aborted' || previousCode === 'failed';
        const nextIsTerminal = nextCode === 'completed' || nextCode === 'aborted' || nextCode === 'failed';
        if (previousIsTerminal && !nextIsTerminal) {
            return;
        }

        const previousUpdatedAtMs = lastProgressUpdatedAtMsRef.current;
        const nextUpdatedAtMs = status.progress?.updatedAtMs ?? null;
        if (
            typeof previousUpdatedAtMs === 'number'
            && typeof nextUpdatedAtMs === 'number'
            && nextUpdatedAtMs < previousUpdatedAtMs
        ) {
            return;
        }

        const merged: SessionHandoffStatus = {
            ...status,
            ...(status.progress ? {} : previous.progress ? { progress: previous.progress } : {}),
            ...(status.workspacePreflightSummary ? {} : previous.workspacePreflightSummary ? { workspacePreflightSummary: previous.workspacePreflightSummary } : {}),
        };
        setEffectiveStatus(merged);
        effectiveStatusRef.current = merged;

        const mergedUpdatedAtMs = merged.progress?.updatedAtMs ?? null;
        if (typeof mergedUpdatedAtMs === 'number') {
            lastProgressUpdatedAtMsRef.current = mergedUpdatedAtMs;
        }
    }, [status]);

    const isFailureState = effectiveStatus?.status === 'failed' || effectiveStatus?.status === 'aborted' || effectiveStatus?.status === 'awaiting_recovery';
    const isReadyForCutover = effectiveStatus?.status === 'ready_for_cutover';
    const isCompleted = effectiveStatus?.status === 'completed';
    const canShowActiveProgress = !isFailureState && !isReadyForCutover;
    const progressFraction = canShowActiveProgress ? computeProgressFraction(effectiveStatus) : null;
    const summaryChips = buildSummaryChips(effectiveStatus);
    const progressLabel = progressFraction === null ? null : `${Math.round(progressFraction * 100)}%`;
    const checkpointFromProgress = isKnownCheckpoint(effectiveStatus?.progress?.checkpoint) ? effectiveStatus?.progress?.checkpoint : null;
    const currentCheckpoint = checkpointFromProgress;
    const canonicalTimelineForCheckpoint = resolveSessionHandoffProgressTimeline(checkpointFromProgress);
    // Once the daemon has emitted any "full timeline" checkpoint, keep rendering the full timeline
    // even when later checkpoints fall back to minimal-mode (e.g. import_session/finalize), so the
    // UI doesn't appear to "forget" completed phases mid-handoff.
    const hasSeenFullTimelineRef = React.useRef(false);
    const hasSeenSourceScanRef = React.useRef(false);
    // Use the protocol's canonical resolver so the UI stays aligned with daemon semantics, but do
    // not rely on reference equality (resolver implementations can return a fresh array).
    const isFullTimelineForCheckpoint =
        checkpointsEqual(canonicalTimelineForCheckpoint, FULL_TIMELINE)
        || checkpointsEqual(canonicalTimelineForCheckpoint, FULL_TIMELINE_WITH_SOURCE_SCAN);
    if (currentCheckpoint === 'scan_source') {
        hasSeenSourceScanRef.current = true;
    }
    if (currentCheckpoint && isFullTimelineForCheckpoint) {
        hasSeenFullTimelineRef.current = true;
    }
    const timeline = hasSeenFullTimelineRef.current
        ? (hasSeenSourceScanRef.current ? FULL_TIMELINE_WITH_SOURCE_SCAN : FULL_TIMELINE)
        : canonicalTimelineForCheckpoint;
    const currentCheckpointIndex = currentCheckpoint ? timeline.indexOf(currentCheckpoint) : -1;
    const isAwaitingRecovery = effectiveStatus?.status === 'awaiting_recovery';
    const currentDetailLabel =
        effectiveStatus?.progress?.current?.relativePath
        ?? (isFailureState || isReadyForCutover ? effectiveStatus?.progress?.current?.phaseDetail : undefined)
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

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: resolvedTitle,
        testID: 'session-handoff-progress-modal',
        dimensions: { width: 420, maxHeightRatio: 0.92 },
    }), [resolvedTitle]);

    useModalCardChrome(setChrome, chrome);

    return (
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
            {effectiveStatus ? (
                <View style={styles.progressSection}>
                    {currentCheckpoint && currentCheckpointIndex >= 0 ? (
                        <View testID="session-handoff-progress-timeline" style={styles.timeline}>
                            {timeline.map((checkpoint, index) => {
                                const isDone =
                                    effectiveStatus.status === 'completed'
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
    );
}

export default SessionHandoffProgressModal;
