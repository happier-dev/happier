import * as React from 'react';

import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import type { SessionWorkStateSnapshot } from '@/sync/domains/session/workState/sessionWorkStateTypes';

import { SessionManagedWorkflowSection } from './SessionManagedWorkflowSection';
import { SessionWorkflowActivitySection } from './SessionWorkflowActivitySection';
import type { SessionManagedWorkflowRunsState } from '@/components/workflows/run/useContextManagedWorkflowRuns';
import type { GoalActionCapabilities } from './goalActionVisibility';
import type { SessionWorkflowActivityState } from './useSessionWorkflowActivity';
import {
    useSessionWorkStateGoalController,
    type SessionWorkStateGoalOperationResult,
    type SessionWorkStateGoalSetRequest,
} from './useSessionWorkStateGoalController';

/**
 * The above-AgentInput work-state badge popover. A thin wrapper over the shared
 * `useSessionWorkStateGoalController` hook, adding the popover surface. The dirty-close guard and
 * goal read/edit logic live in the controller (D4) — this wrapper no longer owns a duplicate
 * `dirtyRef`; the AgentInput goal chip reuses the SAME controller, so both entry points stay in
 * lockstep.
 */
export function SessionWorkStatePopover(props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<any>;
    snapshot: SessionWorkStateSnapshot | null;
    // UIW3: live workflow activity (headline + loaded run detail). The popover renders the Active
    // Workflows section from this; omit for goal-only surfaces (e.g. the AgentInput goal chip).
    workflowActivity?: SessionWorkflowActivityState;
    /**
     * Managed Workflow Runs this Session started. They are a different contract
     * from observed native activity above, so they render as their own section
     * rather than being merged into it.
     */
    managedWorkflowRuns?: SessionManagedWorkflowRunsState;
    onOpenManagedWorkflowRun?: (runId: string) => void;
    editableGoal?: boolean;
    /** The badge already names the goal's state (its presentation's `namesGoalStatus`). */
    anchorNamesGoalStatus?: boolean;
    // Provider goal-action profile for the "Set goal" form (no goal item yet) so the Codex-only
    // budget editor stays hidden on providers that don't support it (e.g. Claude). QA-CHIP-2.
    goalActionCapabilityProfile?: GoalActionCapabilities | null;
    onRequestClose: () => void;
    onSetGoal?: (request: SessionWorkStateGoalSetRequest, signal?: AbortSignal) => Promise<SessionWorkStateGoalOperationResult>;
    onClearGoal?: (signal?: AbortSignal) => Promise<SessionWorkStateGoalOperationResult>;
}>) {
    const managedWorkflowSection = props.managedWorkflowRuns !== undefined
        && props.onOpenManagedWorkflowRun !== undefined
        ? (
            <SessionManagedWorkflowSection
                state={props.managedWorkflowRuns}
                onOpenRun={props.onOpenManagedWorkflowRun}
            />
        )
        : null;
    const workflowSection = props.workflowActivity || managedWorkflowSection ? (
        <>
            {props.workflowActivity
                ? <SessionWorkflowActivitySection activity={props.workflowActivity} />
                : null}
            {managedWorkflowSection}
        </>
    ) : null;
    const { content, guardedRequestClose } = useSessionWorkStateGoalController({
        open: props.open,
        snapshot: props.snapshot,
        editableGoal: props.editableGoal === true,
        goalActionCapabilityProfile: props.goalActionCapabilityProfile ?? null,
        workflowSection,
        showEmptyGoalControls: false,
        goalStatusShownByAnchor: props.anchorNamesGoalStatus === true,
        onRequestClose: props.onRequestClose,
        onSetGoal: props.onSetGoal,
        onClearGoal: props.onClearGoal,
    });

    return (
        <AgentInputContentPopover
            open={props.open}
            anchorRef={props.anchorRef}
            onRequestClose={guardedRequestClose}
            maxWidthCap={420}
            maxHeightCap={520}
            testID="session-work-state-popover-surface"
            content={() => content}
        />
    );
}
