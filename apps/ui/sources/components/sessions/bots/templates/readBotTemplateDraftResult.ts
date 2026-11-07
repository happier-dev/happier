import type { ToolCall } from '@happier-dev/session-core/messages';
import type { BotTemplateDraftResultV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { BotTemplateDraftResultV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { isRecord, readHappierActionCallId, readHappierActionToolResultCandidates } from '@/components/sessions/transcript/references/happierActionToolResult';

export function readBotTemplateDraftResult(tool: ToolCall): BotTemplateDraftResultV1 | null {
    if (tool.state !== 'completed' || readHappierActionCallId(tool.name, tool.input) !== 'template.draft') return null;
    for (const candidate of readHappierActionToolResultCandidates(tool.result, tool.input)) {
        if (isRecord(candidate) && candidate.ok === false) continue;
        const output = isRecord(candidate) && candidate.ok === true && 'result' in candidate ? candidate.result : candidate;
        const parsed = BotTemplateDraftResultV1Schema.safeParse(output);
        if (parsed.success) return parsed.data;
    }
    return null;
}
