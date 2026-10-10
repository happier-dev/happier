import * as React from 'react';
import { useWorkRelativeTime } from '@/components/sessions/agents/presentation/agentActivityClock';

/** The clock is a leaf: an Inbox date changes without repainting its row or list. */
export const InboxRelativeTime = React.memo(function InboxRelativeTime(props: Readonly<{ timestamp: number; nowMs?: number }>) {
    const value = useWorkRelativeTime(props.timestamp, props.nowMs);
    return value;
});
