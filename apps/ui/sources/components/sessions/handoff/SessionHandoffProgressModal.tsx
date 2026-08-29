import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    SessionHandoffProgressCheckpointSchema,
    SESSION_HANDOFF_PROGRESS_FULL_TIMELINE,
    SESSION_HANDOFF_PROGRESS_FULL_TIMELINE_WITH_SOURCE_SCAN,
    resolveSessionHandoffProgressTimeline,
    type ActionOperationSnapshotV1,
    type SessionHandoffProgressCheckpoint,
    type SessionHandoffStatus,
} from '@happier-dev/protocol';

import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';

type Props = CustomModalInjectedProps & Readonly<{
    title?: string;
    message?: string;
    status?: SessionHandoffStatus;
    operation?: ActionOperationSnapshotV1;
    onResume?: () => Promise<void> | void;
    workspaceTransferEnabled?: boolean;
}>;

type HandoffStepId = 'prepare-session' | 'transfer-session' | 'transfer-workspace' | 'start-target' | 'finalize';

type HandoffStep = Readonly<{ id: HandoffStepId; label: string }>;

type ProgressStatCounts = Readonly<{
    files?: number;
    bytes?: number;
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
        paddingBottom: 2,
    },
    message: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        ...Typography.default(),
        flex: 1,
    },
    progressSection: {
        gap: 10,
    },
    timeline: {
        gap: 4,
    },
    timelineRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        minHeight: 34,
    },
    timelineMarker: {
        width: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    timelineDot: {
        width: 14,
        height: 14,
        borderRadius: 999,
        borderWidth: 1.5,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    timelineContent: {
        flex: 1,
        gap: 8,
        paddingBottom: 6,
    },
    timelineContentWithProgress: {
        paddingBottom: 14,
    },
    timelineLabel: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        ...Typography.default(),
        flex: 1,
    },
    timelineLabelCurrent: {
        color: theme.colors.text.primary,
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
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    summaryChipText: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    stats: {
        gap: 8,
    },
    statRow: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
    },
    statLabel: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    statValue: {
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default(),
        textAlign: 'right',
    },
    progressTrack: {
        height: 6,
        borderRadius: 999,
        backgroundColor: theme.colors.border.default,
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
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    currentPath: {
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
        flex: 1,
        textAlign: 'right',
    },
    actionRow: {
        alignItems: 'flex-end',
    },
}));

const BASE_HANDOFF_STEPS: readonly HandoffStep[] = [
    { id: 'prepare-session', label: 'Prepare session' },
    { id: 'transfer-session', label: 'Transfer session data' },
    { id: 'transfer-workspace', label: 'Transfer workspace' },
    { id: 'start-target', label: 'Start on target' },
    { id: 'finalize', label: 'Finalize handoff' },
];

function resolveOperationStepId(operation: ActionOperationSnapshotV1 | undefined): HandoffStepId {
    const progress = operation?.progress;
    if (!progress) return 'prepare-session';
    if (progress.kind === 'determinate') {
        const label = progress.label?.toLowerCase() ?? '';
        if (label.includes('workspace')) return 'transfer-workspace';
        if (label.includes('session')) return 'transfer-session';
        return 'prepare-session';
    }
    if (progress.kind === 'indeterminate') return 'prepare-session';
    const phase = progress.phase;
    if (phase === 'session_transfer' || phase === 'preparing_target' || phase === 'workspace_import_session') {
        return 'transfer-session';
    }
    if (phase.startsWith('workspace_')) return 'transfer-workspace';
    if (phase === 'resuming_target' || phase === 'confirming_target') return 'start-target';
    if (phase === 'committing_target' || phase === 'cleaning_source' || phase === 'finalizing_target') return 'finalize';
    return 'prepare-session';
}

function computeProgressFraction(status: SessionHandoffStatus | undefined): number | null {
    const progress = status?.progress;
    if (!progress) {
        return null;
    }
    // The daemon may attach preflight/planning counters on checkpoints like `import_session` so the UI
    // can show a summary, but those values do not represent active transfer progress. Only show a
    // percent bar when we're explicitly transferring blobs.
    const isSessionTransfer = progress.checkpoint === 'import_session'
        && progress.current?.phaseDetail === 'transferring_session';
    if (progress.checkpoint !== 'transfer_blobs' && !isSessionTransfer) {
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

function subtractProgressCounts(
    planned: ProgressStatCounts | null | undefined,
    transferred: ProgressStatCounts | null | undefined,
): ProgressStatCounts {
    const plannedFiles = typeof planned?.files === 'number' ? planned.files : 0;
    const plannedBytes = typeof planned?.bytes === 'number' ? planned.bytes : 0;
    const transferredFiles = typeof transferred?.files === 'number' ? transferred.files : 0;
    const transferredBytes = typeof transferred?.bytes === 'number' ? transferred.bytes : 0;

    return {
        files: Math.max(0, plannedFiles - transferredFiles),
        bytes: Math.max(0, plannedBytes - transferredBytes),
    };
}

function formatProgressStatValue(counts: ProgressStatCounts | null | undefined): string {
    const parts: string[] = [];
    if (typeof counts?.files === 'number') {
        parts.push(`${counts.files} ${t('common.files')}`);
    }
    if (typeof counts?.bytes === 'number') {
        parts.push(formatByteSize(counts.bytes));
    }
    return parts.length > 0 ? parts.join(' · ') : '—';
}

function buildProgressStatRows(status: SessionHandoffStatus | undefined): readonly Readonly<{
    testID: string;
    label: string;
    counts: ProgressStatCounts;
}>[] {
    const progress = status?.progress;
    if (!progress) {
        return [];
    }

    const plannedCounts: ProgressStatCounts = {
        files: progress.planned.totalFiles,
        bytes: progress.planned.totalBytes,
    };
    const transferredCounts: ProgressStatCounts = {
        files: progress.transferred.files,
        bytes: progress.transferred.bytes,
    };
    const appliedCounts: ProgressStatCounts = progress.applied ?? { files: 0, bytes: 0 };
    const remainingCounts: ProgressStatCounts = progress.remaining ?? subtractProgressCounts(plannedCounts, transferredCounts);

    return [
        {
            testID: 'session-handoff-progress-stat-planned',
            label: t('sessionHandoff.progress.planned'),
            counts: plannedCounts,
        },
        {
            testID: 'session-handoff-progress-stat-transferred',
            label: t('sessionHandoff.progress.transferred'),
            counts: transferredCounts,
        },
        {
            testID: 'session-handoff-progress-stat-remaining',
            label: t('sessionHandoff.progress.remaining'),
            counts: remainingCounts,
        },
        {
            testID: 'session-handoff-progress-stat-applied',
            label: t('common.applied'),
            counts: appliedCounts,
        },
    ];
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

export function SessionHandoffProgressModal({ setChrome, title, message, status, operation, onResume, workspaceTransferEnabled = false }: Props) {
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
    const progressStats = buildProgressStatRows(effectiveStatus);
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
    const isAwaitingUserResume = effectiveStatus?.status === 'awaiting_user_resume';
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
            : isAwaitingUserResume
                ? t('externalSessions.operationStatusNeedsResume')
                : isFailureState
                    ? t('sessionHandoff.failure.message')
                    : t('sessionHandoff.progress.message'));
    const progressAnnouncement = [
        resolvedMessage,
        currentCheckpoint ? translateCheckpoint(currentCheckpoint) : null,
        progressLabel,
    ].filter((part): part is string => Boolean(part)).join('. ');
    const showSpinner = !isFailureState && !isCompleted && !isReadyForCutover && !isAwaitingUserResume;
    const operationProgress = operation?.progress;
    const determinateOperationProgress = operationProgress?.kind === 'determinate' ? operationProgress : null;
    const operationProgressFraction = determinateOperationProgress
        ? Math.max(0, Math.min(1, determinateOperationProgress.current / determinateOperationProgress.total))
        : null;
    const operationProgressLabel = operationProgress?.label ?? null;
    const operationSteps = BASE_HANDOFF_STEPS.filter((step) => workspaceTransferEnabled || step.id !== 'transfer-workspace');
    const operationStepId = resolveOperationStepId(operation);
    const operationStepIndex = operationSteps.findIndex((step) => step.id === operationStepId);
    const resumeInFlightRef = React.useRef(false);
    const [resumeInFlight, setResumeInFlight] = React.useState(false);
    const handleResume = React.useCallback(() => {
        if (!onResume || resumeInFlightRef.current) return;
        resumeInFlightRef.current = true;
        setResumeInFlight(true);
        void Promise.resolve(onResume()).finally(() => {
            resumeInFlightRef.current = false;
            setResumeInFlight(false);
        });
    }, [onResume]);

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: resolvedTitle,
        testID: 'session-handoff-progress-modal',
        bodyScroll: 'auto' as const,
        dimensions: { width: 420, maxHeightRatio: 0.92 },
    }), [resolvedTitle]);

    useModalCardChrome(setChrome, chrome);

    return (
        <View style={styles.body}>
            <View style={styles.messageRow}>
                <Text
                    testID="session-handoff-progress-status"
                    style={styles.message}
                    accessibilityLabel={progressAnnouncement}
                    accessibilityLiveRegion="polite"
                    role="status"
                    aria-live="polite"
                >
                    {resolvedMessage}
                </Text>
            </View>
            {isAwaitingUserResume && onResume ? (
                <View style={styles.actionRow}>
                    <RoundButton
                        testID="session-handoff-progress-resume"
                        title={t('externalSessions.operationActionResume')}
                        onPress={handleResume}
                        disabled={resumeInFlight}
                    />
                </View>
            ) : null}
            {operation || (!effectiveStatus && showSpinner) ? (
                <View testID="session-handoff-operation-progress" style={styles.timeline}>
                    {operationSteps.map((step, index) => {
                        const isDone = operation?.state === 'succeeded' || index < Math.max(operationStepIndex, 0);
                        const isCurrent = operation?.state !== 'succeeded' && index === Math.max(operationStepIndex, 0);
                        return (
                            <View
                                key={step.id}
                                testID={`session-handoff-step-${step.id}`}
                                accessibilityState={{ checked: isDone, selected: isCurrent }}
                                style={styles.timelineRow}
                            >
                                <View style={styles.timelineMarker}>
                                    {isDone ? (
                                        <Icon name="check" size={16} color={theme.colors.accent.blue} />
                                    ) : isCurrent && isFailureState ? (
                                        <Icon name="warning" size={16} color={theme.colors.state.danger.foreground} />
                                    ) : isCurrent && isAwaitingUserResume ? (
                                        <Icon name="play" size={16} color={theme.colors.accent.blue} />
                                    ) : isCurrent ? (
                                        <ActivitySpinner size={iconMatchedSpinnerSize(16)} color={theme.colors.accent.blue} />
                                    ) : (
                                        <View style={styles.timelineDot} />
                                    )}
                                </View>
                                <View style={[styles.timelineContent, isCurrent && operationProgressFraction !== null ? styles.timelineContentWithProgress : null]}>
                                    <Text style={[styles.timelineLabel, isCurrent ? styles.timelineLabelCurrent : null]}>
                                        {step.label}
                                    </Text>
                                    {isCurrent && operationProgressFraction !== null ? (
                                        <>
                                            <View
                                                testID="session-handoff-operation-progress-bar"
                                                style={styles.progressTrack}
                                                accessibilityRole="progressbar"
                                                accessibilityLabel={operationProgressLabel ?? step.label}
                                                accessibilityValue={{ min: 0, max: 100, now: Math.round(operationProgressFraction * 100) }}
                                            >
                                                <View style={[styles.progressFill, { width: `${Math.max(operationProgressFraction * 100, 4)}%` }]} />
                                            </View>
                                            <View style={styles.progressMetaRow}>
                                                <Text style={styles.progressMetaText}>{Math.round(operationProgressFraction * 100)}%</Text>
                                                <Text style={styles.currentPath}>{formatByteSize(determinateOperationProgress!.current)} / {formatByteSize(determinateOperationProgress!.total)}</Text>
                                            </View>
                                        </>
                                    ) : isCurrent && operationProgressLabel && operationProgress?.kind !== 'phase' ? (
                                        <Text style={styles.progressMetaText}>{operationProgressLabel}</Text>
                                    ) : null}
                                </View>
                            </View>
                        );
                    })}
                </View>
            ) : null}
            {effectiveStatus && !operation ? (
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
                                        <View style={styles.timelineMarker}>
                                            {isDone ? (
                                                <Icon name="check" size={16} color={theme.colors.accent.blue} />
                                            ) : isCurrent && isFailureState ? (
                                                <Icon name="warning" size={16} color={theme.colors.state.danger.foreground} />
                                            ) : isCurrent && isAwaitingUserResume ? (
                                                <Icon name="play" size={16} color={theme.colors.accent.blue} />
                                            ) : isCurrent ? (
                                                <ActivitySpinner size={iconMatchedSpinnerSize(16)} color={theme.colors.accent.blue} />
                                            ) : (
                                                <View style={styles.timelineDot} />
                                            )}
                                        </View>
                                        <View style={[styles.timelineContent, isCurrent && progressFraction !== null ? styles.timelineContentWithProgress : null]}>
                                            <Text style={[styles.timelineLabel, isCurrent ? styles.timelineLabelCurrent : null]}>
                                                {translateCheckpoint(checkpoint)}
                                            </Text>
                                            {isCurrent && progressFraction !== null ? (
                                                <View
                                                    testID="session-handoff-progress-bar"
                                                    style={styles.progressTrack}
                                                    accessibilityRole="progressbar"
                                                    accessibilityLabel={resolvedTitle}
                                                    accessibilityValue={{ min: 0, max: 100, now: Math.round(progressFraction * 100) }}
                                                >
                                                    <View style={[styles.progressFill, { width: `${Math.max(progressFraction * 100, 4)}%` }]} />
                                                </View>
                                            ) : null}
                                        </View>
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
                    {progressStats.length > 0 ? (
                        <View testID="session-handoff-progress-stats" style={styles.stats}>
                            {progressStats.map((stat) => (
                                <View key={stat.testID} testID={stat.testID} style={styles.statRow}>
                                    <Text style={styles.statLabel}>{stat.label}</Text>
                                    <Text style={styles.statValue}>{formatProgressStatValue(stat.counts)}</Text>
                                </View>
                            ))}
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
