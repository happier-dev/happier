import {
    getAgentTeamShutdownApprovedEventType,
    isAgentTeamConfigMutationToolName,
    isAgentTeamCreateToolName,
    isAgentTeamDeleteToolName,
    isAgentTeamSendMessageToolName,
    isAgentTeamSubagentSpawnToolName,
    readAgentTeamIdFromConfigPath,
} from './descriptor';
import type { AgentTeamMessage, AgentTeamSessionProviderDescriptor, AgentTeamToolCallMessage } from './types';

export type AgentTeamParticipantSnapshot = Readonly<{
    teamId: string | null;
    members: ReadonlyArray<Readonly<{ memberId: string; memberLabel?: string; memberColor?: string }>>;
}>;

function tryParseJsonObjectString(value: string): Record<string, unknown> | null {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readStringField(record: Readonly<Record<string, unknown>> | null | undefined, key: string): string | null {
    const value = record?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function hasAgentTeamCreateFailureSignal(value: unknown, depth = 0): boolean {
    if (depth > 4 || value == null) return false;

    if (typeof value === 'string') {
        const normalized = value.replaceAll('\\"', '"').trim();
        const parsed = tryParseJsonObjectString(normalized);
        if (parsed) return hasAgentTeamCreateFailureSignal(parsed, depth + 1);
        const lower = normalized.toLowerCase();
        return (
            /^error\s*:/i.test(normalized)
            || lower.includes('already leading team')
            || /"ok"\s*:\s*false/i.test(normalized)
            || /"success"\s*:\s*false/i.test(normalized)
        );
    }

    if (Array.isArray(value)) {
        return value.some((item) => hasAgentTeamCreateFailureSignal(item, depth + 1));
    }

    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (record.ok === false || record.success === false) return true;
        return Object.values(record).some((item) => hasAgentTeamCreateFailureSignal(item, depth + 1));
    }

    return false;
}

function hasAgentTeamCreateSuccessSignal(value: unknown, depth = 0): boolean {
    if (depth > 4 || value == null) return false;

    if (typeof value === 'string') {
        const normalized = value.replaceAll('\\"', '"').trim();
        const parsed = tryParseJsonObjectString(normalized);
        if (parsed) return hasAgentTeamCreateSuccessSignal(parsed, depth + 1);
        return (
            /"ok"\s*:\s*true/i.test(normalized)
            || /"success"\s*:\s*true/i.test(normalized)
            || /"team_name"\s*:\s*"[^"]+"/i.test(normalized)
            || /"lead_agent_id"\s*:\s*"[^"]+"/i.test(normalized)
        );
    }

    if (Array.isArray(value)) {
        return value.some((item) => hasAgentTeamCreateSuccessSignal(item, depth + 1));
    }

    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (record.ok === true || record.success === true) return true;
        if (typeof record.team_name === 'string' || typeof record.lead_agent_id === 'string') return true;
        return Object.values(record).some((item) => hasAgentTeamCreateSuccessSignal(item, depth + 1));
    }

    return false;
}

function hasAgentTeamDeleteFailureSignal(value: unknown, depth = 0): boolean {
    if (depth > 4 || value == null) return false;

    if (typeof value === 'string') {
        const normalized = value.replaceAll('\\"', '"').trim();
        const parsed = tryParseJsonObjectString(normalized);
        if (parsed) return hasAgentTeamDeleteFailureSignal(parsed, depth + 1);
        const lower = normalized.toLowerCase();
        return (
            /^error\s*:/i.test(normalized)
            || lower.includes('cannot cleanup team')
            || lower.includes('use requestshutdown')
            || /"ok"\s*:\s*false/i.test(normalized)
            || /"success"\s*:\s*false/i.test(normalized)
        );
    }

    if (Array.isArray(value)) {
        return value.some((item) => hasAgentTeamDeleteFailureSignal(item, depth + 1));
    }

    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (record.ok === false || record.success === false) return true;
        return Object.values(record).some((item) => hasAgentTeamDeleteFailureSignal(item, depth + 1));
    }

    return false;
}

function hasAgentTeamDeleteSuccessSignal(value: unknown, depth = 0): boolean {
    if (depth > 4 || value == null) return false;

    if (typeof value === 'string') {
        const normalized = value.replaceAll('\\"', '"').trim();
        const parsed = tryParseJsonObjectString(normalized);
        if (parsed) return hasAgentTeamDeleteSuccessSignal(parsed, depth + 1);
        return /"ok"\s*:\s*true/i.test(normalized) || /"success"\s*:\s*true/i.test(normalized);
    }

    if (Array.isArray(value)) {
        return value.some((item) => hasAgentTeamDeleteSuccessSignal(item, depth + 1));
    }

    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (record.ok === true || record.success === true) return true;
        return Object.values(record).some((item) => hasAgentTeamDeleteSuccessSignal(item, depth + 1));
    }

    return false;
}

function readTeamIdFromAgentTeamCreateInput(input: unknown): string | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    const value =
        readStringField(record, 'team_name')
        ?? readStringField(record, 'teamName')
        ?? readStringField(record, 'team')
        ?? readStringField(record, 'teamId')
        ?? readStringField(record, 'team_id');
    const trimmed = value ?? '';
    return trimmed.length > 0 ? trimmed : null;
}

function readTeamIdFromAgentTeamCreateResult(result: unknown): string | null {
    if (!result) return null;

    if (typeof result === 'string') {
        const parsed = tryParseJsonObjectString(result);
        if (parsed) return readTeamIdFromAgentTeamCreateResult(parsed);
        return null;
    }

    if (result && typeof result === 'object' && !Array.isArray(result)) {
        const record = result as Record<string, unknown>;

        const toolUseResult = asRecord(record.tool_use_result);
        if (toolUseResult) {
            const teamName = readStringField(toolUseResult, 'team_name') ?? '';
            if (teamName) return teamName;
        }

        const directTeamName = readStringField(record, 'team_name') ?? '';
        if (directTeamName) return directTeamName;
    }

    const text = coerceTextFromToolResult(result);
    if (!text) return null;

    const parsed = tryParseJsonObjectString(text.replaceAll('\\"', '"'));
    if (parsed && typeof parsed.team_name === 'string') {
        const teamName = String(parsed.team_name).trim();
        if (teamName) return teamName;
    }

    return null;
}

function readMemberIdFromAgentTeamDeleteInput(input: unknown, teamIdFallback: string | null): string | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    const directId =
        readStringField(record, 'agent_id')
        ?? readStringField(record, 'teammate_id')
        ?? readStringField(record, 'member_id')
        ?? '';
    if (directId.length > 0) return directId;

    const rawName =
        readStringField(record, 'name')
        ?? readStringField(record, 'recipient')
        ?? readStringField(record, 'target')
        ?? '';
    if (!rawName) return null;
    if (['broadcast', 'team', 'all', 'everyone', 'teammates', 'members'].includes(rawName.toLowerCase())) return null;
    if (rawName.includes('@')) return rawName;

    const teamId = readTeamIdFromAgentTeamCreateInput(input) ?? teamIdFallback;
    if (!teamId) return null;
    return `${rawName}@${teamId}`;
}

function coerceTextFromToolResult(result: unknown): string | null {
    if (typeof result === 'string') return result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    const record = result as Record<string, unknown>;
    if (typeof record.content === 'string') return record.content;
    const content = record.content;
    if (!Array.isArray(content)) return null;
    const chunks: string[] = [];
    for (const item of content) {
        const recordItem = asRecord(item);
        if (!recordItem || recordItem.type !== 'text') continue;
        const text = recordItem.text;
        if (typeof text === 'string' && text.trim().length > 0) chunks.push(text);
    }
    const joined = chunks.join('\n').trim();
    return joined.length > 0 ? joined : null;
}

function readLowerCase(value: string): string {
    return value.trim().toLowerCase();
}

function findMemberIdCaseInsensitive(
    membersById: ReadonlyMap<string, { memberId: string; memberLabel?: string; memberColor?: string }>,
    candidate: string,
): string | null {
    if (!candidate) return null;
    if (membersById.has(candidate)) return candidate;
    const needle = readLowerCase(candidate);
    for (const memberId of membersById.keys()) {
        if (readLowerCase(memberId) === needle) return memberId;
    }
    return null;
}

function resolveTeammateIdFromShutdownNotification(
    from: string,
    teamId: string | null,
    membersById: ReadonlyMap<string, { memberId: string; memberLabel?: string; memberColor?: string }>,
): string | null {
    const rawFrom = from.trim();
    if (!rawFrom) return null;

    const byExactId = findMemberIdCaseInsensitive(membersById, rawFrom);
    if (byExactId) return byExactId;

    if (!rawFrom.includes('@') && teamId) {
        const withTeam = `${rawFrom}@${teamId}`;
        const byTeamId = findMemberIdCaseInsensitive(membersById, withTeam);
        if (byTeamId) return byTeamId;
    }

    const fromLower = readLowerCase(rawFrom);
    for (const member of membersById.values()) {
        const label = member.memberLabel ? readLowerCase(member.memberLabel) : '';
        if (label && label === fromLower) return member.memberId;

        const prefix = readLowerCase(member.memberId.split('@')[0] ?? '');
        if (prefix && prefix === fromLower) return member.memberId;
    }

    return null;
}

function readTeammateIdFromShutdownApprovedToolMessages(
    descriptor: AgentTeamSessionProviderDescriptor,
    messages: unknown,
    teamId: string | null,
    membersById: ReadonlyMap<string, { memberId: string; memberLabel?: string; memberColor?: string }>,
): string | null {
    if (!Array.isArray(messages)) return null;
    for (const message of messages) {
        const messageRecord = asRecord(message);
        if (!messageRecord) continue;
        const text = readStringField(messageRecord, 'text') ?? '';
        if (text) {
            const normalizedText = (() => {
                let current = text;
                // Some sidechain payloads arrive double-encoded as JSON strings, e.g.
                // "\"{\\\"type\\\":\\\"shutdown_approved\\\",...}\""
                for (let i = 0; i < 2; i += 1) {
                    const trimmed = current.trim();
                    if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) break;
                    try {
                        const unwrapped = JSON.parse(trimmed);
                        if (typeof unwrapped !== 'string') break;
                        current = unwrapped;
                    } catch {
                        break;
                    }
                }
                return current.trim();
            })();

            const parsed =
                tryParseJsonObjectString(normalizedText)
                ?? (normalizedText.includes('\\"') ? tryParseJsonObjectString(normalizedText.replaceAll('\\"', '"')) : null);
            if (parsed) {
                const eventType = readStringField(parsed, 'type') ?? '';
                if (eventType === getAgentTeamShutdownApprovedEventType(descriptor)) {
                    const from = readStringField(parsed, 'from') ?? '';
                    if (from) {
                        const resolved = resolveTeammateIdFromShutdownNotification(from, teamId, membersById);
                        if (resolved) return resolved;
                    }
                }
            }
        }

        const nestedChildren = Array.isArray(messageRecord.children) ? messageRecord.children : null;
        if (nestedChildren) {
            const nestedResolved = readTeammateIdFromShutdownApprovedToolMessages(descriptor, nestedChildren, teamId, membersById);
            if (nestedResolved) return nestedResolved;
        }

        const nestedTool = asRecord(messageRecord.tool);
        const nestedToolMessages =
            nestedTool && Array.isArray(nestedTool.messages)
                ? nestedTool.messages
                : null;
        if (nestedToolMessages) {
            const nestedResolved = readTeammateIdFromShutdownApprovedToolMessages(descriptor, nestedToolMessages, teamId, membersById);
            if (nestedResolved) return nestedResolved;
        }

        const nestedMessages = Array.isArray(messageRecord.messages) ? messageRecord.messages : null;
        if (nestedMessages) {
            const nestedResolved = readTeammateIdFromShutdownApprovedToolMessages(descriptor, nestedMessages, teamId, membersById);
            if (nestedResolved) return nestedResolved;
        }
    }
    return null;
}

export function agentTeamFocusedTranscriptShowsTeammateShutdownApproved(params: Readonly<{
    descriptor: AgentTeamSessionProviderDescriptor;
    teamId: string;
    memberId: string;
    memberLabel?: string;
    focusedMessages: readonly AgentTeamMessage[] | undefined;
}>): boolean {
    const focusedMessages = params.focusedMessages;
    if (!Array.isArray(focusedMessages) || focusedMessages.length === 0) return false;

    const membersById = new Map<string, { memberId: string; memberLabel?: string; memberColor?: string }>();
    membersById.set(params.memberId, {
        memberId: params.memberId,
        ...(params.memberLabel ? { memberLabel: params.memberLabel } : {}),
    });

    const shutdownMemberId = readTeammateIdFromShutdownApprovedToolMessages(
        params.descriptor,
        focusedMessages,
        params.teamId,
        membersById,
    );
    return shutdownMemberId === params.memberId;
}

function extractAgentIdsFromJsonLikeText(text: string): string[] {
    const ids = new Set<string>();
    const normalized = text.replaceAll('\\"', '"');
    const pattern = /["']agentId["']\s*:\s*["']([^"'\s,]+)["']/g;
    for (const match of normalized.matchAll(pattern)) {
        const value = String(match[1] ?? '').trim();
        if (value.length > 0) ids.add(value);
    }
    return Array.from(ids);
}

function deriveRemovedTeamMemberIdsFromConfigMutation(params: Readonly<{
    descriptor: AgentTeamSessionProviderDescriptor;
    toolName: string | null | undefined;
    toolInput: unknown;
    toolResult: unknown;
    teamIdFallback: string | null;
}>): { teamId: string | null; removedMemberIds: string[] } | null {
    const toolName = params.toolName ?? null;
    if (!isAgentTeamConfigMutationToolName(params.descriptor, toolName)) return null;

    const input = params.toolInput && typeof params.toolInput === 'object' && !Array.isArray(params.toolInput)
        ? params.toolInput as Record<string, unknown>
        : null;
    const result = params.toolResult && typeof params.toolResult === 'object' && !Array.isArray(params.toolResult)
        ? params.toolResult as Record<string, unknown>
        : null;
    const toolUseResult = result?.tool_use_result && typeof result.tool_use_result === 'object' && !Array.isArray(result.tool_use_result)
        ? result.tool_use_result as Record<string, unknown>
        : null;

    const filePath =
        (typeof input?.file_path === 'string' ? input.file_path : null)
        ?? readStringField(input, 'filePath')
        ?? readStringField(toolUseResult, 'filePath');
    if (!filePath) return null;

    const teamId = readAgentTeamIdFromConfigPath(params.descriptor, filePath) ?? params.teamIdFallback;
    if (!teamId) return null;

    const oldIds = new Set<string>();
    const newIds = new Set<string>();
    const removedIds = new Set<string>();

    const oldString =
        (typeof input?.old_string === 'string' ? input.old_string : null)
        ?? readStringField(input, 'oldString')
        ?? readStringField(toolUseResult, 'oldString');
    const newString =
        (typeof input?.new_string === 'string' ? input.new_string : null)
        ?? readStringField(input, 'newString')
        ?? readStringField(toolUseResult, 'newString');

    if (oldString) {
        for (const id of extractAgentIdsFromJsonLikeText(oldString)) oldIds.add(id);
    }
    if (newString) {
        for (const id of extractAgentIdsFromJsonLikeText(newString)) newIds.add(id);
    }

    const structuredPatch = Array.isArray(toolUseResult?.structuredPatch) ? toolUseResult?.structuredPatch : [];
    for (const chunk of structuredPatch) {
        const chunkRecord = asRecord(chunk);
        if (!chunkRecord) continue;
        const lines = Array.isArray(chunkRecord.lines) ? chunkRecord.lines : [];
        for (const line of lines) {
            if (typeof line !== 'string') continue;
            const trimmed = line.trimStart();
            if (!trimmed.startsWith('-')) continue;
            for (const id of extractAgentIdsFromJsonLikeText(trimmed)) removedIds.add(id);
        }
    }

    for (const oldId of oldIds) {
        if (!newIds.has(oldId)) removedIds.add(oldId);
    }

    if (removedIds.size === 0) return null;
    return { teamId, removedMemberIds: Array.from(removedIds) };
}

function readMemberLabelFromAgentTeamSendMessageInput(input: unknown): string | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    const raw =
        readStringField(record, 'name')
        ?? readStringField(record, 'agent_name')
        ?? readStringField(record, 'agentName')
        ?? readStringField(record, 'recipient')
        ?? readStringField(record, 'target')
        ?? '';
    if (['broadcast', 'team', 'all', 'everyone', 'teammates', 'members'].includes(raw.toLowerCase())) return null;
    return raw.length > 0 ? raw : null;
}

export function deriveAgentTeamSpawnedTeammateFromTaskToolResult(
    result: unknown,
): { teamId: string; memberId: string; memberLabel?: string; memberColor?: string } | null {
    if (typeof result === 'string') {
        const parsed = tryParseJsonObjectString(result);
        if (parsed) {
            const parsedResult = deriveAgentTeamSpawnedTeammateFromTaskToolResult(parsed);
            if (parsedResult) return parsedResult;
        }
    }

    if (result && typeof result === 'object' && !Array.isArray(result)) {
        const resultRecord = result as Record<string, unknown>;
        const toolUseResult = asRecord(resultRecord.tool_use_result);
        if (toolUseResult) {
            if (toolUseResult.status === 'teammate_spawned') {
                const teamId = readStringField(toolUseResult, 'team_name') ?? '';
                const memberId =
                    readStringField(toolUseResult, 'agent_id')
                    ?? readStringField(toolUseResult, 'teammate_id')
                    ?? '';
                const memberLabel = readStringField(toolUseResult, 'name') ?? '';
                const memberColor = readStringField(toolUseResult, 'color') ?? '';
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

export function deriveAgentTeamSpawnedTeammateFromTaskToolInput(
    input: unknown,
): { teamId: string; memberId: string; memberLabel?: string; memberColor?: string } | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;

    const teamId = readTeamIdFromAgentTeamCreateInput(record);
    if (!teamId) return null;

    const directId =
        readStringField(record, 'agent_id')
        ?? readStringField(record, 'teammate_id')
        ?? '';
    if (directId.length > 0) return { teamId, memberId: directId };

    const rawName = readStringField(record, 'name') ?? '';
    if (!rawName) return null;
    const memberId = rawName.includes('@') ? rawName : `${rawName}@${teamId}`;
    return { teamId, memberId, memberLabel: rawName };
}

export function deriveAgentTeamParticipants(params: Readonly<{
    descriptor: AgentTeamSessionProviderDescriptor;
    messages: readonly AgentTeamMessage[];
}>): AgentTeamParticipantSnapshot {
    let teamId: string | null = null;
    const membersById = new Map<string, { memberId: string; memberLabel?: string; memberColor?: string }>();
    const terminatedMemberIdsLower = new Set<string>();
    const orderedToolMessages = params.messages
        .map((message, index) => ({ message, index }))
        .filter((entry): entry is { message: AgentTeamToolCallMessage; index: number } => Boolean(entry.message) && entry.message.kind === 'tool-call')
        .sort((left, right) => {
            const leftSeq = typeof left.message.seq === 'number' && Number.isFinite(left.message.seq) ? left.message.seq : null;
            const rightSeq = typeof right.message.seq === 'number' && Number.isFinite(right.message.seq) ? right.message.seq : null;
            if (leftSeq !== null && rightSeq !== null && leftSeq !== rightSeq) return leftSeq - rightSeq;
            if (leftSeq !== null && rightSeq === null) return -1;
            if (leftSeq === null && rightSeq !== null) return 1;

            const leftCreatedAt =
                typeof left.message.createdAt === 'number' && Number.isFinite(left.message.createdAt)
                    ? left.message.createdAt
                    : (typeof left.message.tool?.createdAt === 'number' && Number.isFinite(left.message.tool.createdAt) ? left.message.tool.createdAt : 0);
            const rightCreatedAt =
                typeof right.message.createdAt === 'number' && Number.isFinite(right.message.createdAt)
                    ? right.message.createdAt
                    : (typeof right.message.tool?.createdAt === 'number' && Number.isFinite(right.message.tool.createdAt) ? right.message.tool.createdAt : 0);
            if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt - rightCreatedAt;

            return left.index - right.index;
        });
    const hasCompleteSeqSignal = orderedToolMessages.length > 0
        && orderedToolMessages.every(
            (entry) => typeof entry.message.seq === 'number' && Number.isFinite(entry.message.seq),
        );
    const deferredConfigRemovals: Array<{ teamId: string | null; memberId: string }> = [];

    for (const { message: toolMsg } of orderedToolMessages) {
        const toolName = toolMsg.tool?.name;
        if (isAgentTeamCreateToolName(params.descriptor, toolName)) {
            const candidateTeamId =
                readTeamIdFromAgentTeamCreateResult(toolMsg.tool.result)
                ?? readTeamIdFromAgentTeamCreateInput(toolMsg.tool.input);
            if (!candidateTeamId) continue;

            if (hasAgentTeamCreateFailureSignal(toolMsg.tool.result)) continue;

            const hasSuccessSignal = hasAgentTeamCreateSuccessSignal(toolMsg.tool.result);
            if (teamId && !hasSuccessSignal) continue;

            teamId = candidateTeamId;
            continue;
        }
        if (isAgentTeamDeleteToolName(params.descriptor, toolName)) {
            if (toolMsg.tool?.state !== 'completed') continue;
            if (hasAgentTeamDeleteFailureSignal(toolMsg.tool.result)) continue;
            if (!hasAgentTeamDeleteSuccessSignal(toolMsg.tool.result)) continue;
            const deletedTeamId = readTeamIdFromAgentTeamCreateInput(toolMsg.tool.input) ?? teamId;
            const deletedMemberId = readMemberIdFromAgentTeamDeleteInput(toolMsg.tool.input, deletedTeamId);
            if (deletedMemberId) {
                terminatedMemberIdsLower.add(readLowerCase(deletedMemberId));
                membersById.delete(deletedMemberId);
                continue;
            }
            if (deletedTeamId && (!teamId || teamId === deletedTeamId)) {
                teamId = null;
                membersById.clear();
                terminatedMemberIdsLower.clear();
            }
            continue;
        }

        if (isAgentTeamSendMessageToolName(params.descriptor, toolName)) {
            const candidateTeamId: string | null = readTeamIdFromAgentTeamCreateInput(toolMsg.tool.input) ?? teamId;
            if (!teamId && candidateTeamId) teamId = candidateTeamId;

            const memberId = readMemberIdFromAgentTeamDeleteInput(toolMsg.tool.input, candidateTeamId ?? teamId);
            if (memberId) {
                if (terminatedMemberIdsLower.has(readLowerCase(memberId))) continue;
                const existing = membersById.get(memberId);
                if (!existing) {
                    const label = readMemberLabelFromAgentTeamSendMessageInput(toolMsg.tool.input);
                    membersById.set(memberId, { memberId, ...(label ? { memberLabel: label } : {}) });
                }
            }
        }

        const removedFromConfigMutation = deriveRemovedTeamMemberIdsFromConfigMutation({
            descriptor: params.descriptor,
            toolName,
            toolInput: toolMsg.tool.input,
            toolResult: toolMsg.tool.result,
            teamIdFallback: teamId,
        });
        if (removedFromConfigMutation) {
            const configTeamId = removedFromConfigMutation.teamId;
            if (!teamId && configTeamId) teamId = configTeamId;
            const effectiveTeamId = configTeamId ?? teamId;

            for (const removedMemberId of removedFromConfigMutation.removedMemberIds) {
                const normalizedRemovedMemberId = String(removedMemberId).trim();
                if (!normalizedRemovedMemberId) continue;
                terminatedMemberIdsLower.add(readLowerCase(normalizedRemovedMemberId));
                deferredConfigRemovals.push({
                    teamId: effectiveTeamId ?? null,
                    memberId: normalizedRemovedMemberId,
                });

                const resolvedByExact =
                    resolveTeammateIdFromShutdownNotification(normalizedRemovedMemberId, effectiveTeamId, membersById)
                    ?? (normalizedRemovedMemberId.includes('@')
                        ? resolveTeammateIdFromShutdownNotification(
                            String(normalizedRemovedMemberId.split('@')[0] ?? '').trim(),
                            effectiveTeamId,
                            membersById,
                        )
                        : null);
                if (resolvedByExact) {
                    terminatedMemberIdsLower.add(readLowerCase(resolvedByExact));
                    membersById.delete(resolvedByExact);
                }
            }
        }

        if (isAgentTeamSubagentSpawnToolName(params.descriptor, toolName)) {
            const spawned =
                deriveAgentTeamSpawnedTeammateFromTaskToolResult(toolMsg.tool.result) ??
                deriveAgentTeamSpawnedTeammateFromTaskToolInput(toolMsg.tool.input);
            if (spawned) {
                teamId = teamId ?? spawned.teamId;
                terminatedMemberIdsLower.delete(readLowerCase(spawned.memberId));
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

            const shutdownMemberId = readTeammateIdFromShutdownApprovedToolMessages(
                params.descriptor,
                asRecord(toolMsg.tool)?.messages,
                teamId ?? spawned?.teamId ?? null,
                membersById,
            ) ?? readTeammateIdFromShutdownApprovedToolMessages(
                params.descriptor,
                toolMsg.children,
                teamId ?? spawned?.teamId ?? null,
                membersById,
            );
            if (shutdownMemberId) {
                terminatedMemberIdsLower.add(readLowerCase(shutdownMemberId));
                membersById.delete(shutdownMemberId);
            }
        }
    }

    if (!hasCompleteSeqSignal) {
        for (const removal of deferredConfigRemovals) {
            const removedMemberId = removal.memberId;
            const resolvedByExact =
                resolveTeammateIdFromShutdownNotification(removedMemberId, removal.teamId ?? teamId, membersById)
                ?? (removedMemberId.includes('@')
                    ? resolveTeammateIdFromShutdownNotification(
                        String(removedMemberId.split('@')[0] ?? '').trim(),
                        removal.teamId ?? teamId,
                        membersById,
                    )
                    : null);
            if (resolvedByExact) {
                terminatedMemberIdsLower.add(readLowerCase(resolvedByExact));
                membersById.delete(resolvedByExact);
            }
        }
    }

    const members = Array.from(membersById.values());
    return { teamId, members };
}
