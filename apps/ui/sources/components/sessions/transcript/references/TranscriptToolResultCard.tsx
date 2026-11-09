import * as React from 'react';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { BotTemplateDraftCard } from '@/components/sessions/bots/templates/BotTemplateDraftCard';
import { SavedSkillResult } from '@/components/tools/renderers/system/SavedSkillResult';
import { readSavedSkillResult } from '@/components/tools/renderers/system/savedSkillResultModel';
import { useTranscriptVisualContext } from '../source/SessionTranscriptSourceContext';
import { useTranscriptRowContentDemand } from '../viewport/visibility/TranscriptRowContentDemand';
import { BrowserActionResultReference } from './BrowserActionResultReference';
import { ComputerActionResultReference } from './ComputerActionResultReference';
import { SessionBoardActionResultReference } from './SessionBoardActionResultReference';
import { WorkflowDefinitionActionResultReference } from './WorkflowDefinitionActionResultReference';
import { WorkflowRunActionResultReference } from './WorkflowRunActionResultReference';
import { readTranscriptToolResultCardKind } from './transcriptToolResultCard';

/** A tool's result is a reply block, outside both its own disclosure and tool groups. */
export function TranscriptToolResultCard(props: Readonly<{
    tool: ToolCall; sessionId?: string; serverId?: string; mediaPreviewEnabled: boolean;
}>) {
    const contentDemand = useTranscriptRowContentDemand();
    const visualContext = useTranscriptVisualContext();
    switch (readTranscriptToolResultCardKind(props.tool)) {
        case 'saved-skill': {
            const fact = readSavedSkillResult(props.tool);
            return fact ? <SavedSkillResult fact={fact} sessionId={props.sessionId} serverId={props.serverId} /> : null;
        }
        case 'template-draft': return <BotTemplateDraftCard tool={props.tool} />;
        case 'workflow-run': return <WorkflowRunActionResultReference tool={props.tool} serverId={props.serverId} />;
        case 'workflow-definition': return <WorkflowDefinitionActionResultReference tool={props.tool} serverId={props.serverId} />;
        case 'browser': return <BrowserActionResultReference {...props} />;
        case 'computer': return <ComputerActionResultReference {...props} />;
        case 'board': return <SessionBoardActionResultReference {...props} contentDemand={contentDemand} visualContext={visualContext} />;
        default: return null;
    }
}
