import * as React from 'react';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { GoalActionCapabilities } from '@/components/sessions/workState/goalActionVisibility';
import { SessionWorkStateContent } from '@/components/sessions/workState/SessionWorkStateContent';
import type {
    SessionWorkStateGoalOperationResult,
    SessionWorkStateGoalSetRequest,
} from '@/components/sessions/workState/useSessionWorkStateGoalController';
import type { SessionWorkStateSnapshot } from '@/components/sessions/workState/sessionWorkStateTypes';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_MENU_ICON_SIZE_PX } from './agentInputChipIconMetrics';

const GOAL_CHIP_KEY = 'session-goal';

/**
 * AgentInput primary-line chip that surfaces the session goal and opens the shared work-state goal
 * popover (set/edit/pause/resume/complete/clear) anchored to the chip. It is an additional entry
 * point alongside the above-input work-state badge; both share `SessionWorkStateContent` so there is
 * one editable-goal implementation — and, since r4.1, one live-activity section, so the two entry
 * points cannot disagree about what the session is working on.
 */
export function createGoalActionChip(params: Readonly<{
    sessionId: string;
    snapshot: SessionWorkStateSnapshot | null;
    editableGoal: boolean;
    goalActionCapabilityFallback?: GoalActionCapabilities | null;
    currentObjective: string | null;
    /** Opens the expanded monitoring surface from the activity section. */
    onOpenFullRoster?: () => void;
    onSetGoal?: (request: SessionWorkStateGoalSetRequest) => Promise<SessionWorkStateGoalOperationResult>;
    onClearGoal?: () => Promise<SessionWorkStateGoalOperationResult>;
}>): AgentInputExtraActionChip {
    const objective = params.currentObjective?.trim() ?? '';
    const hasGoal = objective.length > 0;
    const label = hasGoal ? objective : t('session.workState.goal.set');
    // Distinguish the empty "Set goal" affordance from an active goal for screen readers, and signal
    // a non-editable (read-only) chip via accessibilityState (G7). The label/a11y derive ONLY from
    // the narrow `currentObjective` + `editableGoal` props (not the full work-state snapshot), so
    // frequent task/workflow progress updates do not change the chip's accessible identity.
    const accessibilityLabel = hasGoal
        ? t('session.workState.goal.accessibilityCurrent', { objective })
        : t('session.workState.goal.set');

    return {
        key: GOAL_CHIP_KEY,
        controlId: 'goal',
        labelPolicy: 'auto-hide',
        collapsedContentPopover: {
            title: t('session.workState.goal.title'),
            label,
            icon: (tint: string) => normalizeNodeForView(<Icon name="target" color={tint} size={AGENT_INPUT_MENU_ICON_SIZE_PX} />),
            maxWidthCap: 420,
            maxHeightCap: 520,
            // U-4: this popover hosts the goal objective textarea / budget input, so it opts in to the
            // bottom keyboard inset to keep the focused field clear of the software keyboard.
            reserveKeyboardInset: true,
            renderContent: ({ requestClose }) => (
                <SessionWorkStateContent
                    sessionId={params.sessionId}
                    {...(params.onOpenFullRoster ? { onOpenFullRoster: params.onOpenFullRoster } : null)}
                    snapshot={params.snapshot}
                    editableGoal={params.editableGoal}
                    goalActionCapabilityFallback={params.goalActionCapabilityFallback ?? null}
                    requestClose={requestClose}
                    onSetGoal={params.onSetGoal}
                    onClearGoal={params.onClearGoal}
                />
            ),
        },
        render: ({ chipStyle, iconColor, chipAnchorRef, toggleCollapsedPopover }) => (
            <Pressable
                ref={chipAnchorRef}
                testID="agent-input-goal-chip"
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                accessibilityState={{ disabled: !params.editableGoal }}
                onPress={() => {
                    hapticsLight();
                    toggleCollapsedPopover?.(GOAL_CHIP_KEY);
                }}
                hitSlop={{ top: 8, bottom: 10, left: 4, right: 4 }}
                style={({ pressed }) => chipStyle(Boolean(pressed))}
            >
                {normalizeNodeForView(<Icon name="target" color={iconColor} size={AGENT_INPUT_CHIP_ICON_SIZE_PX} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
            </Pressable>
        ),
    };
}
