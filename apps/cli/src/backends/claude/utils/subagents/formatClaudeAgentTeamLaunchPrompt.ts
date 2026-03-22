import type { SubagentLaunchV1 } from '@happier-dev/protocol';

import { clampUtf16, coerceNonEmpty, sanitizePromptField } from '@/backends/claude/utils/structuredMessages/promptFieldSanitization';

export function formatClaudeAgentTeamLaunchPrompt(params: Readonly<{
    payload: SubagentLaunchV1;
}>): string {
    const maxIdChars = 200;
    const maxDescriptionChars = 2_000;
    const maxInstructionChars = 12_000;
    const payload = params.payload;

    if (payload.kind === 'agent_team_create') {
        const teamId = clampUtf16(sanitizePromptField(coerceNonEmpty(payload.teamId)), maxIdChars);
        const description = clampUtf16(sanitizePromptField(coerceNonEmpty(payload.description)), maxDescriptionChars);

        return [
            'You are the lead agent coordinating work in Claude Code.',
            '',
            'Task: Create a new Agent Team.',
            'Rules:',
            '- Do not answer the user directly.',
            '- Create the team exactly once.',
            '',
            `Team: ${teamId}`,
            ...(description ? ['', 'Description:', description] : []),
        ].join('\n');
    }

    const teamId = clampUtf16(sanitizePromptField(coerceNonEmpty(payload.teamId)), maxIdChars);
    const memberLabel = clampUtf16(sanitizePromptField(coerceNonEmpty(payload.memberLabel)), maxIdChars);
    const instructions = clampUtf16(sanitizePromptField(coerceNonEmpty(payload.instructions)), maxInstructionChars);

    return [
        'You are the lead agent coordinating an Agent Team.',
        '',
        'Task: Launch a new teammate in the specified Agent Team.',
        'Rules:',
        '- Do not answer the user directly.',
        '- Create the teammate exactly once.',
        '',
        `Team: ${teamId}`,
        `Teammate label: ${memberLabel}`,
        `Run in background: ${payload.runInBackground === true ? 'yes' : 'no'}`,
        '',
        'Instructions:',
        instructions,
    ].join('\n');
}
