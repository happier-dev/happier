import * as React from 'react';

import { SessionWorkflowActivitySection } from './SessionWorkflowActivitySection';
import type { GoalActionCapabilities } from './goalActionVisibility';
import type { SessionWorkflowActivityState } from './useSessionWorkflowActivity';
import type { SessionWorkStateSnapshot } from '@/sync/domains/session/workState/sessionWorkStateTypes';
import {
    useSessionWorkStateGoalController,
    type SessionWorkStateGoalOperationResult,
    type SessionWorkStateGoalSetRequest,
} from './useSessionWorkStateGoalController';

// Result type re-exported under its historical name for existing callers (the chip + popover import
// it from here). The canonical definition now lives in the mutation model / controller barrel.
export type SessionWorkStateOperationResult = SessionWorkStateGoalOperationResult;
export type { SessionWorkStateGoalSetRequest };

/**
 * Goal/work-state popover body WITHOUT its own popover wrapper. A thin wrapper over the shared
 * `useSessionWorkStateGoalController` hook so the SAME implementation backs both entry points: the
 * above-AgentInput work-state badge popover (`SessionWorkStatePopover`) and the AgentInput goal chip
 * (`createGoalActionChip`). The controller is the single owner of goal read/edit/mutation/dirty
 * state (D4) — no private `findGoal` (D2) and no per-surface dirty duplication.
 */
export function SessionWorkStateContent(props: Readonly<{
    open?: boolean;
    snapshot: SessionWorkStateSnapshot | null;
    // UIW3: live workflow activity. When present with active runs, the Active Workflows section
    // renders between the goal controls and the task list. Omitted for goal-only entry points.
    workflowActivity?: SessionWorkflowActivityState;
    editableGoal?: boolean;
    // Provider goal-action profile for the "Set goal" form (no goal item yet) so the Codex-only
    // budget editor stays hidden on providers that don't support it (e.g. Claude). QA-CHIP-2.
    goalActionCapabilityProfile?: GoalActionCapabilities | null;
    /**
     * Whether this surface is allowed to show the set-first-goal form when no goal exists yet.
     * The AgentInput goal chip is the creation affordance; the above-composer work-state popover
     * should only show goal controls once there is an actual goal to inspect/edit.
     */
    showEmptyGoalControls?: boolean;
    requestClose: () => void;
    onSetGoal?: (request: SessionWorkStateGoalSetRequest) => Promise<SessionWorkStateOperationResult>;
    onClearGoal?: () => Promise<SessionWorkStateOperationResult>;
    /** Backward-compat passthrough for hosts that observe the unsaved-draft state. */
    onDirtyChange?: (dirty: boolean) => void;
}>) {
    const workflowSection = props.workflowActivity
        ? <SessionWorkflowActivitySection activity={props.workflowActivity} />
        : null;
    const { content, dirty } = useSessionWorkStateGoalController({
        open: props.open ?? true,
        snapshot: props.snapshot,
        editableGoal: props.editableGoal === true,
        goalActionCapabilityProfile: props.goalActionCapabilityProfile ?? null,
        workflowSection,
        showEmptyGoalControls: props.showEmptyGoalControls,
        onRequestClose: props.requestClose,
        onSetGoal: props.onSetGoal,
        onClearGoal: props.onClearGoal,
    });

    const onDirtyChange = props.onDirtyChange;
    React.useEffect(() => {
        onDirtyChange?.(dirty);
    }, [dirty, onDirtyChange]);

    return <>{content}</>;
}
