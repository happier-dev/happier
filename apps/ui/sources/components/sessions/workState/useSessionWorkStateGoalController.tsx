import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Modal } from '@/modal';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { getErrorMessage } from '@/utils/errors/getErrorMessage';
import { resolveSessionGoalFailurePresentation } from '@/sync/ops/sessionGoalOperationFailure';
import type { SessionWorkStateSnapshot } from '@/sync/domains/session/workState/sessionWorkStateTypes';

import type { GoalActionCapabilities } from './goalActionVisibility';
import { SessionGoalControlContent } from './SessionGoalControlContent';
import type { SessionGoalContinuationContext } from './sessionGoalContinuation';
import { useSessionKeepGoingTrigger } from './useSessionKeepGoingTrigger';
import {
    GOAL_CONFIRMATION_TIMEOUT_MS,
    IDLE_GOAL_CONFIRMATION,
    beginGoalConfirmation,
    goalSignature,
    isNoOpGoalMutation,
    markGoalConfirmationSlow,
    resolveGoalConfirmation,
    type SessionWorkStateGoalOperationResult,
    type SessionWorkStateGoalSetRequest,
} from './sessionGoalMutationModel';
import {
    omitGoalItemFromSnapshot,
    resolveEditableGoalItem,
    resolveGoalCreationControlsVisible,
    resolveGoalManagementControlsVisible,
} from './sessionGoalSelectors';
import { SessionTaskListContent } from './SessionTaskListContent';
import { groupSessionWorkStateItems } from './sessionWorkStatePresentation';

// Re-exported for the chip/popover/content surfaces that consume these contracts through the
// controller barrel (single import site preserved; the definitions now live in the mutation model).
export type { SessionWorkStateGoalOperationResult, SessionWorkStateGoalSetRequest };

/**
 * Single owner of the session goal/work-state popover behavior (draft, busy, mutations, dirty-close
 * guard, and content render). Both the above-input work-state badge popover and the AgentInput goal
 * chip popover consume this controller so there is exactly one editable-goal implementation (D4 —
 * single goal read/edit seam in the UI; eliminates the duplicated dirtyRef guard + private findGoal).
 * Ported from remote-dev by intent, adapted to dev's `@/sync/...` type paths and the
 * `goalActionCapabilityProfile` prop convention (D-5).
 */
export function useSessionWorkStateGoalController(params: Readonly<{
    open: boolean;
    snapshot: SessionWorkStateSnapshot | null;
    editableGoal: boolean;
    /**
     * Provider capability profile for the set-first-goal form (no goal item yet). Restricts the
     * control surface (e.g. Claude: edit/clear only, no budget). Ignored once a goal item carries
     * its own `goalCapabilities`.
     */
    goalActionCapabilityProfile?: GoalActionCapabilities | null;
    /**
     * Optional Active Workflows section (UIW3), rendered between the goal controls and the task list.
     * Owned by `SessionWorkflowActivitySection`; the goal controller only slots it so it stays focused
     * on goal editing.
     */
    workflowSection?: React.ReactNode;
    /**
     * Whether this surface is allowed to show the set-first-goal form when no goal exists yet.
     * The AgentInput goal chip is the creation affordance; the above-composer work-state popover
     * should only show goal controls once there is an actual goal to inspect/edit.
     */
    showEmptyGoalControls?: boolean;
    /**
     * The Goal control's continuation owner (FIN 04 §5.5): the session and its opened runtime's native
     * goal signal. Only the composer's Goal control passes it; the trigger list is read while open.
     */
    continuation?: SessionGoalContinuationContext | null;
    /** The opening control already names the goal's state (the work-state badge's `namesGoalStatus`). */
    goalStatusShownByAnchor?: boolean;
    onRequestClose: () => void;
    onSetGoal?: (request: SessionWorkStateGoalSetRequest, signal?: AbortSignal) => Promise<SessionWorkStateGoalOperationResult>;
    onClearGoal?: (signal?: AbortSignal) => Promise<SessionWorkStateGoalOperationResult>;
}>): Readonly<{ content: React.ReactNode; guardedRequestClose: () => Promise<void>; dirty: boolean }> {
    const { theme } = useUnistyles();
    const goal = resolveEditableGoalItem(params.snapshot);
    const allowEmptyGoalControls = params.showEmptyGoalControls ?? true;
    const renderGoalControls = allowEmptyGoalControls
        ? resolveGoalCreationControlsVisible({ editableGoal: params.editableGoal })
        : resolveGoalManagementControlsVisible({ editableGoal: params.editableGoal, snapshot: params.snapshot });
    const taskListSnapshot = renderGoalControls ? omitGoalItemFromSnapshot(params.snapshot, goal?.id ?? null) : params.snapshot;
    const continuation = params.continuation ?? null;
    const keepGoing = useSessionKeepGoingTrigger({
        target: continuation ? { sessionId: continuation.sessionId, machineId: continuation.machineId } : null,
        enabled: params.open && continuation !== null && renderGoalControls && goal !== null,
    });
    const [draftObjective, setDraftObjective] = React.useState(goal?.title ?? '');
    const [busy, setBusy] = React.useState(false);
    // After an acknowledged set, hold a "setting goal…" pending confirmation keyed by the goal
    // signature at request time, so we can detect when the work-state actually reflects the change.
    // If the confirmation is slow (G-5: the /goal inject is often queued behind an in-flight turn)
    // the pending state stays and only its copy softens — it never becomes an error.
    const [confirmation, setConfirmation] = React.useState(IDLE_GOAL_CONFIRMATION);
    const currentSignature = goalSignature(goal);

    React.useEffect(() => {
        if (!params.open) return;
        setDraftObjective(goal?.title ?? '');
    }, [goal?.title, params.open]);

    const open = params.open;
    const onRequestClose = params.onRequestClose;
    const onSetGoal = params.onSetGoal;
    const onClearGoal = params.onClearGoal;
    // A dismissed surface no longer owns completion UI for its outstanding request. The RPC may
    // still commit natively; its later snapshot remains authoritative when the control is reopened.
    const mutationLifetimeRef = React.useRef({ active: open, cancellation: new AbortController() });
    React.useEffect(() => {
        const lifetime = { active: open, cancellation: new AbortController() };
        mutationLifetimeRef.current = lifetime;
        if (!open) {
            setBusy(false);
            setConfirmation(IDLE_GOAL_CONFIRMATION);
        }
        return () => {
            lifetime.active = false;
            lifetime.cancellation.abort();
        };
    }, [open]);

    const closeGoalControl = React.useCallback(() => {
        mutationLifetimeRef.current.active = false;
        mutationLifetimeRef.current.cancellation.abort();
        setBusy(false);
        setConfirmation(IDLE_GOAL_CONFIRMATION);
        onRequestClose();
    }, [onRequestClose]);

    // Confirmation: once the work-state signature moves off the captured baseline, the mutation has
    // been observed natively — close the popover and drop the pending state.
    React.useEffect(() => {
        if (!open || confirmation.phase !== 'pending') return;
        if (resolveGoalConfirmation(confirmation, currentSignature).phase === 'idle') {
            closeGoalControl();
        }
    }, [closeGoalControl, confirmation, currentSignature, open]);

    // Timeout: if confirmation is slow (commonly the /goal inject is queued behind an in-flight turn),
    // do NOT tear the pending state down or raise an error — soften the copy and keep waiting. It
    // auto-resolves the moment the native work-state confirms.
    React.useEffect(() => {
        if (confirmation.phase !== 'pending' || confirmation.slow) return;
        const timer = setTimeout(() => {
            setConfirmation((prev) => markGoalConfirmationSlow(prev));
        }, GOAL_CONFIRMATION_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [confirmation]);

    const pending = confirmation.phase === 'pending';
    const confirmationSlow = pending && confirmation.slow;
    const mutating = busy || pending;
    // While a mutation is in flight or pending confirmation the draft is committed; do not treat it
    // as unsaved work for the dirty-close guard.
    const dirty = !mutating && draftObjective.trim() !== (goal?.title ?? '').trim();

    const guardedRequestClose = React.useCallback(async () => {
        const lifetime = mutationLifetimeRef.current;
        if (dirty) {
            const discard = await Modal.confirm(
                t('session.workState.dirtyCloseTitle'),
                t('session.workState.dirtyCloseBody'),
                { confirmText: t('common.discard'), destructive: true },
            );
            if (!discard) return;
        }
        if (lifetime.active) closeGoalControl();
    }, [closeGoalControl, dirty]);

    const runGoalMutation = React.useCallback(async (request: SessionWorkStateGoalSetRequest) => {
        if (!onSetGoal) return;
        const lifetime = mutationLifetimeRef.current;
        if (!lifetime.active) return;
        const baseline = goalSignature(goal);
        setBusy(true);
        const noOp = isNoOpGoalMutation(goal, request);
        try {
            const result = await onSetGoal(request, lifetime.cancellation.signal);
            if (!lifetime.active) return;
            if (result.ok) {
                if (noOp) {
                    // No native work-state change will arrive (the source dedupes), so do not
                    // strand the popover in "setting goal…" — the request is already satisfied (D-3).
                    closeGoalControl();
                } else {
                    // Keep the popover open in a pending state until the native work-state confirms.
                    setConfirmation(beginGoalConfirmation(baseline));
                }
            } else {
                closeGoalControl();
                const presentation = resolveSessionGoalFailurePresentation(result);
                Modal.alert(presentation.title, presentation.message);
            }
        } catch (error) {
            if (!lifetime.active) return;
            closeGoalControl();
            const presentation = resolveSessionGoalFailurePresentation({
                ok: false,
                error: getErrorMessage(error) || t('session.workState.goal.errorUnknown'),
            });
            Modal.alert(presentation.title, presentation.message);
        } finally {
            if (lifetime.active) setBusy(false);
        }
    }, [closeGoalControl, goal, onSetGoal]);

    const clearGoal = React.useCallback(async () => {
        if (!onClearGoal) return;
        const lifetime = mutationLifetimeRef.current;
        // U-2: confirm BEFORE closing the popover so declining the destructive prompt keeps the
        // surface open instead of dismissing it out from under the user.
        const confirmed = await Modal.confirm(
            t('session.workState.goal.clearTitle'),
            t('session.workState.goal.clearBody'),
            { confirmText: t('session.workState.goal.clear'), destructive: true },
        );
        if (!confirmed || !lifetime.active) return;
        setBusy(true);
        try {
            const result = await onClearGoal(lifetime.cancellation.signal);
            if (!lifetime.active) return;
            closeGoalControl();
            if (!result.ok) {
                const presentation = resolveSessionGoalFailurePresentation(result);
                Modal.alert(presentation.title, presentation.message);
                return;
            }
        } catch (error) {
            if (!lifetime.active) return;
            closeGoalControl();
            const presentation = resolveSessionGoalFailurePresentation({
                ok: false,
                error: getErrorMessage(error) || t('session.workState.goal.errorUnknown'),
            });
            Modal.alert(presentation.title, presentation.message);
        } finally {
            if (lifetime.active) setBusy(false);
        }
    }, [closeGoalControl, onClearGoal]);

    const resumeGoal = React.useCallback(async () => {
        if (goal?.statusReason !== 'budgetLimited') {
            await runGoalMutation({ status: 'active' });
            return;
        }

        const confirmed = await Modal.confirm(
            t('session.workState.goal.statusBudgetLimited'),
            t('session.workState.goal.budgetReachedBody'),
            {
                cancelText: t('common.cancel'),
                confirmText: t('session.workState.goal.removeBudgetAndResume'),
            },
        );
        if (!confirmed) return;

        await runGoalMutation({ status: 'active', tokenBudget: null });
    }, [goal?.statusReason, runGoalMutation]);

    // U-7: goal / workflow / tasks stack with a hairline divider between present sections instead of
    // one uniform gap, so a busy popover reads as distinct landmarks rather than "soup".
    const taskGroups = groupSessionWorkStateItems(taskListSnapshot);
    const hasTasks =
        taskGroups.active.length > 0
        || taskGroups.pending.length > 0
        || taskGroups.blockedPaused.length > 0
        || taskGroups.done.length > 0;
    const mainSections: { key: string; node: React.ReactNode }[] = [];
    if (renderGoalControls) {
        mainSections.push({
            key: 'goal',
            node: (
                <SessionGoalControlContent
                    goal={goal}
                    goalActionCapabilityProfile={params.goalActionCapabilityProfile ?? null}
                    draftObjective={draftObjective}
                    onDraftObjectiveChange={setDraftObjective}
                    onSave={(budgetDraft) => {
                        const objective = draftObjective.trim();
                        if (!objective) return;
                        const request: {
                            objective: string;
                            status?: 'active';
                            tokenBudget?: number | null;
                            resumeInactiveWithInitialGoal: false;
                        } = { objective, resumeInactiveWithInitialGoal: false };
                        if (goal?.status === 'complete' || goal?.statusReason === 'budgetLimited') {
                            request.status = 'active';
                        }
                        if (budgetDraft.tokenBudgetChanged) {
                            request.tokenBudget = budgetDraft.tokenBudget;
                        }
                        void runGoalMutation(request);
                    }}
                    onPause={() => { void runGoalMutation({ status: 'paused' }); }}
                    onResume={() => { void resumeGoal(); }}
                    onComplete={() => { void runGoalMutation({ status: 'complete' }); }}
                    onClear={clearGoal}
                    onCancel={() => { void guardedRequestClose(); }}
                    busy={mutating}
                    statusShownByAnchor={params.goalStatusShownByAnchor === true}
                    continuation={continuation ? {
                        nativeGoalOwner: continuation.nativeGoalOwner,
                        agentLabel: continuation.agentLabel,
                        keepGoing,
                    } : null}
                />
            ),
        });
    }
    if (params.workflowSection) {
        mainSections.push({ key: 'workflow', node: params.workflowSection });
    }
    if (hasTasks) {
        mainSections.push({
            key: 'tasks',
            node: (
                <SessionTaskListContent
                    snapshot={taskListSnapshot}
                    primaryItemId={taskListSnapshot?.primaryItemId ?? null}
                />
            ),
        });
    }
    // U-15: nothing to show (no goal, no workflows, no tasks) renders a muted placeholder instead of
    // an empty padded box. Transient status rows (pending/slow) do not count as content.
    const showEmptyPlaceholder = mainSections.length === 0 && !pending && !confirmationSlow;

    const content = (
        <View
            testID="session-work-state-popover"
            style={styles.content}
        >
            {pending ? (
                <View testID="session-goal-pending" style={styles.statusRow}>
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    <Text style={[styles.pendingText, { color: theme.colors.text.secondary }]}>
                        {t('session.workState.goal.pending')}
                    </Text>
                </View>
            ) : null}
            {confirmationSlow ? (
                <View testID="session-goal-pending-slow" style={styles.statusRow}>
                    <Text style={[styles.slowText, { color: theme.colors.text.secondary }]}>
                        {t('session.workState.goal.stillWaiting')}
                    </Text>
                </View>
            ) : null}
            {mainSections.map((section, index) => (
                <React.Fragment key={section.key}>
                    {index > 0 ? (
                        <View
                            testID={`session-work-state-divider-${section.key}`}
                            style={[styles.sectionDivider, { backgroundColor: theme.colors.border.default }]}
                        />
                    ) : null}
                    {section.node}
                </React.Fragment>
            ))}
            {showEmptyPlaceholder ? (
                <Text
                    testID="session-work-state-empty"
                    style={[styles.emptyText, { color: theme.colors.text.tertiary }]}
                >
                    {t('session.workState.emptyPlaceholder')}
                </Text>
            ) : null}
        </View>
    );

    return { content, guardedRequestClose, dirty };
}

const styles = StyleSheet.create(() => ({
    content: {
        gap: 16,
        minWidth: 0,
        maxWidth: '100%',
        paddingHorizontal: 14,
        paddingTop: 12,
        paddingBottom: 14,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    pendingText: {
        ...Typography.variant('body', 'semiBold'),
    },
    slowText: {
        ...Typography.variant('meta', 'medium'),
    },
    sectionDivider: {
        height: StyleSheet.hairlineWidth,
        marginVertical: 2,
    },
    emptyText: {
        ...Typography.variant('body', 'medium'),
        paddingVertical: 8,
    },
}));
