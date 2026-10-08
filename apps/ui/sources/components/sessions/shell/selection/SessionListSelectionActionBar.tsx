import * as React from 'react';
import type { HappierSelectionActionBarAction } from '@happier-dev/plugin-ui/presentation';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    executeSessionBulkAction,
    SESSION_BULK_ACTION_IDS,
    type SessionBulkActionExecutionContext,
    type SessionBulkActionExecutionResult,
    type SessionBulkActionId,
    type SessionBulkActionProgressSnapshot,
    type SessionBulkActionRequest,
    type SessionBulkActionTarget,
} from '@/components/sessions/actions/sessionBulkActionExecution';
import {
    listSessionBulkActionDescriptors,
    type SessionBulkActionDescriptor,
} from '@/components/sessions/actions/sessionBulkActionPresentation';
import { buildSessionBulkActionResultSummary } from '@/components/sessions/actions/sessionActionResultMessages';
import { SelectionActionBar } from '@/components/ui/selection/SelectionActionBar';
import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useOptionalSafeAreaInsets } from '@/hooks/ui/useOptionalSafeAreaInsets';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';
import {
    useOptionalSessionListSelectionActions,
    useOptionalSessionListSelectionState,
} from './SessionListSelectionContext';
import { resolveSelectionActionBarBottomInset } from './selectionActionBarBottomInset';
import { Icon } from '@/components/ui/icons/Icon';

type MoveFolderSelection = Readonly<{
    folderId: string | null;
    destinationWorkspace: SessionFolderWorkspaceRefV1;
}>;

export type SessionListSelectionActionBarHostProps = Readonly<{
    targetsByKey?: ReadonlyMap<string, SessionBulkActionTarget> | null;
    bulkActionContext?: SessionBulkActionExecutionContext | null;
    tagsEnabled?: boolean;
    onRequestMoveToFolder?: ((targets: readonly SessionBulkActionTarget[]) => Promise<MoveFolderSelection | null>) | null;
}>;

type RunningActionState = Readonly<{
    actionId: SessionBulkActionId;
    progress: SessionBulkActionProgressSnapshot;
}>;

type ConfirmActionState = Readonly<{
    request: SessionBulkActionRequest;
    descriptor: SessionBulkActionDescriptor;
    targets: readonly SessionBulkActionTarget[];
}>;

const EMPTY_TARGETS: readonly SessionBulkActionTarget[] = Object.freeze([]);

function safeActionTestId(actionId: string): string {
    const stableActionId = actionId.startsWith('ui.') ? actionId.slice(3) : actionId;
    return stableActionId.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function parsePromptTags(value: string | null): string[] | null {
    if (value == null) return null;
    const tags = Array.from(new Set(value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)));
    return tags.length > 0 ? tags : null;
}

function createInitialProgress(total: number): SessionBulkActionProgressSnapshot {
    return {
        total,
        queued: total,
        running: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        cancelled: 0,
        completed: 0,
        status: total > 0 ? 'running' : 'idle',
    };
}

function buildFailureResult(params: Readonly<{
    actionId: SessionBulkActionId;
    targets: readonly SessionBulkActionTarget[];
    reason: string;
}>): SessionBulkActionExecutionResult {
    const results = params.targets.map((target) => ({
        target,
        status: 'failed' as const,
        reason: params.reason,
    }));
    const progress: SessionBulkActionProgressSnapshot = {
        total: params.targets.length,
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: params.targets.length,
        skipped: 0,
        cancelled: 0,
        completed: params.targets.length,
        status: 'complete',
    };
    return {
        actionId: params.actionId,
        targetCount: params.targets.length,
        results,
        succeeded: [],
        failed: results,
        skipped: [],
        cancelled: [],
        remainingSelectedKeys: params.targets.map((target) => target.key),
        progress,
    };
}

function reasonFromUnknown(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message;
    if (typeof error === 'string' && error.trim()) return error;
    return t('errors.unknownError');
}

/**
 * Every bulk id whose request needs no extra input. Exhaustive over `SessionBulkActionId` on
 * purpose: an id that falls through here renders a button the bar then drops on its null request,
 * so a missing case is a silently inert action rather than a compile error. The ids that genuinely
 * need input are listed and returned as null, and `resolveActionRequest` intercepts them before
 * delegating here.
 */
function simpleBulkActionRequest(actionId: SessionBulkActionId): SessionBulkActionRequest | null {
    switch (actionId) {
        case SESSION_BULK_ACTION_IDS.stop:
        case SESSION_BULK_ACTION_IDS.archive:
        case SESSION_BULK_ACTION_IDS.unarchive:
        case SESSION_BULK_ACTION_IDS.markRead:
        case SESSION_BULK_ACTION_IDS.markUnread:
        case SESSION_BULK_ACTION_IDS.setAttentionStanding:
        case SESSION_BULK_ACTION_IDS.clearAttentionStanding:
        case SESSION_BULK_ACTION_IDS.pin:
        case SESSION_BULK_ACTION_IDS.unpin:
            return { id: actionId };
        case SESSION_BULK_ACTION_IDS.tagsAdd:
        case SESSION_BULK_ACTION_IDS.tagsRemove:
        case SESSION_BULK_ACTION_IDS.tagsSet:
        case SESSION_BULK_ACTION_IDS.moveToFolder:
            return null;
        default: {
            const unreachable: never = actionId;
            return unreachable;
        }
    }
}

const stylesheet = StyleSheet.create(() => ({
    // Placement only: the bar floats over the list above the bottom chrome. Its anatomy is the shared
    // selection bar's.
    host: {
        position: 'absolute',
        left: 12,
        right: 12,
        zIndex: 30,
        elevation: 30,
        alignItems: 'center',
        pointerEvents: 'box-none',
    },
    stateMarker: {
        position: 'absolute',
        width: 0,
        height: 0,
        overflow: 'hidden',
    },
}));

export function SessionListSelectionActionBarHost(props: SessionListSelectionActionBarHostProps = {}): React.ReactElement | null {
    const styles = stylesheet;
    const safeAreaInsets = useOptionalSafeAreaInsets();
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const selection = useOptionalSessionListSelectionState();
    const selectionActions = useOptionalSessionListSelectionActions();
    const [confirmAction, setConfirmAction] = React.useState<ConfirmActionState | null>(null);
    const [runningAction, setRunningAction] = React.useState<RunningActionState | null>(null);
    const [result, setResult] = React.useState<SessionBulkActionExecutionResult | null>(null);
    const cancelStateRef = React.useRef<{ cancelled: boolean } | null>(null);
    const selectedTargets = React.useMemo(() => {
        const targetsByKey = props.targetsByKey;
        if (!targetsByKey || selection.selectedKeys.size === 0) return EMPTY_TARGETS;
        const targets: SessionBulkActionTarget[] = [];
        for (const key of selection.selectedKeys) {
            const target = targetsByKey.get(key);
            if (target) targets.push(target);
        }
        return targets;
    }, [props.targetsByKey, selection.selectedKeys, selection.visibleOrderedKeys]);
    const actionDescriptors = React.useMemo(() => listSessionBulkActionDescriptors({
        targets: selectedTargets,
        tagsEnabled: props.tagsEnabled === true,
        moveEnabled: typeof props.onRequestMoveToFolder === 'function',
    }), [props.onRequestMoveToFolder, props.tagsEnabled, selectedTargets]);
    const visible = selection.isSelectionMode || runningAction !== null || result !== null || confirmAction !== null;
    const presentedCountRef = React.useRef(selection.count);
    if (selection.isSelectionMode) {
        presentedCountRef.current = selection.count;
    }
    const presentedCount = selection.isSelectionMode ? selection.count : presentedCountRef.current;
    const actionBarBottomInset = resolveSelectionActionBarBottomInset({
        bottomChromeHeight,
        safeAreaBottom: safeAreaInsets.bottom,
        isWeb: Platform.OS === 'web',
    });
    const visibleEligibleKeys = React.useMemo(() => selection.visibleOrderedKeys.filter((key) => (
        selection.eligibleKeys.has(key) && props.targetsByKey?.has(key) === true
    )), [props.targetsByKey, selection.eligibleKeys, selection.visibleOrderedKeys]);
    const hasUnselectedVisibleTargets = visibleEligibleKeys.some((key) => !selection.selectedKeys.has(key));

    const applyRemainingSelection = React.useCallback((nextResult: SessionBulkActionExecutionResult) => {
        selectionActions?.setSelectedKeys(nextResult.remainingSelectedKeys);
    }, [selectionActions]);

    const executeAction = React.useCallback(async (
        action: SessionBulkActionRequest,
        targetSnapshot: readonly SessionBulkActionTarget[] = selectedTargets,
    ) => {
        if (!selectionActions) return;
        setConfirmAction(null);
        setResult(null);
        const targets = [...targetSnapshot];
        cancelStateRef.current = { cancelled: false };
        setRunningAction({
            actionId: action.id,
            progress: createInitialProgress(targets.length),
        });
        try {
            const nextResult = await executeSessionBulkAction({
                action,
                targets,
                context: {
                    ...(props.bulkActionContext ?? {}),
                    cancelSignal: {
                        isCancelled: () => cancelStateRef.current?.cancelled === true,
                    },
                    onProgress: (progress) => {
                        setRunningAction({
                            actionId: action.id,
                            progress,
                        });
                        props.bulkActionContext?.onProgress?.(progress);
                    },
                },
            });
            setResult(nextResult);
            applyRemainingSelection(nextResult);
        } catch (error) {
            const failedResult = buildFailureResult({
                actionId: action.id,
                targets,
                reason: reasonFromUnknown(error),
            });
            setResult(failedResult);
            applyRemainingSelection(failedResult);
        } finally {
            cancelStateRef.current = null;
            setRunningAction(null);
        }
    }, [applyRemainingSelection, props.bulkActionContext, selectedTargets, selectionActions]);

    const resolveActionRequest = React.useCallback(async (actionId: SessionBulkActionId): Promise<SessionBulkActionRequest | null> => {
        switch (actionId) {
            case SESSION_BULK_ACTION_IDS.tagsAdd:
            case SESSION_BULK_ACTION_IDS.tagsRemove:
            case SESSION_BULK_ACTION_IDS.tagsSet: {
                const prompted = await Modal.prompt(
                    actionId === SESSION_BULK_ACTION_IDS.tagsRemove
                        ? t('sessionsList.selectionRemoveTagsPromptTitle')
                        : actionId === SESSION_BULK_ACTION_IDS.tagsSet
                            ? t('sessionsList.selectionSetTagsPromptTitle')
                            : t('sessionsList.selectionAddTagsPromptTitle'),
                    t('sessionsList.selectionTagsPromptMessage'),
                    {
                        placeholder: t('sessionsList.selectionTagsPlaceholder'),
                        confirmText: actionId === SESSION_BULK_ACTION_IDS.tagsRemove ? t('common.remove') : t('common.save'),
                        cancelText: t('common.cancel'),
                    },
                );
                const tags = parsePromptTags(prompted);
                return tags ? { id: actionId, tags } : null;
            }
            case SESSION_BULK_ACTION_IDS.moveToFolder: {
                const selectedTarget = await props.onRequestMoveToFolder?.(selectedTargets);
                return selectedTarget
                    ? {
                        id: SESSION_BULK_ACTION_IDS.moveToFolder,
                        folderId: selectedTarget.folderId,
                        destinationWorkspace: selectedTarget.destinationWorkspace,
                    }
                    : null;
            }
            default:
                return simpleBulkActionRequest(actionId);
        }
    }, [props.onRequestMoveToFolder, selectedTargets]);

    const handleActionPress = React.useCallback(async (descriptor: SessionBulkActionDescriptor) => {
        if (runningAction) return;
        let request: SessionBulkActionRequest | null;
        try {
            request = await resolveActionRequest(descriptor.id);
        } catch (error) {
            const failedResult = buildFailureResult({
                actionId: descriptor.id,
                targets: selectedTargets,
                reason: reasonFromUnknown(error),
            });
            setResult(failedResult);
            applyRemainingSelection(failedResult);
            return;
        }
        if (!request) return;
        if (descriptor.requiresConfirmation) {
            setResult(null);
            setConfirmAction({
                request,
                descriptor,
                targets: [...selectedTargets],
            });
            return;
        }
        await executeAction(request);
    }, [applyRemainingSelection, executeAction, resolveActionRequest, runningAction, selectedTargets]);

    const handleCancelRunningAction = React.useCallback(() => {
        if (!cancelStateRef.current) return;
        cancelStateRef.current.cancelled = true;
    }, []);

    const handleDismissResult = React.useCallback(() => {
        setResult(null);
        if (selection.count === 0) {
            selectionActions?.exit();
        }
    }, [selection.count, selectionActions]);

    const handleCancelSelection = React.useCallback(() => {
        setConfirmAction(null);
        setResult(null);
        selectionActions?.exit();
    }, [selectionActions]);

    React.useEffect(() => {
        if (selection.isSelectionMode && selection.count > 0) return;
        setConfirmAction(null);
    }, [selection.count, selection.isSelectionMode]);

    const resultSummary = result ? buildSessionBulkActionResultSummary(result) : null;
    const confirmDescriptor = confirmAction?.descriptor ?? null;
    // One bar, four states (ui-primitives-audit §4): this host keeps the execution state and hands the
    // shared bar the label, actions and dismiss for the state it is in.
    const barState: Readonly<{
        label: string;
        labelAccessibilityLabel?: string;
        labelTestID?: string;
        actions: readonly HappierSelectionActionBarAction[];
        dismiss: React.ComponentProps<typeof SelectionActionBar>['dismiss'];
    }> = runningAction
        ? {
            label: t('sessionsList.selectionProgress', {
                completed: runningAction.progress.completed,
                total: runningAction.progress.total,
            }),
            actions: [],
            dismiss: {
                testID: 'session-list-selection-cancel-running',
                label: t('common.cancel'),
                presentation: 'label',
                onPress: handleCancelRunningAction,
            },
        }
        : result && resultSummary
            ? {
                label: t('sessionsList.selectionResult', {
                    succeeded: resultSummary.succeededCount,
                    failed: resultSummary.failedCount,
                    skipped: resultSummary.skippedCount,
                }),
                actions: [],
                dismiss: {
                    testID: 'session-list-selection-result-dismiss',
                    label: t('common.done'),
                    presentation: 'label',
                    onPress: handleDismissResult,
                },
            }
            : confirmAction && confirmDescriptor
                ? {
                    label: t('sessionsList.selectionConfirm', {
                        action: confirmDescriptor.title,
                        count: confirmAction.targets.length,
                    }),
                    actions: [{
                        id: confirmAction.request.id,
                        testID: `session-list-selection-confirm-${safeActionTestId(confirmAction.request.id)}`,
                        label: confirmDescriptor.title,
                        accessibilityLabel: t('sessionsList.selectionConfirmA11yLabel', { action: confirmDescriptor.title }),
                        emphasis: confirmDescriptor.destructive ? 'destructive' : 'primary',
                        onPress: () => executeAction(confirmAction.request, confirmAction.targets),
                    }],
                    dismiss: {
                        label: t('common.cancel'),
                        presentation: 'label',
                        onPress: () => setConfirmAction(null),
                    },
                }
                : {
                    label: t('sessionsList.selectionSelectedCount', { count: presentedCount }),
                    labelAccessibilityLabel: t('sessionsList.selectionA11ySelectedCount', { count: presentedCount }),
                    labelTestID: 'session-list-selection-count-label',
                    actions: [
                        ...actionDescriptors.map((descriptor): HappierSelectionActionBarAction => ({
                            id: descriptor.id,
                            testID: `session-list-selection-action-${safeActionTestId(descriptor.id)}`,
                            label: descriptor.title,
                            emphasis: descriptor.destructive ? 'destructive' : 'secondary',
                            disabled: selectedTargets.length === 0,
                            renderIcon: (color) => <Icon name={descriptor.icon} size={14} color={color} />,
                            onPress: () => handleActionPress(descriptor),
                        })),
                        ...(hasUnselectedVisibleTargets ? [{
                            id: 'select-all-visible',
                            testID: 'session-list-selection-select-all-visible',
                            label: t('sessionsList.selectionSelectAllVisible'),
                            accessibilityLabel: t('sessionsList.selectionSelectAllVisibleA11yLabel'),
                            onPress: () => selectionActions?.selectAllVisible(),
                        }] : []),
                    ],
                    dismiss: {
                        testID: 'session-list-selection-cancel',
                        label: t('sessionsList.selectionCancelA11yLabel'),
                        onPress: handleCancelSelection,
                    },
                };

    return (
        <View
            testID="session-list-selection-action-bar-host"
            pointerEvents="box-none"
            style={[styles.host, { bottom: actionBarBottomInset }]}
        >
            <SelectionActionBar
                visible={visible}
                testID={visible ? 'session-list-selection-action-bar' : undefined}
                accessibilityLabel={t('sessionsList.selectionA11ySelectedCount', { count: presentedCount })}
                label={barState.label}
                labelAccessibilityLabel={barState.labelAccessibilityLabel}
                labelTestID={barState.labelTestID}
                actions={barState.actions}
                dismiss={barState.dismiss}
            />
            {/* Machine-readable state for the e2e contract (sessionList.multiSelectActions.spec): state
                markers only, no chrome — the bar above is the one visible surface. */}
            {visible ? (
                <View
                    testID="session-list-selection-count"
                    style={styles.stateMarker}
                    {...({
                        'data-selected-count': presentedCount,
                        dataSet: { selectedCount: String(presentedCount) },
                    } as Record<string, unknown>)}
                />
            ) : null}
            {runningAction ? (
                <View
                    testID="session-list-selection-progress"
                    style={styles.stateMarker}
                    {...({
                        'data-action-id': runningAction.actionId,
                        'data-total-count': runningAction.progress.total,
                        'data-completed-count': runningAction.progress.completed,
                        dataSet: {
                            actionId: runningAction.actionId,
                            totalCount: String(runningAction.progress.total),
                            completedCount: String(runningAction.progress.completed),
                        },
                    } as Record<string, unknown>)}
                />
            ) : null}
            {result && resultSummary ? (
                <View
                    testID="session-list-selection-result"
                    style={styles.stateMarker}
                    {...({
                        'data-action-id': result.actionId,
                        'data-succeeded-count': resultSummary.succeededCount,
                        'data-failed-count': resultSummary.failedCount,
                        'data-skipped-count': resultSummary.skippedCount,
                        'data-cancelled-count': resultSummary.cancelledCount,
                        dataSet: {
                            actionId: result.actionId,
                            succeededCount: String(resultSummary.succeededCount),
                            failedCount: String(resultSummary.failedCount),
                            skippedCount: String(resultSummary.skippedCount),
                            cancelledCount: String(resultSummary.cancelledCount),
                        },
                    } as Record<string, unknown>)}
                />
            ) : null}
        </View>
    );
}
