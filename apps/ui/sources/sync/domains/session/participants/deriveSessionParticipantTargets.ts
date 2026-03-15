import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { Message, ToolCallMessage, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';

import type { SessionParticipantTarget } from './participantTargets';
import { deriveProviderParticipantSnapshot } from './providers';
import {
    deriveClaudeSpawnedTeammateFromTaskToolInput,
    deriveClaudeSpawnedTeammateFromTaskToolResult,
} from './providers/claude/deriveClaudeTeamParticipants';

type ActiveExecutionRunState = Readonly<{
    runId: string;
    status?: string | null;
}>;

function readExecutionRunIdFromSubAgentRunTool(tool: ToolCall): string | null {
    const input = tool.input as any;
    const inputRunId = typeof input?.runId === 'string' ? String(input.runId).trim() : '';
    if (inputRunId.length > 0) return inputRunId;

    const result = tool.result as any;
    const runId = typeof result?.runId === 'string' ? String(result.runId).trim() : '';
    return runId.length > 0 ? runId : null;
}

function normalizeEmbeddedJsonString(value: string): string {
    return value.replaceAll('\\"', '"');
}

function safeParseObjectFromString(value: string): Record<string, unknown> | null {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
        // ignore
    }
    return null;
}

function readResultStatus(value: unknown): string | null {
    if (value == null) return null;

    if (typeof value === 'string') {
        const normalized = normalizeEmbeddedJsonString(value);
        const parsed = safeParseObjectFromString(normalized);
        if (parsed) return readResultStatus(parsed);
        const directMatch = normalized.match(/\bstatus\s*:\s*"?([a-z_]+)"?/i);
        return directMatch ? String(directMatch[1]).trim().toLowerCase() : null;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const itemStatus = readResultStatus(item);
            if (itemStatus) return itemStatus;
        }
        return null;
    }

    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const status = typeof record.status === 'string' ? String(record.status).trim().toLowerCase() : '';
        if (status) return status;
        for (const item of Object.values(record)) {
            const itemStatus = readResultStatus(item);
            if (itemStatus) return itemStatus;
        }
    }

    return null;
}

function valueHasRequestInterruptedSignal(value: unknown, depth = 0): boolean {
    if (depth > 5 || value == null) return false;

    if (typeof value === 'string') {
        const normalized = normalizeEmbeddedJsonString(value).toLowerCase();
        return normalized.includes('request interrupted');
    }

    if (Array.isArray(value)) {
        return value.some((item) => valueHasRequestInterruptedSignal(item, depth + 1));
    }

    if (typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).some((item) =>
            valueHasRequestInterruptedSignal(item, depth + 1),
        );
    }

    return false;
}

function deriveExecutionRunLifecycleSignal(tool: ToolCall): 'running' | 'terminal' | 'unknown' {
    const resultStatus = readResultStatus(tool.result);
    if (tool.state === 'running' || resultStatus === 'running') return 'running';
    if (resultStatus && resultStatus !== 'running') return 'terminal';

    if (tool.state === 'error') {
        if (valueHasRequestInterruptedSignal(tool.result)) return 'unknown';
        return 'terminal';
    }

    if (tool.state === 'completed') return 'terminal';
    return 'unknown';
}

function focusedMessagesContainRunningExecutionSignal(messages: readonly Message[] | undefined): boolean {
    if (!Array.isArray(messages) || messages.length === 0) return false;

    for (const message of messages) {
        if (!message) continue;
        if (message.kind === 'tool-call') {
            const toolSignal = deriveExecutionRunLifecycleSignal((message as ToolCallMessage).tool);
            if (toolSignal === 'running') return true;
            continue;
        }
        if (message.kind !== 'agent-text') continue;
        const text = typeof (message as any).text === 'string' ? String((message as any).text).toLowerCase() : '';
        if (!text) continue;
        if (text.includes('<status>running</status>')) return true;
        if (text.includes('command running in background')) return true;
        if (text.includes('background task is already running')) return true;
        if (/\bstatus\b[^a-z0-9]+running\b/.test(text)) return true;
    }

    return false;
}

function sortMessagesChronologically(messages: readonly Message[]): readonly Message[] {
    return [...messages]
        .map((m, idx) => ({ m, idx }))
        .sort((a, b) => {
            const aSeq = typeof (a.m as any)?.seq === 'number' ? Number((a.m as any).seq) : null;
            const bSeq = typeof (b.m as any)?.seq === 'number' ? Number((b.m as any).seq) : null;
            if (aSeq != null && bSeq != null && aSeq !== bSeq) return aSeq - bSeq;

            const aCreated = typeof (a.m as any)?.createdAt === 'number' ? Number((a.m as any).createdAt) : null;
            const bCreated = typeof (b.m as any)?.createdAt === 'number' ? Number((b.m as any).createdAt) : null;
            if (aCreated != null && bCreated != null && aCreated !== bCreated) return aCreated - bCreated;

            return a.idx - b.idx;
        })
        .map((entry) => entry.m);
}

function toolNameLooksLikeExecutionRunStop(name: string | null | undefined): boolean {
    if (!name) return false;
    const value = String(name).trim().toLowerCase();
    if (!value) return false;
    return (
        value.includes('execution run stop')
        || value.includes('execution_run_stop')
        || value.includes('delegate run stop')
        || value.includes('delegate_stop')
    );
}

function valueHasOkTrueSignal(value: unknown, depth = 0): boolean {
    if (depth > 4 || value == null) return false;

    if (typeof value === 'string') {
        const normalized = value.replaceAll('\\"', '"');
        return /"ok"\s*:\s*true/i.test(normalized) || /\bok\s*:\s*true\b/i.test(normalized);
    }

    if (Array.isArray(value)) {
        return value.some((item) => valueHasOkTrueSignal(item, depth + 1));
    }

    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (record.ok === true) return true;
        return Object.values(record).some((item) => valueHasOkTrueSignal(item, depth + 1));
    }

    return false;
}

function valueHasExecutionRunNotRunningSignal(value: unknown, depth = 0): boolean {
    if (depth > 4 || value == null) return false;

    if (typeof value === 'string') {
        const normalized = value.replaceAll('\\"', '"');
        return (
            /\berrorCode\s*:\s*"?execution_run_not_allowed"?/i.test(normalized)
            || /\berrorCode\s*:\s*"?execution_run_not_running"?/i.test(normalized)
            || /\bnot running\b/i.test(normalized)
            || /\balready finished\b/i.test(normalized)
        );
    }

    if (Array.isArray(value)) {
        return value.some((item) => valueHasExecutionRunNotRunningSignal(item, depth + 1));
    }

    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const errorCode = typeof record.errorCode === 'string' ? String(record.errorCode).trim().toLowerCase() : '';
        if (errorCode === 'execution_run_not_allowed' || errorCode === 'execution_run_not_running') return true;

        const error = typeof record.error === 'string' ? String(record.error).trim().toLowerCase() : '';
        if (error.includes('not running') || error.includes('already finished')) return true;

        return Object.values(record).some((item) => valueHasExecutionRunNotRunningSignal(item, depth + 1));
    }

    return false;
}

function deriveExplicitlyStoppedExecutionRunIds(messages: readonly Message[]): ReadonlySet<string> {
    const stoppedRunIds = new Set<string>();
    for (const m of messages) {
        if (!m || m.kind !== 'tool-call') continue;
        const toolMsg = m as ToolCallMessage;
        if (!toolMsg.tool || toolMsg.tool.state !== 'completed') continue;
        if (!toolNameLooksLikeExecutionRunStop(toolMsg.tool.name)) continue;

        const runId = readExecutionRunIdFromSubAgentRunTool(toolMsg.tool);
        if (!runId) continue;
        if (!valueHasOkTrueSignal(toolMsg.tool.result) && !valueHasExecutionRunNotRunningSignal(toolMsg.tool.result)) continue;

        stoppedRunIds.add(runId);
    }
    return stoppedRunIds;
}

function deriveRunningExecutionRunTargetMap(params: Readonly<{
    messages: readonly Message[];
    explicitlyStoppedRunIds: ReadonlySet<string>;
}>): ReadonlyMap<string, string | undefined> {
    const runningRunIds = new Set<string>();
    const displayLabels = new Map<string, string | undefined>();
    const orderedMessages = sortMessagesChronologically(params.messages);

    for (const message of orderedMessages) {
        if (!message || message.kind !== 'tool-call') continue;
        const toolMessage = message as ToolCallMessage;
        if (toolMessage.tool?.name !== 'SubAgentRun') continue;

        const runId = readExecutionRunIdFromSubAgentRunTool(toolMessage.tool);
        if (!runId) continue;
        if (params.explicitlyStoppedRunIds.has(runId)) {
            runningRunIds.delete(runId);
            displayLabels.delete(runId);
            continue;
        }

        const lifecycleSignal = deriveExecutionRunLifecycleSignal(toolMessage.tool);
        if (lifecycleSignal === 'running') {
            runningRunIds.add(runId);
            const label =
                typeof (toolMessage.tool.input as any)?.label === 'string'
                    ? String((toolMessage.tool.input as any).label).trim()
                    : '';
            displayLabels.set(runId, label.length > 0 ? label : undefined);
            continue;
        }

        if (lifecycleSignal === 'terminal') {
            runningRunIds.delete(runId);
            displayLabels.delete(runId);
        }
    }

    const targetMap = new Map<string, string | undefined>();
    for (const runId of runningRunIds) {
        targetMap.set(runId, displayLabels.get(runId));
    }
    return targetMap;
}

function deriveTerminalExecutionRunIdsFromSubAgentMessages(messages: readonly Message[]): ReadonlySet<string> {
    const terminalRunIds = new Set<string>();
    for (const message of messages) {
        if (!message || message.kind !== 'tool-call') continue;
        const toolMessage = message as ToolCallMessage;
        if (toolMessage.tool?.name !== 'SubAgentRun') continue;
        const runId = readExecutionRunIdFromSubAgentRunTool(toolMessage.tool);
        if (!runId) continue;
        const lifecycleSignal = deriveExecutionRunLifecycleSignal(toolMessage.tool);
        if (lifecycleSignal === 'terminal') terminalRunIds.add(runId);
    }
    return terminalRunIds;
}

function extractExecutionRunIdsFromText(text: string): readonly string[] {
    const matches = text.match(/run_[0-9a-f-]{8,}/gi);
    if (!matches) return [];
    return matches.map((value) => String(value).trim()).filter((value) => value.length > 0);
}

function looksLikeExecutionRunStartText(text: string): boolean {
    const normalized = text.toLowerCase();
    return (
        normalized.includes('execution run has been started')
        || normalized.includes('execution run started')
        || normalized.includes('run has been started')
        || normalized.includes('new long-lived execution run started')
        || normalized.includes('bounded execution run started')
    );
}

function deriveRunningExecutionRunTargetMapFromStartMessages(params: Readonly<{
    messages: readonly Message[];
    explicitlyStoppedRunIds: ReadonlySet<string>;
    terminalRunIds: ReadonlySet<string>;
}>): ReadonlyMap<string, string | undefined> {
    const runningRunIds = new Set<string>();

    for (const message of params.messages) {
        if (!message || message.kind !== 'agent-text') continue;
        const text = typeof (message as any).text === 'string' ? String((message as any).text).trim() : '';
        if (!text || !looksLikeExecutionRunStartText(text)) continue;
        const runIds = extractExecutionRunIdsFromText(text);
        for (const runId of runIds) {
            if (params.explicitlyStoppedRunIds.has(runId)) continue;
            if (params.terminalRunIds.has(runId)) continue;
            runningRunIds.add(runId);
        }
    }

    const targetMap = new Map<string, string | undefined>();
    for (const runId of runningRunIds) {
        targetMap.set(runId, undefined);
    }
    return targetMap;
}

function deriveExternallyRunningExecutionRunTargetMap(params: Readonly<{
    activeExecutionRuns: readonly ActiveExecutionRunState[];
    explicitlyStoppedRunIds: ReadonlySet<string>;
}>): ReadonlyMap<string, string | undefined> {
    const targetMap = new Map<string, string | undefined>();
    for (const run of params.activeExecutionRuns) {
        if (!run || typeof run !== 'object') continue;
        const runId = typeof (run as any).runId === 'string' ? String((run as any).runId).trim() : '';
        if (!runId) continue;
        if (params.explicitlyStoppedRunIds.has(runId)) continue;
        const status = typeof (run as any).status === 'string' ? String((run as any).status).trim().toLowerCase() : '';
        if (status !== 'running') continue;
        targetMap.set(runId, undefined);
    }
    return targetMap;
}

function mergeRunningExecutionRunTargetMaps(
    primary: ReadonlyMap<string, string | undefined>,
    secondary: ReadonlyMap<string, string | undefined>,
): ReadonlyMap<string, string | undefined> {
    const merged = new Map<string, string | undefined>(primary);
    for (const [runId, displayLabel] of secondary.entries()) {
        if (merged.has(runId)) continue;
        merged.set(runId, displayLabel);
    }
    return merged;
}

export function deriveSessionParticipantTargets(params: Readonly<{
    session: Session;
    messages: readonly Message[];
    activeExecutionRuns?: readonly ActiveExecutionRunState[];
}>): ReadonlyArray<SessionParticipantTarget> {
    const targets: SessionParticipantTarget[] = [];
    const explicitlyStoppedRunIds = deriveExplicitlyStoppedExecutionRunIds(params.messages);
    const transcriptRunningExecutionRunTargetMap = deriveRunningExecutionRunTargetMap({
        messages: params.messages,
        explicitlyStoppedRunIds,
    });
    const terminalRunIds = deriveTerminalExecutionRunIdsFromSubAgentMessages(params.messages);
    const startedExecutionRunTargetMap = deriveRunningExecutionRunTargetMapFromStartMessages({
        messages: params.messages,
        explicitlyStoppedRunIds,
        terminalRunIds,
    });
    const externalRunningExecutionRunTargetMap = deriveExternallyRunningExecutionRunTargetMap({
        activeExecutionRuns: params.activeExecutionRuns ?? [],
        explicitlyStoppedRunIds,
    });
    const transcriptPlusStartedRunningExecutionRunTargetMap = mergeRunningExecutionRunTargetMaps(
        transcriptRunningExecutionRunTargetMap,
        startedExecutionRunTargetMap,
    );
    const runningExecutionRunTargetMap = mergeRunningExecutionRunTargetMaps(
        transcriptPlusStartedRunningExecutionRunTargetMap,
        externalRunningExecutionRunTargetMap,
    );

    // Provider-agnostic: include only execution runs with a current running lifecycle signal.
    for (const [runId, displayLabel] of runningExecutionRunTargetMap.entries()) {
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
    activeExecutionRuns?: readonly ActiveExecutionRunState[];
    focusedMessages?: readonly Message[];
}>): ParticipantRecipientV1 | null {
    if (params.tool?.name === 'SubAgentRun') {
        const runId = readExecutionRunIdFromSubAgentRunTool(params.tool);
        if (!runId) return null;

        const explicitlyStoppedRunIds = deriveExplicitlyStoppedExecutionRunIds(params.messages);
        if (explicitlyStoppedRunIds.has(runId)) return null;

        const focusedLifecycleSignal = deriveExecutionRunLifecycleSignal(params.tool);
        if (focusedLifecycleSignal === 'running') {
            return { kind: 'execution_run', runId } satisfies ParticipantRecipientV1;
        }
        if (focusedMessagesContainRunningExecutionSignal(params.focusedMessages)) {
            return { kind: 'execution_run', runId } satisfies ParticipantRecipientV1;
        }

        const transcriptRunningExecutionRunTargetMap = deriveRunningExecutionRunTargetMap({
            messages: params.messages,
            explicitlyStoppedRunIds,
        });
        const externalRunningExecutionRunTargetMap = deriveExternallyRunningExecutionRunTargetMap({
            activeExecutionRuns: params.activeExecutionRuns ?? [],
            explicitlyStoppedRunIds,
        });
        const runningExecutionRunTargetMap = mergeRunningExecutionRunTargetMaps(
            transcriptRunningExecutionRunTargetMap,
            externalRunningExecutionRunTargetMap,
        );
        if (runningExecutionRunTargetMap.has(runId)) {
            return { kind: 'execution_run', runId } satisfies ParticipantRecipientV1;
        }
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
