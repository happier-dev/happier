import * as React from 'react';
import type { ToolViewProps } from '../core/_registry';
import { SubAgentSummarySection } from './SubAgentSummarySection';

export const SubAgentView = React.memo<ToolViewProps>(({ tool, metadata, messages, detailLevel, sessionId, messageId, interaction }) => {
    return (
        <SubAgentSummarySection
            tool={tool as any}
            metadata={metadata ?? null}
            messages={messages ?? []}
            detailLevel={detailLevel}
            sessionId={sessionId}
            messageId={messageId}
            interaction={interaction}
            opts={{ hideResultInlineWhenBackgroundRun: true }}
        />
    );
});
