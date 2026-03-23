import type { ParticipantRecipientV1 } from '@happier-dev/protocol';
import {
    clampUtf16,
    coerceNonEmpty,
    sanitizeClaudeTeamConfigPathSegment,
    sanitizePromptField,
} from '@/backends/claude/utils/structuredMessages/promptFieldSanitization';

export function formatClaudeTeamRoutedPrompt(params: Readonly<{
    originalText: string;
    recipient: ParticipantRecipientV1;
}>): string {
    const maxIdChars = 200;
    const maxMessageChars = 12_000;

    const originalText = coerceNonEmpty(params.originalText);
    const message = clampUtf16(originalText, maxMessageChars);

    const r = params.recipient;
    if (r.kind === 'agent_team_member') {
        const teamId = clampUtf16(sanitizePromptField(coerceNonEmpty(r.teamId)), maxIdChars);
        const memberId = clampUtf16(sanitizePromptField(coerceNonEmpty(r.memberId)), maxIdChars);
        const memberLabel = clampUtf16(sanitizePromptField(coerceNonEmpty(r.memberLabel)), maxIdChars);
        const teammateDescriptor = memberLabel ? `${memberLabel} (${memberId})` : memberId;

        return [
            'You are the lead agent coordinating an Agent Team.',
            '',
            'Task: Send the user message to the specified teammate using the Agent Teams messaging tool.',
            'Rules:',
            '- Do not answer the user directly.',
            '- Send the message exactly as provided under "User message".',
            '',
            `Team: ${teamId}`,
            `Teammate: ${teammateDescriptor}`,
            '',
            'User message:',
            message,
        ].join('\n');
    }

    if (r.kind === 'agent_team_broadcast') {
        const teamId = clampUtf16(sanitizePromptField(coerceNonEmpty(r.teamId)), maxIdChars);
        const safeTeamConfigSegment = sanitizeClaudeTeamConfigPathSegment(teamId);
        const teamConfigPath = `~/.claude/teams/${safeTeamConfigSegment}/config.json`;
        return [
            'You are the lead agent coordinating an Agent Team.',
            '',
            'Task: Deliver the user message to the entire team.',
            'Rules:',
            '- Do not answer the user directly.',
            '- Send the message exactly as provided under "User message".',
            '- Prefer AgentTeamSendMessage in broadcast mode first.',
            `- If broadcast is unavailable, read ${teamConfigPath} and send the message directly to each active teammate using AgentTeamSendMessage.`,
            '',
            `Team: ${teamId}`,
            '',
            'User message:',
            message,
        ].join('\n');
    }

    return message;
}
