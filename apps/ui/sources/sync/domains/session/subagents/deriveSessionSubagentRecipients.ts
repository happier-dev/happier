import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';

import type { SessionSubagent } from './types';

export function deriveSessionSubagentRecipients(
    subagents: readonly SessionSubagent[],
): readonly SessionParticipantTarget[] {
    const targets: SessionParticipantTarget[] = [];
    const seenBroadcastTeamIds = new Set<string>();

    for (const subagent of subagents) {
        if (subagent.kind === 'agent_team_member' && subagent.status === 'running' && subagent.recipient?.kind === 'agent_team_member') {
            const teamId = subagent.recipient.teamId;
            if (!seenBroadcastTeamIds.has(teamId)) {
                seenBroadcastTeamIds.add(teamId);
                targets.push({
                    key: `agent_team_broadcast:${teamId}`,
                    displayLabel: teamId,
                    recipient: { kind: 'agent_team_broadcast', teamId },
                });
            }
        }

        if (!subagent.recipient || !subagent.capabilities.canSend || subagent.status !== 'running') continue;
        targets.push({
            key: subagent.id,
            displayLabel: subagent.display.title,
            ...(subagent.display.accentName ? { accentName: subagent.display.accentName } : {}),
            recipient: subagent.recipient,
        });
    }

    return targets;
}
