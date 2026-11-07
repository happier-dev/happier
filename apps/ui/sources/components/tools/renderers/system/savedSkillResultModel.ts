import type { ToolCall } from '@happier-dev/session-core/messages';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1, type SkillLibraryActionResultByIdV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { isRecord, readHappierActionCallId, readHappierActionToolResultCandidates } from '@/components/sessions/transcript/references/happierActionToolResult';

type SavedSkill = SkillLibraryActionResultByIdV1['skills.create'];

/** One acknowledgment parser for immediate tool output and deferred approval execution. */
function readSavedSkillAcknowledgment(result: unknown, input?: unknown) {
    for (const candidate of readHappierActionToolResultCandidates(result, input)) {
        const output = isRecord(candidate) && candidate.ok === true && 'result' in candidate ? candidate.result : candidate;
        const parsed = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].safeParse(output);
        if (parsed.success) return parsed.data;
    }
    return null;
}

/** Only a completed first-party create's acknowledged output can claim a saved skill. */
export function readSavedSkillResult(tool: Pick<ToolCall, 'state' | 'name' | 'input' | 'result'>): SavedSkill | null {
    if (tool.state !== 'completed' || readHappierActionCallId(tool.name, tool.input) !== 'skills.create') return null;
    return readSavedSkillAcknowledgment(tool.result, tool.input);
}

/** Deferred approval completes after the tool returned its receipt; its Artifact owns that outcome. */
export function readApprovedSavedSkillResult(approval: ApprovalRequest): SavedSkill | null {
    if (approval.actionId !== 'skills.create' || approval.origin?.kind !== 'transcript_tool_call'
        || approval.status !== 'executed' || !approval.execution?.ok) return null;
    return readSavedSkillAcknowledgment(approval.execution.result);
}
