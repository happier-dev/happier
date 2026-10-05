import * as React from 'react';
import type { ToolViewProps } from '../core/_registry';
import { SubAgentSummarySection } from './SubAgentSummarySection';
export { projectSubAgentSummaryDisplayText as projectSubAgentDisplayText } from './SubAgentSummarySection';

export const SubAgentView = React.memo<ToolViewProps>(({ tool, metadata, messages, detailLevel, sessionId, serverId, messageId, interaction }) => {
    return (
        <SubAgentSummarySection
            tool={tool}
            metadata={metadata ?? null}
            messages={messages ?? []}
            detailLevel={detailLevel}
            sessionId={sessionId}
            serverId={serverId}
            messageId={messageId}
            interaction={interaction}
            opts={{ hideResultInlineWhenBackgroundRun: true }}
        />
    );
});
