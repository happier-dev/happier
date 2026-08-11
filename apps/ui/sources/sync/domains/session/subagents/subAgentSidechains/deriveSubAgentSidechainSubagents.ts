import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { resolveToolTranscriptSidechainId } from '@/components/tools/shell/views/resolveToolTranscriptSidechainId';
import { buildToolCallMessageRouteId } from '@/sync/domains/messages/messageRouteIds';

import {
    readToolCallFinishedAtMs,
    readToolCallObservedAtMs,
    readToolCallStartedAtMs,
} from '../toolCallActivityTimestamps';
import type { SessionSubagent, SessionSubagentNativeRef } from '../types';
import { resolveSubAgentSidechainProviderLabel } from './resolveSubAgentSidechainProviderLabel';
import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';
import { resolvePendingPermissionRouteForSubAgentTool } from './resolvePendingPermissionRouteForSubAgentTool';

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function readCompletionOnlyNativeSubagent(toolMessage: ToolCallMessage): Record<string, unknown> | null {
    const input = asRecord(toolMessage.tool.input);
    const happier = asRecord(input?._happier) ?? asRecord(input?._happy);
    const nativeSubagent = asRecord(happier?.nativeSubagent);
    if (nativeSubagent?.v !== 1 || nativeSubagent.lifecycle !== 'completion_only') return null;
    return nativeSubagent;
}

const SUBAGENT_TITLE_MAX_LENGTH = 512;

function readBoundedDisplayTitle(value: unknown): string | null {
    const normalized = readNonEmptyString(value);
    if (!normalized) return null;
    if (normalized.length <= SUBAGENT_TITLE_MAX_LENGTH) return normalized;
    return `${normalized.slice(0, SUBAGENT_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * The row title, read from the fields producers actually ship.
 *
 * Ordering, most to least identifying:
 *   name / label      generic explicit titles,
 *   nickname          the human name Codex assigns a spawned agent (rollout `new_agent_nickname`,
 *                     e.g. "Lovelace") — the only field that tells sibling agents apart,
 *   description       what this run is doing (Claude `Task`, Cursor native tasks),
 *   role              Codex's categorical agent role (`new_agent_role`/`agent_type`),
 *   subagent_type     the same categorical answer from Claude/ACP producers,
 *   prompt            last resort, and only for a live agent whose prompt is its sole description.
 *
 * Every candidate is bounded identically: a title is a row label, so no producer field — least of
 * all a whole prompt — may arrive at the layout unbounded.
 */
function readSubAgentDisplayTitle(
    toolMessage: ToolCallMessage,
    completionOnly: boolean,
): string {
    const input = toolMessage.tool.input as Record<string, unknown>;
    const candidates = [
        input?.name,
        input?.label,
        input?.nickname,
        input?.description,
        input?.role,
        input?.subagent_type,
    ];
    if (!completionOnly) candidates.push(input?.prompt);
    for (const candidate of candidates) {
        const title = readBoundedDisplayTitle(candidate);
        if (title) return title;
    }
    return toolMessage.tool.name;
}

function readBoundedNativeString(value: unknown): string | null {
    const normalized = readNonEmptyString(value);
    return normalized && normalized.length <= 512 ? normalized : null;
}

function readCompletionOnlySubtitle(nativeSubagent: Record<string, unknown>): string | null {
    const type = readBoundedNativeString(nativeSubagent.customType)
        ?? readBoundedNativeString(nativeSubagent.type);
    const model = readBoundedNativeString(nativeSubagent.model);
    const values = [type, model].filter((value): value is string => value !== null);
    return values.length > 0 ? values.join(' · ') : null;
}

function deriveCompletionOnlyNativeRef(nativeSubagent: Record<string, unknown>): SessionSubagentNativeRef {
    const type = readBoundedNativeString(nativeSubagent.type);
    const customType = readBoundedNativeString(nativeSubagent.customType);
    const model = readBoundedNativeString(nativeSubagent.model);
    const agentId = readBoundedNativeString(nativeSubagent.agentId);
    const durationMs = typeof nativeSubagent.durationMs === 'number'
        && Number.isFinite(nativeSubagent.durationMs)
        && nativeSubagent.durationMs >= 0
        && nativeSubagent.durationMs <= 2_592_000_000
        ? nativeSubagent.durationMs
        : null;
    return {
        lifecycle: 'completion_only',
        ...(type ? { type } : {}),
        ...(customType ? { customType } : {}),
        ...(model ? { model } : {}),
        ...(agentId ? { agentId } : {}),
        ...(durationMs !== null ? { durationMs } : {}),
    };
}

function deriveSubAgentStatus(
    toolMessage: ToolCallMessage,
    completionOnlyNativeSubagent: Record<string, unknown> | null,
): SessionSubagent['status'] {
    if (toolMessage.tool.state === 'completed') return 'succeeded';
    if (toolMessage.tool.state === 'error') return 'failed';
    if (toolMessage.tool.state === 'running') return 'running';
    return 'unknown';
}

function deriveCompletionOnlyTimestamps(
    toolMessage: ToolCallMessage,
    nativeSubagent: Record<string, unknown>,
): SessionSubagent['timestamps'] {
    const input = asRecord(toolMessage.tool.input);
    const acp = asRecord(input?._acp);
    const snapshotUpdatedAt = typeof acp?.snapshotUpdatedAt === 'number'
        && Number.isFinite(acp.snapshotUpdatedAt)
        && acp.snapshotUpdatedAt >= 0
        ? acp.snapshotUpdatedAt
        : null;
    const finishedAtMs = snapshotUpdatedAt
        ?? (typeof toolMessage.tool.completedAt === 'number'
            ? toolMessage.tool.completedAt
            : toolMessage.createdAt);
    const durationMs = typeof nativeSubagent.durationMs === 'number'
        && Number.isFinite(nativeSubagent.durationMs)
        && nativeSubagent.durationMs >= 0
        && nativeSubagent.durationMs <= 2_592_000_000
        ? nativeSubagent.durationMs
        : null;
    return {
        ...(durationMs !== null ? { startedAtMs: Math.max(0, finishedAtMs - durationMs) } : {}),
        updatedAtMs: finishedAtMs,
        finishedAtMs,
    };
}

/**
 * Timestamps for a live sidechain subagent — the launching tool call IS the agent.
 *
 * The finish is read from the tool call rather than omitted: without it the row's time slot never
 * stops counting, so a subagent that succeeded an hour ago keeps advancing a clock that claims it
 * is still working. When the call recorded no finish, none is claimed (4.9.3).
 */
function deriveSidechainTimestamps(toolMessage: ToolCallMessage): SessionSubagent['timestamps'] {
    const startedAtMs = readToolCallStartedAtMs(toolMessage);
    const finishedAtMs = readToolCallFinishedAtMs(toolMessage);
    const updatedAtMs = readToolCallObservedAtMs(toolMessage);
    return {
        ...(startedAtMs !== null ? { startedAtMs } : {}),
        ...(updatedAtMs !== null ? { updatedAtMs } : {}),
        ...(finishedAtMs !== null ? { finishedAtMs } : {}),
    };
}

function buildCompletionOnlyToolRouteId(toolMessage: ToolCallMessage): string | null {
    const realId = readNonEmptyString(toolMessage.realID);
    if (realId) return `server:${realId}`;
    const localId = readNonEmptyString(toolMessage.localId);
    if (localId) return `local:${localId}`;
    return buildToolCallMessageRouteId({
        toolId: typeof toolMessage.tool.id === 'string' ? toolMessage.tool.id : null,
        fallbackMessageId: toolMessage.id,
    });
}

export function deriveSubAgentSidechainSubagents(params: Readonly<{
    messages: readonly Message[];
    flavor?: string | null;
    excludedSidechainIds?: ReadonlySet<string>;
}>): readonly SessionSubagent[] {
    const subagents: SessionSubagent[] = [];
    const seenIds = new Set<string>();
    const providerLabel = resolveSubAgentSidechainProviderLabel(params.flavor);

    for (const message of params.messages) {
        if (!message || message.kind !== 'tool-call') continue;
        const toolMessage = message as ToolCallMessage;
        if (!isGenericSubAgentToolName(toolMessage.tool?.name ?? '')) continue;

        const completionOnlyNativeSubagent = readCompletionOnlyNativeSubagent(toolMessage);

        const sidechainId = completionOnlyNativeSubagent
            ? null
            : resolveToolTranscriptSidechainId({
                tool: toolMessage.tool,
                normalizedToolName: toolMessage.tool.name,
            });
        if (!completionOnlyNativeSubagent && !sidechainId) continue;
        if (sidechainId && params.excludedSidechainIds?.has(sidechainId)) continue;

        const rawToolId = typeof toolMessage.tool.id === 'string' ? toolMessage.tool.id : '';
        const toolId = completionOnlyNativeSubagent
            ? (rawToolId.length > 0 ? rawToolId : '')
            : rawToolId.trim();
        const correlationId = sidechainId ?? (toolId || toolMessage.id);
        const id = `subagent_sidechain:${correlationId}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const defaultToolMessageRouteId = completionOnlyNativeSubagent
            ? buildCompletionOnlyToolRouteId(toolMessage)
            : buildToolCallMessageRouteId({
                toolId: toolId || null,
                fallbackMessageId: toolMessage.id,
            });
        const toolMessageRouteId = resolvePendingPermissionRouteForSubAgentTool({
            messages: params.messages,
            toolMessage,
        }) ?? defaultToolMessageRouteId;
        const nativeSubtitle = completionOnlyNativeSubagent
            ? readCompletionOnlySubtitle(completionOnlyNativeSubagent)
            : null;
        subagents.push({
            id,
            kind: 'subagent_sidechain',
            status: deriveSubAgentStatus(toolMessage, completionOnlyNativeSubagent),
            display: {
                title: readSubAgentDisplayTitle(toolMessage, completionOnlyNativeSubagent !== null),
                ...(nativeSubtitle ? { subtitle: nativeSubtitle } : {}),
                ...(providerLabel ? { providerLabel } : {}),
            },
            transcript: {
                ...(sidechainId ? { sidechainId } : {}),
                toolMessageRouteId: toolMessageRouteId ?? toolMessage.id,
                ...(toolId ? { toolId } : {}),
            },
            ...(completionOnlyNativeSubagent
                ? { nativeRef: deriveCompletionOnlyNativeRef(completionOnlyNativeSubagent) }
                : {}),
            recipient: null,
            capabilities: {
                canOpen: true,
                canSend: false,
                canStop: false,
                canLaunchChild: false,
                canDelete: false,
                canOpenAdvancedRun: false,
            },
            timestamps: completionOnlyNativeSubagent
                ? deriveCompletionOnlyTimestamps(toolMessage, completionOnlyNativeSubagent)
                : deriveSidechainTimestamps(toolMessage),
        });
    }

    return subagents;
}
