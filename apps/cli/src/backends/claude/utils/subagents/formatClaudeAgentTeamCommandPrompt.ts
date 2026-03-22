import type { SubagentCommandV1 } from '@happier-dev/protocol';

import { clampUtf16, coerceNonEmpty, sanitizePromptField } from '@/backends/claude/utils/structuredMessages/promptFieldSanitization';

export function formatClaudeAgentTeamCommandPrompt(params: Readonly<{
    payload: SubagentCommandV1;
}>): string {
    const maxIdChars = 200;
    const payload = params.payload;

    if (payload.kind === 'agent_team_delete') {
        const teamId = clampUtf16(sanitizePromptField(coerceNonEmpty(payload.teamId)), maxIdChars);
        return [
            'You are the lead agent coordinating an Agent Team.',
            '',
            'Task: Delete the Agent Team.',
            'Rules:',
            '- Do not answer the user directly.',
            '- Clean up the team safely.',
            '',
            `Team: ${teamId}`,
        ].join('\n');
    }

    const teamId = clampUtf16(sanitizePromptField(coerceNonEmpty(payload.teamId)), maxIdChars);
    const memberId = clampUtf16(sanitizePromptField(coerceNonEmpty(payload.memberId)), maxIdChars);
    const memberLabel = clampUtf16(sanitizePromptField(coerceNonEmpty(payload.memberLabel)), maxIdChars);
    const teammateDescriptor = memberLabel ? `${memberLabel} (${memberId})` : memberId;

    return [
        'You are the lead agent coordinating an Agent Team.',
        '',
        'Task: Shut down the specified teammate.',
        'Rules:',
        '- Do not answer the user directly.',
        '- Shut down only the specified teammate.',
        '',
        `Team: ${teamId}`,
        `Teammate: ${teammateDescriptor}`,
    ].join('\n');
}
