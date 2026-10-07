import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { fromWorkflowAgentStatus } from '@happier-dev/protocol/sessions/work/agentActivity/adapters/fromWorkflowAgentStatus';
import { fromWorkflowRunStatus } from '@happier-dev/protocol/sessions/work/agentActivity/adapters/fromWorkflowRunStatus';
import type { SessionWorkflowAgentStatusV1, SessionWorkflowRunStatusV1 } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowRunSnapshotV1';

import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';

/**
 * Shared status icon for workflow run / agent statuses, reused by the transcript card (UIW4) and the
 * popover section (UIW3) so they share one visual language. The glyph says which state; its colour is
 * the one work-status tone (INT §5.3), so healthy work is quiet and only trouble is coloured.
 */

type WorkflowEntityStatus = SessionWorkflowRunStatusV1 | SessionWorkflowAgentStatusV1;

function toneOf(status: WorkflowEntityStatus) {
    // `pending` is the one agent-only status; every other value reads the same for runs and agents.
    const activity = status === 'pending' ? fromWorkflowAgentStatus(status) : fromWorkflowRunStatus(status);
    return resolveWorkStatusTone({ kind: 'agent_activity', facts: { status: activity, word: '' } }).tone;
}

export const WorkflowStatusIcon = React.memo<{ status: WorkflowEntityStatus; size?: number }>(({ status, size = 16 }) => {
    const { theme } = useUnistyles();
    const color = workStatusGlyphColor(theme.colors, toneOf(status));
    switch (status) {
        case 'active':
            return <ActivitySpinner size={iconMatchedSpinnerSize(size)} color={color} />;
        case 'complete':
            return <Icon name="check-circle" size={size} color={color} />;
        case 'failed':
            return <Icon name="x-circle" size={size} color={color} />;
        case 'blocked':
            return <Icon name="warning-circle" size={size} color={color} />;
        case 'stopped':
        case 'cancelled':
            return <Icon name="stop-circle" size={size} color={color} />;
        default:
            return <Icon name="circle" size={size} color={color} />;
    }
});
WorkflowStatusIcon.displayName = 'WorkflowStatusIcon';
