import type { ToolCall } from '@happier-dev/session-core/messages';
import { isTranscriptSessionBoardItemReplyCallV1 } from '@happier-dev/protocol/sessions/board';
import { WORKFLOW_RUN_START_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { SKILL_CREATE_ACTION_ID_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionIdsV1';
import { BOT_TEMPLATE_DRAFT_ACTION_ID_V1 } from '@happier-dev/protocol/bots/templates/botTemplateActionIdsV1';
import { isMemoryWriteActionV1, MemoryMutationResultV1Schema } from '@happier-dev/protocol/prompts/library/memoryActionsV1';
import { isRecord, readHappierActionCallId, readHappierActionToolResultCandidates } from './happierActionToolResult';
import { readTranscriptBrowserActionIdentity } from './transcriptBrowserActionReference';
import { resolveTranscriptComputerActionReference } from './transcriptComputerActionReference';
import { isTranscriptWorkflowDefinitionWrite } from './transcriptWorkflowDefinitionReference';
import { isTranscriptDeploySuggestionCheckCall } from './transcriptDeploySuggestionReference';

/** Result placement belongs to the transcript, shared by grouping and both tool chromes.
 * Card-producing calls keep their place while an approval supplies the eventual result. */
export function readTranscriptToolResultCardKind(tool: ToolCall) {
    const actionId = readHappierActionCallId(tool.name, tool.input);
    switch (actionId) {
        case SKILL_CREATE_ACTION_ID_V1: return 'saved-skill';
        case BOT_TEMPLATE_DRAFT_ACTION_ID_V1: return 'template-draft';
        case WORKFLOW_RUN_START_ACTION_ID_V1: return 'workflow-run';
    }
    if (actionId && isMemoryWriteActionV1(actionId)) return 'memory-mutation';
    if (isTranscriptWorkflowDefinitionWrite(tool)) return 'workflow-definition';
    if (isTranscriptDeploySuggestionCheckCall(tool)) return 'deploy-suggestion';
    if (readTranscriptBrowserActionIdentity({ toolName: tool.name, input: tool.input })) return 'browser';
    if (resolveTranscriptComputerActionReference({ toolName: tool.name, state: tool.state, input: tool.input, result: tool.result })) return 'computer';
    if (isTranscriptSessionBoardItemReplyCallV1({ toolName: tool.name, state: tool.state, input: tool.input, result: tool.result })) return 'board';
    return null;
}

export function readTranscriptMemoryMutationReference(tool: ToolCall) {
    if (tool.state !== 'completed') return null;
    for (const candidate of readHappierActionToolResultCandidates(tool.result, tool.input)) {
        const output = isRecord(candidate) && candidate.ok === true && 'result' in candidate ? candidate.result : candidate;
        const parsed = MemoryMutationResultV1Schema.safeParse(output);
        if (parsed.success && parsed.data.receipt && parsed.data.revision) {
            return { ...parsed.data, receipt: parsed.data.receipt, revision: parsed.data.revision };
        }
    }
    return null;
}
