import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';

import type { SessionSubagent } from './types';
import { resolveExecutionRunTitle } from '@/components/sessions/runs/resolveExecutionRunTitle';

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
        const displayLabel = subagent.kind === 'execution_run' && subagent.runRef?.intent === 'scm_diff_summary'
            ? resolveExecutionRunTitle(subagent.runRef, 'recipient') : subagent.display.title;
        targets.push({
            key: subagent.id,
            displayLabel,
            ...(subagent.display.accentName ? { accentName: subagent.display.accentName } : {}),
            ...(subagent.kind === 'execution_run' && subagent.runRef?.intent ? { runIntent: subagent.runRef.intent } : {}),
            recipient: subagent.recipient.kind === 'execution_run' && subagent.runRef?.intent === 'scm_diff_summary'
                ? { ...subagent.recipient, label: displayLabel } : subagent.recipient,
        });
    }

    return targets;
}
