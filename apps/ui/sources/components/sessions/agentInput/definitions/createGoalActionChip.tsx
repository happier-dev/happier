import * as React from 'react';
import { Pressable } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { GoalActionCapabilities } from '@/components/sessions/workState/goalActionVisibility';
import {
    SessionWorkStateContent,
    type SessionWorkStateGoalSetRequest,
    type SessionWorkStateOperationResult,
} from '@/components/sessions/workState/SessionWorkStateContent';
import type { SessionWorkStateSnapshot } from '@/sync/domains/session/workState/sessionWorkStateTypes';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_MENU_ICON_SIZE_PX } from './agentInputChipIconMetrics';

const GOAL_CHIP_KEY = 'session-goal';
const PRIMER_GOAL_ICON_PATHS = [
    'M20.172 6.75h-1.861l-4.566 4.564a1.874 1.874 0 1 1-1.06-1.06l4.565-4.565V3.828a.94.94 0 0 1 .275-.664l1.73-1.73a.249.249 0 0 1 .25-.063c.089.026.155.1.173.191l.46 2.301 2.3.46c.09.018.164.084.19.173a.25.25 0 0 1-.062.249l-1.731 1.73a.937.937 0 0 1-.663.275Z',
    'M2.625 12A9.375 9.375 0 0 0 12 21.375 9.375 9.375 0 0 0 21.375 12c0-.898-.126-1.766-.361-2.587A.75.75 0 0 1 22.455 9c.274.954.42 1.96.42 3 0 6.006-4.869 10.875-10.875 10.875S1.125 18.006 1.125 12 5.994 1.125 12 1.125c1.015-.001 2.024.14 3 .419a.75.75 0 1 1-.413 1.442A9.39 9.39 0 0 0 12 2.625 9.375 9.375 0 0 0 2.625 12Z',
    'M7.125 12a4.874 4.874 0 1 0 9.717-.569.748.748 0 0 1 1.047-.798c.251.112.42.351.442.625a6.373 6.373 0 0 1-10.836 5.253 6.376 6.376 0 0 1 5.236-10.844.75.75 0 1 1-.17 1.49A4.876 4.876 0 0 0 7.125 12Z',
] as const;


/**
 * AgentInput chip that surfaces the session goal and opens the SHARED work-state goal popover content
 * (set/edit/pause/resume/complete/clear) anchored to the chip. It is the first-goal entry point on a
 * fresh active goal-capable session — present BEFORE any goal item exists (QA-CHIP-1) — and an
 * additional entry point alongside the above-input work-state badge. Both surfaces share
 * `SessionWorkStateContent`, so there is one editable-goal implementation (no provider branching: the
 * caller decides availability via the capability-driven registry gate).
 */
export function createGoalActionChip(params: Readonly<{
    snapshot: SessionWorkStateSnapshot | null;
    editableGoal: boolean;
    goalActionCapabilityProfile?: GoalActionCapabilities | null;
    currentObjective: string | null;
    onSetGoal?: (request: SessionWorkStateGoalSetRequest) => Promise<SessionWorkStateOperationResult>;
    onClearGoal?: () => Promise<SessionWorkStateOperationResult>;
}>): AgentInputExtraActionChip {
    const objective = params.currentObjective?.trim() ?? '';
    const hasGoal = objective.length > 0;
    const label = hasGoal ? objective : t('session.workState.goal.set');
    // Distinguish the empty "Set goal" affordance from an active goal for screen readers, and signal a
    // non-editable (read-only) chip via accessibilityState. The label/a11y derive ONLY from the narrow
    // `currentObjective` + `editableGoal` props (not the full work-state snapshot), so frequent
    // task/workflow progress updates do not churn the chip's accessible identity.
    const accessibilityLabel = hasGoal
        ? t('session.workState.badge.goal', { title: objective })
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
            renderContent: ({ requestClose }) => (
                <SessionWorkStateContent
                    open
                    snapshot={params.snapshot}
                    editableGoal={params.editableGoal}
                    goalActionCapabilityProfile={params.goalActionCapabilityProfile ?? null}
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
                style={(state) => chipStyle(state.pressed)}
            >
                {normalizeNodeForView(<Icon name="target" color={iconColor} size={AGENT_INPUT_CHIP_ICON_SIZE_PX} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
            </Pressable>
        ),
    };
}
