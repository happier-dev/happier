import * as React from 'react';
import type { ToolViewProps } from '../core/_registry';
import { TaskLikeSummarySection } from './TaskLikeSummarySection';

export const TaskView = React.memo<ToolViewProps>(({ tool, metadata, messages, detailLevel, sessionId, messageId }) => {
    return (
        <TaskLikeSummarySection
            tool={tool as any}
            metadata={metadata ?? null}
            messages={messages ?? []}
            detailLevel={detailLevel}
            sessionId={sessionId}
            messageId={messageId}
            opts={{ hideResultInlineWhenBackgroundRun: true }}
        />
    );
});
