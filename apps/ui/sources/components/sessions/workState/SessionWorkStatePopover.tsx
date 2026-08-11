import * as React from 'react';

import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';

import type { GoalActionCapabilities } from './goalActionVisibility';
import { useSessionWorkStateActivitySection } from './SessionWorkStateActivitySection';
import type { SessionWorkStateSnapshot } from './sessionWorkStateTypes';
import {
    useSessionWorkStateGoalController,
    type SessionWorkStateGoalOperationResult,
    type SessionWorkStateGoalSetRequest,
} from './useSessionWorkStateGoalController';

type SessionWorkStatePopoverProps = Readonly<{
    open: boolean;
    anchorRef: React.RefObject<any>;
    sessionId: string;
    snapshot: SessionWorkStateSnapshot | null;
    editableGoal: boolean;
    goalActionCapabilityFallback?: GoalActionCapabilities | null;
    /** Opens the expanded monitoring surface. Absent means there is nowhere to go. */
    onOpenFullRoster?: () => void;
    onRequestClose: () => void;
    onSetGoal?: (request: SessionWorkStateGoalSetRequest) => Promise<SessionWorkStateGoalOperationResult>;
    onClearGoal?: () => Promise<SessionWorkStateGoalOperationResult>;
}>;

/**
 * The compact work-state surface: goal, live activity, tasks — in that order.
 *
 * **Nothing here is mounted while the popover is closed**, and that is the one line of this file
 * worth reviewing. The body reads the roster variant of the unified model, which carries transcript
 * enrichment and background-task records and therefore re-derives on every streamed commit; holding
 * that subscription in the composer subtree would re-render it per token (R-11). The badge host only
 * ever invokes `renderPopover` for the *active* badge, so the closed state already unmounts this —
 * the gate below keeps that structural fact enforced here rather than merely relied upon.
 */
export function SessionWorkStatePopover(props: SessionWorkStatePopoverProps) {
    if (!props.open) return null;
    return <OpenSessionWorkStatePopover {...props} />;
}

function OpenSessionWorkStatePopover(props: SessionWorkStatePopoverProps) {
    // Presence is decided HERE, during this render, so a section that paints nothing never reaches
    // the controller's section list — no divider for an absent section, and no "nothing to show"
    // placeholder committed alongside live work and corrected a frame later.
    const activitySection = useSessionWorkStateActivitySection({
        sessionId: props.sessionId,
        ...(props.onOpenFullRoster ? { onOpenFullRoster: props.onOpenFullRoster } : null),
        // A row press routes to the agent's own transcript, so this popover dismisses itself first
        // rather than staying anchored over the screen the reader just opened.
        onRequestClose: props.onRequestClose,
    });
    const { content, guardedRequestClose } = useSessionWorkStateGoalController({
        open: props.open,
        snapshot: props.snapshot,
        editableGoal: props.editableGoal,
        goalActionCapabilityFallback: props.goalActionCapabilityFallback ?? null,
        activitySection,
        showEmptyGoalControls: false,
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
            // U-4: the goal edit mode reveals the objective textarea inside this popover, so reserve
            // the bottom keyboard inset to keep it clear of the software keyboard.
            reserveKeyboardInset
            content={() => content}
        />
    );
}
