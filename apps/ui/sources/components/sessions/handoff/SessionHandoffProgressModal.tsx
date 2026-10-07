import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierProgress } from '@happier-dev/plugin-ui/presentation';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import {
    SessionHandoffProgressCheckpointSchema,
    SessionHandoffActionResultV1Schema,
    SESSION_HANDOFF_PROGRESS_FULL_TIMELINE,
    SESSION_HANDOFF_PROGRESS_FULL_TIMELINE_WITH_SOURCE_SCAN,
    resolveSessionHandoffProgressTimeline,
    type ActionOperationSnapshotV1,
    type HandoffWorkspaceOutcomeV1,
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
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ActionOperationDetailControls } from '@/components/inbox/actionOperations/ActionOperationDetailControls';
import { resolveWorkspaceSyncErrorTranslationKey } from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import type { ExecuteSessionHandoffActionResult } from '@/sync/domains/sessionHandoff/executeSessionHandoffAction';

type Props = CustomModalInjectedProps & Readonly<{
    title?: string;
    message?: string;
    status?: SessionHandoffStatus;
    operation?: ActionOperationSnapshotV1;
    serverId?: string | null;
    onResume?: () => Promise<void> | void;
    workspaceSyncEnabled?: boolean;
    requestFailure?: Extract<ExecuteSessionHandoffActionResult, { ok: false }>;
    onOpenConflicts?: (blockedRelationshipId: string | null) => void;
}>;

type PrimaryProgressStepId = 'preparing' | 'moving' | 'ready';

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
    outcomeSection: {
        gap: 6,
    },
    outcomeText: {
        fontSize: 14,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    outcomeWarningText: {
        fontSize: 12,
        // Cleanup debt after a committed success is a warning, not a failure.
        color: theme.colors.state.warning.foreground,
        ...Typography.default(),
    },
    detailsBody: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 12,
    },
}));

const PRIMARY_PROGRESS_STEPS: readonly PrimaryProgressStepId[] = ['preparing', 'moving', 'ready'];

function resolveOperationPrimaryStep(operation: ActionOperationSnapshotV1 | undefined): PrimaryProgressStepId {
    const progress = operation?.progress;
    if (!progress) return 'preparing';
    if (progress.kind === 'determinate') {
        const label = progress.label?.toLowerCase() ?? '';
        if (label.includes('packag') || label.includes('prepar')) return 'preparing';
        if (label.includes('transfer') || label.includes('import') || label.includes('workspace')) return 'moving';
        return 'preparing';
    }
    if (progress.kind === 'indeterminate') return 'preparing';
    const phase = progress.phase;
    if (phase === 'preparing_target') return 'preparing';
    if (
        phase === 'session_transfer'
        || phase === 'workspace_import_session'
        || phase.startsWith('workspace_')
        || phase === 'resuming_target'
        || phase === 'confirming_target'
        || phase === 'committing_target'
        || phase === 'cleaning_source'
        || phase === 'finalizing_target'
    ) return 'moving';
    return 'preparing';
}

function translatePrimaryProgressStep(step: PrimaryProgressStepId): string {
    switch (step) {
        case 'preparing':
            return t('sessionHandoff.progress.primary.preparing');
        case 'moving':
            return t('sessionHandoff.progress.primary.moving');
        case 'ready':
            return t('sessionHandoff.progress.primary.ready');
    }
}

function resolvePrimaryProgressStep(
    operation: ActionOperationSnapshotV1 | undefined,
    status: SessionHandoffStatus | undefined,
    checkpoint: SessionHandoffProgressCheckpoint | null,
): PrimaryProgressStepId {
    if (operation?.state === 'succeeded' || status?.status === 'completed' || status?.status === 'ready_for_cutover') {
        return 'ready';
    }
    if (operation) {
        return resolveOperationPrimaryStep(operation);
    }
    if (
        checkpoint === 'transfer_blobs'
        || checkpoint === 'apply'
        || checkpoint === 'import_session'
        || checkpoint === 'finalize'
        || status?.phase === 'transferring'
        || status?.phase === 'importing'
        || status?.phase === 'finalizing'
    ) {
        return 'moving';
    }
    return 'preparing';
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

/**
 * Product wording for the committed workspace result. Relationship identity and
 * copy operation ids stay diagnostic-only (A4.5), so the confirmation names what
 * happened to the user's files rather than the record that carries it.
 */
function translateWorkspaceOutcome(outcome: HandoffWorkspaceOutcomeV1): string | null {
    switch (outcome.kind) {
        case 'none':
            return null;
        case 'copied':
            return t('sessionHandoff.workspaceOutcome.copied');
        case 'relationship':
            return outcome.created
                ? t('sessionHandoff.workspaceOutcome.relationshipCreated')
                : t('sessionHandoff.workspaceOutcome.relationshipReused');
        case 'linked_workspace':
            return t('sessionHandoff.workspaceOutcome.linked');
    }
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

export function SessionHandoffProgressModal({ onClose, setChrome, title, message, status, operation, serverId, onResume, requestFailure, onOpenConflicts }: Props) {
    const { theme } = useUnistyles();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
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

    // One effective terminal reading: the legacy status channel when present,
    // otherwise the live Action operation the production opener subscribes to.
    // A terminal (failed/cancelled) operation must never keep presenting as
    // active progress with a running spinner.
    const terminalResult = SessionHandoffActionResultV1Schema.safeParse(operation?.result);
    const workspaceOutcome = terminalResult.success ? terminalResult.data.workspace : undefined;
    const outcomeLabel = workspaceOutcome ? translateWorkspaceOutcome(workspaceOutcome) : null;
    const outcomeCleanupWarning = terminalResult.success
        ? terminalResult.data.warning
            ?? (workspaceOutcome && workspaceOutcome.kind !== 'none' ? workspaceOutcome.cleanupWarning : undefined)
            ?? null
        : null;
    const hasLegacyStatus = effectiveStatus !== undefined;
    const operationFailed = !hasLegacyStatus && operation?.state === 'failed';
    const operationCancelled = !hasLegacyStatus && operation?.state === 'cancelled';
    const isFailureState = effectiveStatus?.status === 'failed' || effectiveStatus?.status === 'aborted' || effectiveStatus?.status === 'awaiting_recovery' || operationFailed || Boolean(requestFailure);
    const isReadyForCutover = effectiveStatus?.status === 'ready_for_cutover';
    const isCompleted = effectiveStatus?.status === 'completed';
    const canShowActiveProgress = !isFailureState && !isReadyForCutover && !operationCancelled;
    const progressFraction = canShowActiveProgress ? computeProgressFraction(effectiveStatus) : null;
    const summaryChips = buildSummaryChips(effectiveStatus);
    const progressStats = buildProgressStatRows(effectiveStatus);
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
        ?? effectiveStatus?.progress?.current?.phaseDetail
        ?? null;
    const resolvedTitle =
        title
        ?? (isAwaitingRecovery
            ? t('sessionHandoff.recovery.title')
            : isFailureState
                ? t('sessionHandoff.failure.title')
                : operationCancelled
                    ? t('sessionHandoff.cancelled.title')
                    : t('sessionHandoff.progress.title'));
    const operationFailureTranslationKey = operationFailed || requestFailure
        ? resolveWorkspaceSyncErrorTranslationKey(requestFailure?.errorCode ?? operation?.error?.errorCode)
        : null;
    const resolvedMessage =
        message
        ?? (outcomeLabel && !isFailureState
            ? t('sessionHandoff.progress.completedMessage')
            : isAwaitingRecovery
            ? t('sessionHandoff.recovery.messageAfterSourceStop')
            : isAwaitingUserResume
                ? t('externalSessions.operationStatusNeedsResume')
                : isFailureState
                    ? t(operationFailureTranslationKey ?? 'sessionHandoff.failure.message')
                    : operationCancelled
                        ? t('sessionHandoff.cancelled.message')
                        : t('sessionHandoff.progress.message'));
    const operationProgress = operation?.progress;
    const determinateOperationProgress = operationProgress?.kind === 'determinate' ? operationProgress : null;
    const operationProgressFraction = determinateOperationProgress && determinateOperationProgress.total > 0
        ? Math.max(0, Math.min(1, determinateOperationProgress.current / determinateOperationProgress.total))
        : null;
    const operationProgressLabel = operationProgress?.label ?? null;
    // A committed workspace outcome only exists after the daemon finished the
    // handoff, so it is the strongest available "Ready" evidence.
    const primaryProgressStep = outcomeLabel && !isFailureState
        ? 'ready'
        : resolvePrimaryProgressStep(operation, effectiveStatus, currentCheckpoint);
    const primaryProgressStepIndex = PRIMARY_PROGRESS_STEPS.indexOf(primaryProgressStep);
    const primaryProgressFraction = operation && canShowActiveProgress ? operationProgressFraction : progressFraction;
    const primaryProgressLabel = primaryProgressFraction === null ? null : `${Math.round(primaryProgressFraction * 100)}%`;
    const progressAnnouncement = [
        resolvedMessage,
        translatePrimaryProgressStep(primaryProgressStep),
        primaryProgressLabel,
    ].filter((part): part is string => Boolean(part)).join('. ');
    const operationTechnicalPhase = operationProgress?.kind === 'phase'
        ? operationProgress.phase
        : operationProgressLabel;
    const hasTechnicalDetails = Boolean(operation || currentCheckpoint || summaryChips.length > 0 || progressStats.length > 0 || currentDetailLabel);
    const [detailsExpanded, setDetailsExpanded] = React.useState(false);
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
    // A committed workspace outcome is itself a terminal reading, so the footer
    // must offer Done rather than a cancel control the daemon can no longer honor.
    const operationTerminal = Boolean(requestFailure || operation?.state === 'succeeded'
        || operation?.state === 'failed'
        || operation?.state === 'cancelled'
        || outcomeLabel);
    const operationStopTarget = React.useMemo(() => (
        operation && serverId ? { serverId, snapshot: operation } : undefined
    ), [operation, serverId]);

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: resolvedTitle,
        testID: 'session-handoff-progress-modal',
        bodyScroll: 'auto' as const,
        dimensions: { width: 420, maxHeightRatio: 0.92 },
        footer: (
            <ActionOperationDetailControls
                operation={operationStopTarget}
                terminal={operationTerminal}
                canCancel={!operationTerminal && operation?.cancellation === 'supported' && operationStopTarget !== undefined}
                onClose={onClose}
            />
        ),
    }), [onClose, operation, operationStopTarget, operationTerminal, resolvedTitle]);

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
            {requestFailure && onOpenConflicts ? (
                <View style={styles.actionRow}>
                    <RoundButton
                        testID="session-handoff-open-conflicts"
                        title={t('workspaceSync.conflictsTitle')}
                        accessibilityHint={t('sessionHandoff.failure.partialLinked')}
                        onPress={() => onOpenConflicts(requestFailure.workspacePreparation?.blockedRelationshipId ?? null)}
                    />
                </View>
            ) : null}
            {requestFailure?.workspacePreparation?.completed.length ? (
                <Text style={styles.outcomeWarningText}>
                    {t('workspaceSync.review.completedLinks', { count: requestFailure.workspacePreparation.completed.length })}
                </Text>
            ) : null}
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
            <View testID="session-handoff-primary-progress" style={styles.timeline}>
                    {PRIMARY_PROGRESS_STEPS.map((step, index) => {
                        const isCurrent = index === primaryProgressStepIndex;
                        const isDone = index < primaryProgressStepIndex || (primaryProgressStep === 'ready' && isCurrent);
                        return (
                            <View
                                key={step}
                                testID={`session-handoff-primary-step-${step}`}
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
                                    ) : isCurrent && !operationCancelled ? (
                                        <ActivitySpinner size={iconMatchedSpinnerSize(16)} color={theme.colors.accent.blue} />
                                    ) : (
                                        <View style={styles.timelineDot} />
                                    )}
                                </View>
                                <View style={[styles.timelineContent, isCurrent && primaryProgressFraction !== null ? styles.timelineContentWithProgress : null]}>
                                    <Text style={[styles.timelineLabel, isCurrent ? styles.timelineLabelCurrent : null]}>
                                        {translatePrimaryProgressStep(step)}
                                    </Text>
                                    {isCurrent && primaryProgressFraction !== null ? (
                                        <>
                                            <HappierProgress
                                                testID={operation ? 'session-handoff-operation-progress-bar' : 'session-handoff-progress-bar'}
                                                label={translatePrimaryProgressStep(step)} value={primaryProgressFraction}
                                                minimumVisibleFraction={0.04} minimumFillWidth={6} height={6}
                                                theme={presentationTheme} fillColor={theme.colors.accent.blue}
                                                trackColor={theme.colors.border.default}
                                            />
                                            <Text
                                                testID={operation ? 'session-handoff-operation-progress-percent' : 'session-handoff-progress-percent'}
                                                style={styles.progressMetaText}
                                            >
                                                {Math.round(primaryProgressFraction * 100)}%
                                            </Text>
                                        </>
                                    ) : null}
                                </View>
                            </View>
                        );
                    })}
                </View>
            {outcomeLabel ? (
                <View testID="session-handoff-workspace-outcome" style={styles.outcomeSection}>
                    <Text
                        testID="session-handoff-workspace-outcome-label"
                        style={styles.outcomeText}
                        accessibilityLiveRegion="polite"
                        role="status"
                        aria-live="polite"
                    >
                        {outcomeLabel}
                    </Text>
                    {outcomeCleanupWarning ? (
                        <Text
                            testID="session-handoff-workspace-outcome-cleanup-warning"
                            style={styles.outcomeWarningText}
                        >
                            {outcomeCleanupWarning.message}
                        </Text>
                    ) : null}
                </View>
            ) : null}
            {hasTechnicalDetails ? (
                <ItemGroup>
                    <ExpandableItem
                        testID="session-handoff-progress-details"
                        expanded={detailsExpanded}
                        onExpandedChange={setDetailsExpanded}
                        showDivider={false}
                        header={({ expanded, headerProps }) => (
                            <Item
                                {...headerProps}
                                testID="session-handoff-progress-details-toggle"
                                title={t('common.details')}
                                showChevron={false}
                                rightElement={<Icon name={expanded ? 'caret-down' : 'caret-right'} size={16} color={theme.colors.text.secondary} />}
                            />
                        )}
                    >
                        <View style={styles.detailsBody}>
                            {operation ? (
                                <View testID="session-handoff-operation-technical-details" style={styles.progressSection}>
                                    {operationTechnicalPhase ? (
                                        <Text testID="session-handoff-operation-technical-phase" style={styles.progressMetaText}>
                                            {operationTechnicalPhase}
                                        </Text>
                                    ) : null}
                                    {determinateOperationProgress ? (
                                        <Text testID="session-handoff-operation-byte-progress" style={styles.currentPath}>
                                            {formatByteSize(determinateOperationProgress.current)} / {formatByteSize(determinateOperationProgress.total)}
                                        </Text>
                                    ) : null}
                                    {operationFailed && operation.error ? (
                                        <Text
                                            testID="session-handoff-operation-error"
                                            style={styles.progressMetaText}
                                        >
                                            {operation.error.error}
                                        </Text>
                                    ) : null}
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
                                        <View style={styles.timelineContent}>
                                            <Text style={[styles.timelineLabel, isCurrent ? styles.timelineLabelCurrent : null]}>
                                                {translateCheckpoint(checkpoint)}
                                            </Text>
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
                    {currentDetailLabel ? (
                        <View style={styles.progressMetaRow}>
                            <Text testID="session-handoff-progress-path" style={styles.currentPath}>
                                {currentDetailLabel}
                            </Text>
                        </View>
                    ) : null}
                                </View>
                            ) : null}
                        </View>
                    </ExpandableItem>
                </ItemGroup>
            ) : null}
        </View>
    );
}

export default SessionHandoffProgressModal;
