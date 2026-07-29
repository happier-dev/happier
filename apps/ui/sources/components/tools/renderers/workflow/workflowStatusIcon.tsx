import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import type {
    SessionWorkflowAgentStatusV1,
    SessionWorkflowRunStatusV1,
} from '@happier-dev/protocol';

/**
 * Shared status icon for workflow run / agent statuses, reused by the transcript card (UIW4) and the
 * popover section (UIW3) so they share one visual language. Colors come from themed `state.*` tokens
 * (no hex). Active uses the app `ActivitySpinner`; terminal states use Ionicons. The "active/running"
 * tone maps to the `state.info` token (`../dev` has no `state.active`).
 */

type WorkflowEntityStatus = SessionWorkflowRunStatusV1 | SessionWorkflowAgentStatusV1;

export const WorkflowStatusIcon = React.memo<{ status: WorkflowEntityStatus; size?: number }>(({ status, size = 16 }) => {
    const { theme } = useUnistyles();
    const stateColors = theme.colors.state;
    switch (status) {
        case 'active':
            return <ActivitySpinner size={iconMatchedSpinnerSize(size)} color={stateColors.info.foreground} />;
        case 'complete':
            return <Ionicons name="checkmark-circle" size={size} color={stateColors.success.foreground} />;
        case 'failed':
            return <Ionicons name="close-circle" size={size} color={stateColors.danger.foreground} />;
        case 'blocked':
            return <Ionicons name="alert-circle" size={size} color={stateColors.warning.foreground} />;
        case 'stopped':
        case 'cancelled':
            return <Ionicons name="stop-circle" size={size} color={stateColors.neutral.foreground} />;
        case 'pending':
            return <Ionicons name="ellipse-outline" size={size} color={stateColors.neutral.foreground} />;
        default:
            return <Ionicons name="ellipse-outline" size={size} color={stateColors.neutral.foreground} />;
    }
});
WorkflowStatusIcon.displayName = 'WorkflowStatusIcon';
