import * as React from 'react';
import { Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as safeAreaContext from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

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
import {
    OverlayMotionFrame,
    resolveOverlayMotionPreset,
    useOverlayPresence,
} from '@/components/ui/overlays/motion/overlayMotion';
import { HorizontalScrollableRow } from '@/components/ui/scroll/HorizontalScrollableRow';
import { Text } from '@/components/ui/text/Text';
import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    useOptionalSessionListSelectionActions,
    useOptionalSessionListSelectionState,
} from './SessionListSelectionContext';

type MoveFolderSelection = Readonly<{
    folderId: string | null;
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
const ACTION_BAR_WEB_BOTTOM_INSET = 84;
const ACTION_BAR_NATIVE_BOTTOM_INSET = 12;
const ACTION_BAR_COMPACT_HEIGHT_THRESHOLD = 760;
const ZERO_SAFE_AREA_INSETS = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
const SafeAreaInsetsContext = (
    safeAreaContext as unknown as { SafeAreaInsetsContext?: React.Context<typeof ZERO_SAFE_AREA_INSETS | null> }
).SafeAreaInsetsContext ?? React.createContext<typeof ZERO_SAFE_AREA_INSETS | null>(ZERO_SAFE_AREA_INSETS);

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

function simpleBulkActionRequest(actionId: SessionBulkActionId): SessionBulkActionRequest | null {
    switch (actionId) {
        case SESSION_BULK_ACTION_IDS.stop:
        case SESSION_BULK_ACTION_IDS.archive:
        case SESSION_BULK_ACTION_IDS.unarchive:
        case SESSION_BULK_ACTION_IDS.markRead:
        case SESSION_BULK_ACTION_IDS.markUnread:
        case SESSION_BULK_ACTION_IDS.pin:
        case SESSION_BULK_ACTION_IDS.unpin:
            return { id: actionId };
        default:
            return null;
    }
}

const stylesheet = StyleSheet.create((theme) => ({
    host: {
        position: 'absolute',
        left: 12,
        right: 12,
        zIndex: 30,
        elevation: 30,
        alignItems: 'center',
        pointerEvents: 'box-none',
    },
    hostCompact: {
        alignItems: 'stretch',
    },
    bar: {
        minHeight: 44,
        minWidth: 180,
        maxWidth: '100%',
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        paddingHorizontal: 12,
        paddingVertical: 8,
        alignItems: 'stretch',
        justifyContent: 'center',
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: 0.18,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 6 },
        gap: 8,
    },
    barCompact: {
        width: '100%',
        paddingVertical: 6,
        gap: 6,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    countText: {
        color: theme.colors.text.primary,
    },
    actionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
    },
    actionScroll: {
        width: '100%',
        maxWidth: '100%',
    },
    actionScrollContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingRight: 4,
    },
    actionButton: {
        minHeight: 32,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 10,
        paddingVertical: 6,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    destructiveActionButton: {
        borderColor: theme.colors.state.danger.border,
        backgroundColor: theme.colors.state.danger.background,
    },
    actionButtonDisabled: {
        opacity: 0.5,
    },
    actionText: {
        color: theme.colors.text.primary,
        fontSize: 12,
    },
    destructiveActionText: {
        color: theme.colors.state.danger.foreground,
    },
    quietButton: {
        minHeight: 30,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 5,
        justifyContent: 'center',
        alignItems: 'center',
    },
    quietButtonText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    statusBox: {
        borderRadius: 8,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 10,
        paddingVertical: 8,
        gap: 6,
    },
    statusText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    statusActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
}));

export function SessionListSelectionActionBarHost(props: SessionListSelectionActionBarHostProps = {}): React.ReactElement | null {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeAreaInsets = React.useContext(SafeAreaInsetsContext) ?? ZERO_SAFE_AREA_INSETS;
    const windowDimensions = useWindowDimensions();
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const selection = useOptionalSessionListSelectionState();
    const selectionActions = useOptionalSessionListSelectionActions();
    const reducedMotion = useReducedMotionPreference();
    const [confirmAction, setConfirmAction] = React.useState<ConfirmActionState | null>(null);
    const [runningAction, setRunningAction] = React.useState<RunningActionState | null>(null);
    const [result, setResult] = React.useState<SessionBulkActionExecutionResult | null>(null);
    const cancelStateRef = React.useRef<{ cancelled: boolean } | null>(null);
    const motionPreset = React.useMemo(
        () => resolveOverlayMotionPreset({ kind: 'popover', direction: 'bottom' }),
        [],
    );
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
    const presence = useOverlayPresence(
        visible,
        reducedMotion ? 0 : motionPreset.exitMs,
    );
    const presentedCountRef = React.useRef(selection.count);
    if (selection.isSelectionMode) {
        presentedCountRef.current = selection.count;
    }
    const presentedCount = selection.isSelectionMode ? selection.count : presentedCountRef.current;
    const compactActionLayout = windowDimensions.height < ACTION_BAR_COMPACT_HEIGHT_THRESHOLD;
    const nativeActionBarBottomInset = bottomChromeHeight > 0
        ? ACTION_BAR_NATIVE_BOTTOM_INSET
        : safeAreaInsets.bottom + ACTION_BAR_NATIVE_BOTTOM_INSET;
    const actionBarBottomInset = Platform.OS === 'web'
        ? safeAreaInsets.bottom + ACTION_BAR_WEB_BOTTOM_INSET
        : nativeActionBarBottomInset;
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
                return selectedTarget ? { id: SESSION_BULK_ACTION_IDS.moveToFolder, folderId: selectedTarget.folderId } : null;
            }
            default:
                return simpleBulkActionRequest(actionId);
        }
    }, [props.onRequestMoveToFolder, selectedTargets]);

    const handleActionPress = React.useCallback(async (descriptor: SessionBulkActionDescriptor) => {
        if (runningAction) return;
        const request = await resolveActionRequest(descriptor.id);
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
    }, [executeAction, resolveActionRequest, runningAction, selectedTargets]);

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

    if (!presence.present) return null;

    const resultSummary = result ? buildSessionBulkActionResultSummary(result) : null;
    const confirmDescriptor = confirmAction?.descriptor ?? null;
    const actionButtons = actionDescriptors.map((descriptor) => {
        const iconColor = descriptor.destructive
            ? theme.colors.state.danger.foreground
            : theme.colors.text.primary;
        return (
            <Pressable
                key={descriptor.id}
                testID={`session-list-selection-action-${safeActionTestId(descriptor.id)}`}
                accessibilityRole="button"
                accessibilityLabel={descriptor.title}
                disabled={selectedTargets.length === 0}
                onPress={() => {
                    void handleActionPress(descriptor);
                }}
                style={[
                    styles.actionButton,
                    descriptor.destructive ? styles.destructiveActionButton : null,
                    selectedTargets.length === 0 ? styles.actionButtonDisabled : null,
                ]}
                {...({
                    'data-action-id': descriptor.id,
                    dataSet: { actionId: descriptor.id },
                } as Record<string, unknown>)}
            >
                <Ionicons
                    name={descriptor.icon}
                    size={14}
                    color={iconColor}
                />
                <Text
                    style={[
                        styles.actionText,
                        descriptor.destructive ? styles.destructiveActionText : null,
                    ]}
                >
                    {descriptor.title}
                </Text>
            </Pressable>
        );
    });

    return (
        <View
            testID="session-list-selection-action-bar-host"
            pointerEvents={presence.exiting ? 'none' : 'box-none'}
            style={[styles.host, compactActionLayout ? styles.hostCompact : null, { bottom: actionBarBottomInset }]}
        >
            <OverlayMotionFrame visible={visible} kind="popover" direction="bottom">
                <View
                    testID={visible ? 'session-list-selection-action-bar' : undefined}
                    style={[styles.bar, compactActionLayout ? styles.barCompact : null]}
                    {...({
                        'data-selected-count': presentedCount,
                        dataSet: { selectedCount: String(presentedCount) },
                    } as Record<string, unknown>)}
                >
                    <View style={styles.headerRow}>
                        <Text
                            testID="session-list-selection-count"
                            style={styles.countText}
                            accessibilityLabel={t('sessionsList.selectionA11ySelectedCount', { count: presentedCount })}
                            {...({
                                'data-selected-count': presentedCount,
                                dataSet: { selectedCount: String(presentedCount) },
                            } as Record<string, unknown>)}
                        >
                            {t('sessionsList.selectionSelectedCount', { count: presentedCount })}
                        </Text>
                        <View style={styles.headerActions}>
                            {hasUnselectedVisibleTargets ? (
                                <Pressable
                                    testID="session-list-selection-select-all-visible"
                                    accessibilityRole="button"
                                    accessibilityLabel={t('sessionsList.selectionSelectAllVisibleA11yLabel')}
                                    onPress={() => selectionActions?.selectAllVisible()}
                                    style={styles.quietButton}
                                >
                                    <Text style={styles.quietButtonText}>{t('sessionsList.selectionSelectAllVisible')}</Text>
                                </Pressable>
                            ) : null}
                            <Pressable
                                testID="session-list-selection-cancel"
                                accessibilityRole="button"
                                accessibilityLabel={t('sessionsList.selectionCancelA11yLabel')}
                                onPress={handleCancelSelection}
                                style={styles.quietButton}
                            >
                                <Text style={styles.quietButtonText}>{t('common.cancel')}</Text>
                            </Pressable>
                        </View>
                    </View>

                    {runningAction ? (
                        <View
                            testID="session-list-selection-progress"
                            style={styles.statusBox}
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
                        >
                            <Text style={styles.statusText}>
                                {t('sessionsList.selectionProgress', {
                                    completed: runningAction.progress.completed,
                                    total: runningAction.progress.total,
                                })}
                            </Text>
                            <View style={styles.statusActions}>
                                <Pressable
                                    testID="session-list-selection-cancel-running"
                                    accessibilityRole="button"
                                    accessibilityLabel={t('sessionsList.selectionCancelRunningA11yLabel')}
                                    onPress={handleCancelRunningAction}
                                    style={styles.quietButton}
                                >
                                    <Text style={styles.quietButtonText}>{t('common.cancel')}</Text>
                                </Pressable>
                            </View>
                        </View>
                    ) : null}

                    {result && resultSummary ? (
                        <View
                            testID="session-list-selection-result"
                            style={styles.statusBox}
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
                        >
                            <Text style={styles.statusText}>
                                {t('sessionsList.selectionResult', {
                                    succeeded: resultSummary.succeededCount,
                                    failed: resultSummary.failedCount,
                                    skipped: resultSummary.skippedCount,
                                })}
                            </Text>
                            <View style={styles.statusActions}>
                                <Pressable
                                    testID="session-list-selection-result-dismiss"
                                    accessibilityRole="button"
                                    accessibilityLabel={t('sessionsList.selectionDismissResultA11yLabel')}
                                    onPress={handleDismissResult}
                                    style={styles.quietButton}
                                >
                                    <Text style={styles.quietButtonText}>{t('common.done')}</Text>
                                </Pressable>
                            </View>
                        </View>
                    ) : null}

                    {!runningAction && !result && !confirmAction ? (
                        compactActionLayout ? (
                            <HorizontalScrollableRow
                                testID="session-list-selection-actions-scroll"
                                contentTestID="session-list-selection-actions-scroll-content"
                                fadeColor={theme.colors.surface.elevated}
                                indicatorColor={theme.colors.text.secondary}
                                containerStyle={styles.actionScroll}
                                contentStyle={styles.actionScrollContent}
                            >
                                {actionButtons}
                            </HorizontalScrollableRow>
                        ) : (
                            <View style={styles.actionRow}>
                                {actionButtons}
                            </View>
                        )
                    ) : null}

                    {confirmAction && confirmDescriptor && !runningAction ? (
                        <View style={styles.statusBox}>
                            <Text style={styles.statusText}>
                                {t('sessionsList.selectionConfirm', {
                                    action: confirmDescriptor.title,
                                    count: confirmAction.targets.length,
                                })}
                            </Text>
                            <View style={styles.statusActions}>
                                <Pressable
                                    testID={`session-list-selection-confirm-${safeActionTestId(confirmAction.request.id)}`}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('sessionsList.selectionConfirmA11yLabel', { action: confirmDescriptor.title })}
                                    onPress={() => {
                                        void executeAction(confirmAction.request, confirmAction.targets);
                                    }}
                                    style={[
                                        styles.actionButton,
                                        confirmDescriptor.destructive ? styles.destructiveActionButton : null,
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.actionText,
                                            confirmDescriptor.destructive ? styles.destructiveActionText : null,
                                        ]}
                                    >
                                        {confirmDescriptor.title}
                                    </Text>
                                </Pressable>
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.cancel')}
                                    onPress={() => setConfirmAction(null)}
                                    style={styles.quietButton}
                                >
                                    <Text style={styles.quietButtonText}>{t('common.cancel')}</Text>
                                </Pressable>
                            </View>
                        </View>
                    ) : null}
                </View>
            </OverlayMotionFrame>
        </View>
    );
}
