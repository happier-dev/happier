import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

export type ClaudeTeamParticipantSnapshot = Readonly<{
    teamId: string | null;
    members: ReadonlyArray<Readonly<{ memberId: string; memberLabel?: string; memberColor?: string }>>;
}>;

function readTeamIdFromAgentTeamCreateInput(input: unknown): string | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    const value =
        typeof record.team_name === 'string'
            ? record.team_name
            : typeof (record as any).teamName === 'string'
                ? (record as any).teamName
                : typeof (record as any).team === 'string'
                    ? (record as any).team
                    : typeof (record as any).teamId === 'string'
                        ? (record as any).teamId
                        : typeof (record as any).team_id === 'string'
                            ? (record as any).team_id
                : null;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

function coerceTextFromToolResult(result: unknown): string | null {
    if (typeof result === 'string') return result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    const record = result as Record<string, unknown>;
    if (typeof record.content === 'string') return record.content;
    const content = (record as any).content as unknown;
    if (!Array.isArray(content)) return null;
    const chunks: string[] = [];
    for (const item of content) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        if ((item as any).type !== 'text') continue;
        const text = (item as any).text;
        if (typeof text === 'string' && text.trim().length > 0) chunks.push(text);
    }
    const joined = chunks.join('\n').trim();
    return joined.length > 0 ? joined : null;
}

export function deriveClaudeSpawnedTeammateFromTaskToolResult(
    result: unknown,
): { teamId: string; memberId: string; memberLabel?: string; memberColor?: string } | null {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
        const toolUseResult = (result as any).tool_use_result;
        if (toolUseResult && typeof toolUseResult === 'object' && !Array.isArray(toolUseResult)) {
            if (toolUseResult.status === 'teammate_spawned') {
                const teamId = typeof toolUseResult.team_name === 'string' ? String(toolUseResult.team_name).trim() : '';
                const memberId =
                    typeof toolUseResult.agent_id === 'string'
                        ? String(toolUseResult.agent_id).trim()
                        : typeof toolUseResult.teammate_id === 'string'
                            ? String(toolUseResult.teammate_id).trim()
                            : '';
                const memberLabel = typeof toolUseResult.name === 'string' ? String(toolUseResult.name).trim() : '';
                const memberColor = typeof toolUseResult.color === 'string' ? String(toolUseResult.color).trim() : '';
                if (teamId && memberId) {
                    return {
                        teamId,
                        memberId,
                        ...(memberLabel ? { memberLabel } : {}),
                        ...(memberColor ? { memberColor } : {}),
                    };
                }
            }
        }
    }

    const text = coerceTextFromToolResult(result);
    if (!text) return null;
    const agentIdMatch = text.match(/\b(?:agent_id|teammate_id)\s*:\s*([^\s]+)/i);
    const teamNameMatch = text.match(/\bteam_name\s*:\s*([^\s]+)/i);
    if (!agentIdMatch || !teamNameMatch) return null;
    const memberId = String(agentIdMatch[1] ?? '').trim();
    const teamId = String(teamNameMatch[1] ?? '').trim();
    const nameMatch = text.match(/\bname\s*:\s*([^\s]+)/i);
    const memberLabel = nameMatch ? String(nameMatch[1] ?? '').trim() : '';
    if (!memberId || !teamId) return null;
    return { teamId, memberId, ...(memberLabel ? { memberLabel } : {}) };
}

export function deriveClaudeSpawnedTeammateFromTaskToolInput(
    input: unknown,
): { teamId: string; memberId: string; memberLabel?: string; memberColor?: string } | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;

    const teamId = readTeamIdFromAgentTeamCreateInput(record);
    if (!teamId) return null;

    const directId =
        typeof (record as any).agent_id === 'string'
            ? String((record as any).agent_id).trim()
            : typeof (record as any).teammate_id === 'string'
                ? String((record as any).teammate_id).trim()
                : '';
    if (directId.length > 0) return { teamId, memberId: directId };

    const rawName = typeof (record as any).name === 'string' ? String((record as any).name).trim() : '';
    if (!rawName) return null;
    const memberId = rawName.includes('@') ? rawName : `${rawName}@${teamId}`;
    return { teamId, memberId, memberLabel: rawName };
}

export function deriveClaudeTeamParticipants(params: Readonly<{ messages: readonly Message[] }>): ClaudeTeamParticipantSnapshot {
    let teamId: string | null = null;
    const membersById = new Map<string, { memberId: string; memberLabel?: string; memberColor?: string }>();

    for (const m of params.messages) {
        if (!m || m.kind !== 'tool-call') continue;
        const toolMsg = m as ToolCallMessage;
        const toolName = toolMsg.tool?.name;
        if (toolName === 'TeamCreate' || toolName === 'AgentTeamCreate') {
            teamId = readTeamIdFromAgentTeamCreateInput(toolMsg.tool.input) ?? teamId;
            continue;
        }
        if (toolName === 'Task' || toolName === 'Agent') {
            const spawned =
                deriveClaudeSpawnedTeammateFromTaskToolResult(toolMsg.tool.result) ??
                deriveClaudeSpawnedTeammateFromTaskToolInput(toolMsg.tool.input);
            if (!spawned) continue;
            teamId = teamId ?? spawned.teamId;
            if (!membersById.has(spawned.memberId)) {
                membersById.set(spawned.memberId, {
                    memberId: spawned.memberId,
                    ...(spawned.memberLabel ? { memberLabel: spawned.memberLabel } : {}),
                    ...(spawned.memberColor ? { memberColor: spawned.memberColor } : {}),
                });
            } else if (spawned.memberColor) {
                const existing = membersById.get(spawned.memberId);
                if (existing && !existing.memberColor) {
                    membersById.set(spawned.memberId, { ...existing, memberColor: spawned.memberColor });
                }
            }
        }
    }

    const members = Array.from(membersById.values());
    return { teamId, members };
}
