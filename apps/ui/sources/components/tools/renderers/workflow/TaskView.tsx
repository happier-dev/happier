import * as React from 'react';
import type { ToolViewProps } from '../core/_registry';
import { TaskLikeSummarySection } from './TaskLikeSummarySection';

export const TaskView = React.memo<ToolViewProps>(({ tool, metadata, messages, detailLevel }) => {
    return (
        <TaskLikeSummarySection
            tool={tool as any}
            metadata={metadata ?? null}
            messages={messages ?? []}
            detailLevel={detailLevel}
            opts={{ hideResultInlineWhenBackgroundRun: true }}
        />
    );
});
