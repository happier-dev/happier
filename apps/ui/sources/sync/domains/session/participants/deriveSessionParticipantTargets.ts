import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { Message, ToolCallMessage, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';

import type { SessionParticipantTarget } from './participantTargets';
import { deriveProviderParticipantSnapshot } from './providers';
import {
    deriveClaudeSpawnedTeammateFromTaskToolInput,
    deriveClaudeSpawnedTeammateFromTaskToolResult,
} from './providers/claude/deriveClaudeTeamParticipants';

function readExecutionRunIdFromSubAgentRunTool(tool: ToolCall): string | null {
    const input = tool.input as any;
    const inputRunId = typeof input?.runId === 'string' ? String(input.runId).trim() : '';
    if (inputRunId.length > 0) return inputRunId;

    const result = tool.result as any;
    const runId = typeof result?.runId === 'string' ? String(result.runId).trim() : '';
    return runId.length > 0 ? runId : null;
}

function isSubAgentRunToolRunning(tool: ToolCall): boolean {
    if (tool.state === 'running') return true;
    const result = tool.result as any;
    if (typeof result?.status === 'string' && String(result.status).toLowerCase() === 'running') return true;

    // Execution runs can intentionally interrupt an in-flight turn (e.g. "send now", steering) without stopping the run.
    // In these cases we still want the run to remain targetable from the recipient chip.
    if (tool.state === 'error' && typeof result?.error === 'string') {
        const error = String(result.error).trim();
        if (/^Request interrupted\b/i.test(error)) return true;
    }

    return false;
}

export function deriveSessionParticipantTargets(params: Readonly<{
    session: Session;
    messages: readonly Message[];
}>): ReadonlyArray<SessionParticipantTarget> {
    const targets: SessionParticipantTarget[] = [];

    // Provider-agnostic: execution runs (bounded + long-lived) surfaced via SubAgentRun tool messages.
    for (const m of params.messages) {
        if (!m || m.kind !== 'tool-call') continue;
        const toolMsg = m as ToolCallMessage;
        if (toolMsg.tool?.name !== 'SubAgentRun') continue;
        if (!isSubAgentRunToolRunning(toolMsg.tool)) continue;
        const runId = readExecutionRunIdFromSubAgentRunTool(toolMsg.tool);
        if (!runId) continue;

        const label =
            typeof (toolMsg.tool.input as any)?.label === 'string'
                ? String((toolMsg.tool.input as any).label).trim()
                : '';
        const displayLabel = label.length > 0 ? label : undefined;

        targets.push({
            key: `execution_run:${runId}`,
            ...(displayLabel ? { displayLabel } : {}),
            recipient: { kind: 'execution_run', runId, ...(displayLabel ? { label: displayLabel } : {}) } satisfies ParticipantRecipientV1,
        });
    }

    const flavor = typeof (params.session as any)?.metadata?.flavor === 'string' ? String((params.session as any).metadata.flavor) : null;
    const providerSnapshot = deriveProviderParticipantSnapshot({ flavor, messages: params.messages });

    if (providerSnapshot.claudeTeam?.teamId) {
        const teamId = providerSnapshot.claudeTeam.teamId;
        targets.push({
            key: `agent_team_broadcast:${teamId}`,
            displayLabel: teamId,
            recipient: { kind: 'agent_team_broadcast', teamId } satisfies ParticipantRecipientV1,
        });
        for (const member of providerSnapshot.claudeTeam.members) {
            const label = member.memberLabel ? member.memberLabel : member.memberId;
            const accentName = member.memberColor ? String(member.memberColor).trim() : '';
            targets.push({
                key: `agent_team_member:${teamId}:${member.memberId}`,
                displayLabel: label,
                ...(accentName ? { accentName } : {}),
                recipient: {
                    kind: 'agent_team_member',
                    teamId,
                    memberId: member.memberId,
                    ...(member.memberLabel ? { memberLabel: member.memberLabel } : {}),
                } satisfies ParticipantRecipientV1,
            });
        }
    }

    return targets;
}

export function deriveAutoRecipientFromFocusedToolTranscript(params: Readonly<{
    session: Session;
    tool: ToolCall;
    messages: readonly Message[];
}>): ParticipantRecipientV1 | null {
    if (params.tool?.name === 'SubAgentRun' && isSubAgentRunToolRunning(params.tool)) {
        const runId = readExecutionRunIdFromSubAgentRunTool(params.tool);
        return runId ? ({ kind: 'execution_run', runId } satisfies ParticipantRecipientV1) : null;
    }

    if (params.tool?.name === 'Task' || params.tool?.name === 'Agent') {
        const spawned =
            deriveClaudeSpawnedTeammateFromTaskToolResult(params.tool.result) ??
            deriveClaudeSpawnedTeammateFromTaskToolInput(params.tool.input);
        if (spawned) {
            return {
                kind: 'agent_team_member',
                teamId: spawned.teamId,
                memberId: spawned.memberId,
                ...(spawned.memberLabel ? { memberLabel: spawned.memberLabel } : {}),
            } satisfies ParticipantRecipientV1;
        }

        // Some Claude tool-call payloads omit `team_name` from the focused Agent tool input even though a team
        // exists in the transcript (e.g. "Agent — Alpha: ..."). In these cases, infer the team id from the
        // transcript snapshot and use the agent name as the member id.
        if (params.tool?.name === 'Agent') {
            const input = params.tool.input as any;
            const rawName = typeof input?.name === 'string' ? String(input.name).trim() : '';
            if (rawName.length > 0) {
                const flavor = typeof (params.session as any)?.metadata?.flavor === 'string' ? String((params.session as any).metadata.flavor) : null;
                const providerSnapshot = deriveProviderParticipantSnapshot({ flavor, messages: params.messages });
                const teamId = providerSnapshot.claudeTeam?.teamId ?? null;
                if (teamId) {
                    const memberId = rawName.includes('@') ? rawName : `${rawName}@${teamId}`;
                    return {
                        kind: 'agent_team_member',
                        teamId,
                        memberId,
                        memberLabel: rawName,
                    } satisfies ParticipantRecipientV1;
                }
            }
        }
    }

    return null;
}
