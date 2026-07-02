import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { SessionWorkStateSnapshot } from '@/sync/domains/session/workState/sessionWorkStateTypes';
import { resolvePrimarySessionWorkStateItem } from '@/sync/domains/session/workState/readSessionWorkState';
import type { SessionWorkStateItem } from '@/sync/domains/session/workState/sessionWorkStateTypes';

import { SessionGoalControlContent } from './SessionGoalControlContent';
import { SessionTaskListContent } from './SessionTaskListContent';

type OperationResult = { ok: true } | { ok: false; error: string };
type GoalSetRequest = Readonly<{
    objective?: string;
    status?: 'active' | 'paused' | 'complete';
    tokenBudget?: number | null;
    resumeInactiveWithInitialGoal?: boolean;
}>;

function findGoal(snapshot: SessionWorkStateSnapshot | null): SessionWorkStateItem | null {
    return snapshot?.items.find((item) => item.kind === 'goal') ?? null;
}

function omitGoalFromSnapshot(
    snapshot: SessionWorkStateSnapshot | null,
    goal: SessionWorkStateItem | null,
): SessionWorkStateSnapshot | null {
    if (!snapshot || !goal) return snapshot;
    return {
        ...snapshot,
        primaryItemId: snapshot.primaryItemId === goal.id ? null : snapshot.primaryItemId,
        items: snapshot.items.filter((item) => item.id !== goal.id),
    };
}

export function SessionWorkStatePopover(props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<any>;
    snapshot: SessionWorkStateSnapshot | null;
    editableGoal?: boolean;
    onRequestClose: () => void;
    onSetGoal?: (request: GoalSetRequest) => Promise<OperationResult>;
    onClearGoal?: () => Promise<OperationResult>;
}>) {
    const goal = findGoal(props.snapshot);
    const primary = resolvePrimarySessionWorkStateItem(props.snapshot);
    const renderGoalControls = props.editableGoal === true && Boolean(goal || primary?.kind === 'goal' || !primary);
    const taskListSnapshot = renderGoalControls ? omitGoalFromSnapshot(props.snapshot, goal) : props.snapshot;
    const [draftObjective, setDraftObjective] = React.useState(goal?.title ?? '');
    const [busy, setBusy] = React.useState(false);

    React.useEffect(() => {
        if (!props.open) return;
        setDraftObjective(goal?.title ?? '');
    }, [goal?.title, props.open]);

    const dirty = draftObjective.trim() !== (goal?.title ?? '').trim();

    const requestClose = React.useCallback(async () => {
        if (dirty) {
            const discard = await Modal.confirm(
                t('session.workState.dirtyCloseTitle'),
                t('session.workState.dirtyCloseBody'),
                { confirmText: t('common.discard'), destructive: true },
            );
            if (!discard) return;
        }
        props.onRequestClose();
    }, [dirty, props]);

    const runGoalMutation = React.useCallback(async (request: GoalSetRequest) => {
        if (!props.onSetGoal) return;
        setBusy(true);
        try {
            const result = await props.onSetGoal(request);
            if (result.ok) props.onRequestClose();
            else {
                props.onRequestClose();
                Modal.alert(t('common.error'), result.error);
            }
        } finally {
            setBusy(false);
        }
    }, [props]);

    const clearGoal = React.useCallback(async () => {
        if (!props.onClearGoal) return;
        props.onRequestClose();
        const confirmed = await Modal.confirm(
            t('session.workState.goal.clearTitle'),
            t('session.workState.goal.clearBody'),
            { confirmText: t('session.workState.goal.clear'), destructive: true },
        );
        if (!confirmed) return;
        setBusy(true);
        try {
            const result = await props.onClearGoal();
            if (!result.ok) Modal.alert(t('common.error'), result.error);
        } finally {
            setBusy(false);
        }
    }, [props]);

    return (
        <AgentInputContentPopover
            open={props.open}
            anchorRef={props.anchorRef}
            onRequestClose={requestClose}
            maxWidthCap={420}
            maxHeightCap={520}
            testID="session-work-state-popover-surface"
            content={() => (
                <View
                    testID="session-work-state-popover"
                    style={styles.content}
                >
                    {renderGoalControls ? (
                        <SessionGoalControlContent
                            goal={goal}
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
                            onResume={() => { void runGoalMutation({ status: 'active' }); }}
                            onComplete={() => { void runGoalMutation({ status: 'complete' }); }}
                            onClear={clearGoal}
                            busy={busy}
                        />
                    ) : null}
                    <SessionTaskListContent
                        snapshot={taskListSnapshot}
                        primaryItemId={taskListSnapshot?.primaryItemId ?? null}
                    />
                </View>
            )}
        />
    );
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
}));
