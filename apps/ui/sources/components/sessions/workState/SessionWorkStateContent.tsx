import * as React from 'react';

import type { GoalActionCapabilities } from './goalActionVisibility';
import { useSessionWorkStateActivitySection } from './SessionWorkStateActivitySection';
import type { SessionWorkStateSnapshot } from './sessionWorkStateTypes';
import {
    useSessionWorkStateGoalController,
    type SessionWorkStateGoalOperationResult,
    type SessionWorkStateGoalSetRequest,
} from './useSessionWorkStateGoalController';

/**
 * Goal/work-state popover body without its own popover wrapper, for hosting inside an
 * `AgentInputContentPopover` provided by a caller (e.g. the AgentInput goal chip). Shares the same
 * controller — and the same live-activity section — as `SessionWorkStatePopover`, so the two
 * composer entry points into the same body cannot tell different stories about what is running.
 *
 * This component is only ever rendered by a host's open-popover render callback, which is what
 * makes it safe for the activity section (and its transcript-derived roster) to mount here: the
 * subscription exists while a reader is looking at it and not a moment longer (R-11).
 */
export function SessionWorkStateContent(props: Readonly<{
    sessionId: string;
    snapshot: SessionWorkStateSnapshot | null;
    editableGoal: boolean;
    goalActionCapabilityFallback?: GoalActionCapabilities | null;
    /** Opens the expanded monitoring surface. Absent means there is nowhere to go. */
    onOpenFullRoster?: () => void;
    requestClose: () => void;
    onSetGoal?: (request: SessionWorkStateGoalSetRequest) => Promise<SessionWorkStateGoalOperationResult>;
    onClearGoal?: () => Promise<SessionWorkStateGoalOperationResult>;
}>) {
    // Presence is decided during this render, so an absent section is genuinely absent from the
    // controller's section list rather than an element that happens to paint nothing.
    const activitySection = useSessionWorkStateActivitySection({
        sessionId: props.sessionId,
        ...(props.onOpenFullRoster ? { onOpenFullRoster: props.onOpenFullRoster } : null),
        // A row press routes to the agent's own transcript, so this popover dismisses itself first
        // rather than staying anchored over the screen the reader just opened.
        onRequestClose: props.requestClose,
    });
    const { content } = useSessionWorkStateGoalController({
        open: true,
        snapshot: props.snapshot,
        editableGoal: props.editableGoal,
        goalActionCapabilityFallback: props.goalActionCapabilityFallback ?? null,
        activitySection,
        onRequestClose: props.requestClose,
        onSetGoal: props.onSetGoal,
        onClearGoal: props.onClearGoal,
    });

    return <>{content}</>;
}
