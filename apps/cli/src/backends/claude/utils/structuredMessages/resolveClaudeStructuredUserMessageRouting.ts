import { formatClaudeTeamRoutedPrompt } from '@/backends/claude/utils/participantRouting/formatClaudeTeamRoutedPrompt';
import { parseParticipantMessageMeta } from '@/backends/claude/utils/participantRouting/parseParticipantMessageMeta';
import { formatClaudeAgentTeamCommandPrompt } from '@/backends/claude/utils/subagents/formatClaudeAgentTeamCommandPrompt';
import { formatClaudeAgentTeamLaunchPrompt } from '@/backends/claude/utils/subagents/formatClaudeAgentTeamLaunchPrompt';
import { parseSubagentCommandMeta } from '@/backends/claude/utils/subagents/parseSubagentCommandMeta';
import { parseSubagentLaunchMeta } from '@/backends/claude/utils/subagents/parseSubagentLaunchMeta';

export type ClaudeStructuredUserMessageRouting = Readonly<{
    kind: 'participant_message.v1' | 'subagent_launch.v1' | 'subagent_command.v1';
    queuedText: string;
}>;

export function resolveClaudeStructuredUserMessageRouting(params: Readonly<{
    text: string;
    meta: unknown;
}>): ClaudeStructuredUserMessageRouting | null {
    const participantRouting = parseParticipantMessageMeta(params.meta);
    if (participantRouting) {
        return {
            kind: 'participant_message.v1',
            queuedText: formatClaudeTeamRoutedPrompt({
                originalText: params.text,
                recipient: participantRouting.recipient,
            }),
        };
    }

    const launchMeta = parseSubagentLaunchMeta(params.meta);
    if (launchMeta) {
        return {
            kind: 'subagent_launch.v1',
            queuedText: formatClaudeAgentTeamLaunchPrompt({ payload: launchMeta.payload }),
        };
    }

    const commandMeta = parseSubagentCommandMeta(params.meta);
    if (commandMeta) {
        return {
            kind: 'subagent_command.v1',
            queuedText: formatClaudeAgentTeamCommandPrompt({ payload: commandMeta.payload }),
        };
    }

    return null;
}
