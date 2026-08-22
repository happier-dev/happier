import {
    AgentExternalSessionTranscriptRawRecordSchema,
    type AgentExternalSessionTranscriptItem,
} from '@happier-dev/plugin-sdk/sessions/external';
import { parseTimestampMs } from '@happier-dev/plugin-sdk';

import { classifyClaudeNativeTranscriptRow } from './nativeSemanticProjection.js';
import { buildClaudeJsonlProviderFactLocalId } from './providerFactIdentity.js';
import type { RawJSONLines } from './rawJsonLines.js';

export function projectClaudeJsonlLineToRawMessage(lineValue: unknown): RawJSONLines | null {
    const classification = classifyClaudeNativeTranscriptRow(lineValue);
    return classification.visibility === 'visible' ? classification.row : null;
}

function extractEnvelopeTimestampMs(value: unknown): number {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
    const candidates = [
        (value as { timestamp?: unknown }).timestamp,
        (value as { createdAt?: unknown }).createdAt,
        (value as { created_at?: unknown }).created_at,
        (value as { time?: unknown }).time,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            const ms = Date.parse(candidate);
            if (Number.isFinite(ms) && ms >= 0) return Math.trunc(ms);
        }
        if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
            return parseTimestampMs(candidate) ?? 0;
        }
    }
    return 0;
}

function stableOffsetId(prefix: string, offset: number): string {
    const padded = Math.max(0, Math.trunc(offset)).toString().padStart(12, '0');
    return `${prefix}:${padded}`;
}

function parseClaudeExternalSessionRaw(
    value: unknown,
): AgentExternalSessionTranscriptItem['raw'] | null {
    const parsedRaw = AgentExternalSessionTranscriptRawRecordSchema.safeParse(value);
    return parsedRaw.success ? parsedRaw.data : null;
}

function createClaudeAgentSemanticRaw(data: unknown): AgentExternalSessionTranscriptItem['raw'] | null {
    return parseClaudeExternalSessionRaw({
        role: 'agent',
        content: {
            type: 'acp',
            agentId: 'claude',
            data,
        },
    });
}

function createClaudeAgentMessageRaw(text: string): AgentExternalSessionTranscriptItem['raw'] | null {
    return createClaudeAgentSemanticRaw({ type: 'message', message: text });
}

function createClaudeAgentEventRaw(
    type: 'turn_failed',
    id: string,
): AgentExternalSessionTranscriptItem['raw'] | null {
    return createClaudeAgentSemanticRaw({ type, id });
}

function createClaudeUserTextRaw(text: string): AgentExternalSessionTranscriptItem['raw'] | null {
    return parseClaudeExternalSessionRaw({
        role: 'user',
        content: { type: 'text', text },
    });
}

function isRootClaudeUserFact(row: Readonly<{
    type: string;
    isSidechain?: boolean;
    isMeta?: boolean;
}>): boolean {
    return row.type === 'user' && row.isSidechain !== true && row.isMeta !== true;
}

function unsupportedContentMessage(
    source: 'content' | 'image' | 'thinking' | 'tool_result' | 'tool_use',
): string {
    return source === 'image'
        ? 'Claude emitted an unsupported image content block.'
        : 'Claude emitted an unsupported content block.';
}

function semanticItemId(params: Readonly<{
    stableId: string;
    localId: string | null;
    kind: string;
    index: number;
    preserveBaseIdentity: boolean;
}>): Readonly<{ id: string; localId: string | null }> {
    if (params.preserveBaseIdentity) {
        return { id: params.stableId, localId: params.localId };
    }
    const suffix = `${params.kind}:${params.index}`;
    return {
        id: `${params.stableId}:${suffix}`,
        localId: params.localId === null ? null : `${params.localId}:${suffix}`,
    };
}

/**
 * The one disposition every Claude JSONL reader shares. Paging, read-after,
 * and materialization all need the same three-way answer about a source row —
 * it produced transcript items, it is a ratified non-transcript record that is
 * safe to advance past, or it is unsupported and its loss must be reported —
 * so the answer is computed once here instead of being re-derived per reader.
 */
export type ClaudeJsonlLineRecordProjection =
    | Readonly<{
        disposition: 'mapped';
        items: AgentExternalSessionTranscriptItem[];
    }>
    | Readonly<{
        disposition: 'known_non_transcript' | 'unsupported';
        items: readonly [];
    }>;

export function projectClaudeJsonlLineRecord(params: Readonly<{
    fileRelPath: string;
    lineStartOffsetBytes: number;
    lineValue: unknown;
    maxItems?: number;
}>): ClaudeJsonlLineRecordProjection {
    const items = projectClaudeJsonlLineToDirectMessages(params);
    if (items.length > 0) return { disposition: 'mapped', items };
    return {
        disposition: classifyClaudeNativeTranscriptRow(params.lineValue).knownNonTranscriptRecord
            ? 'known_non_transcript'
            : 'unsupported',
        items: [],
    };
}

export function projectClaudeJsonlLineToDirectMessages(params: Readonly<{
    fileRelPath: string;
    lineStartOffsetBytes: number;
    lineValue: unknown;
    /**
     * A page can only advance after representing the complete source row. When
     * its remaining item budget cannot admit every canonical part, the caller
     * receives one explicit marker rather than a partial row.
     */
    maxItems?: number;
}>): AgentExternalSessionTranscriptItem[] {
    const createdAtMs = extractEnvelopeTimestampMs(params.lineValue);
    // File paths stay private paging state; transcript item ids are source-local and recipient-safe.
    const stableId = stableOffsetId('claude', params.lineStartOffsetBytes);

    const classification = classifyClaudeNativeTranscriptRow(params.lineValue);
    const localId = classification.row
        ? buildClaudeJsonlProviderFactLocalId(classification.row, {
            fileRelPath: params.fileRelPath,
            lineStartOffsetBytes: params.lineStartOffsetBytes,
        })
        : null;
    if (
        classification.rawType
        && classification.rawType !== 'user'
        && classification.rawType !== 'assistant'
    ) {
        return [];
    }

    if (classification.content.kind === 'opaque') return [];

    if (classification.content.kind === 'compact_summary') {
        const raw = createClaudeAgentMessageRaw(classification.content.text);
        if (!raw) return [];
        return [
            {
                id: stableId,
                localId,
                createdAtMs,
                messageRole: 'agent',
                raw,
            },
        ];
    }
    if (classification.content.kind === 'slash_command') {
        const raw = createClaudeUserTextRaw(classification.content.text);
        if (!raw) return [];
        const isSourceFact = classification.row !== null && isRootClaudeUserFact(classification.row);
        return [
            {
                id: stableId,
                localId,
                createdAtMs,
                messageRole: 'user',
                ...(isSourceFact ? { userProjection: 'source_fact' as const } : {}),
                raw,
            },
        ];
    }
    if (classification.content.kind === 'local_command_output') {
        const raw = createClaudeAgentMessageRaw(classification.content.text);
        if (!raw) return [];
        return [
            {
                id: stableId,
                localId,
                createdAtMs,
                messageRole: 'agent',
                raw,
            },
        ];
    }
    if (classification.content.kind !== 'message' || !classification.row) return [];

    if (classification.lifecycle.kind === 'assistant_api_error') {
        const raw = createClaudeAgentEventRaw('turn_failed', localId ?? stableId);
        if (!raw) return [];
        return [
            {
                id: stableId,
                localId,
                createdAtMs,
                messageRole: classification.messageRole,
                raw,
            },
        ];
    }

    const items: AgentExternalSessionTranscriptItem[] = [];
    let preservedTextIdentity = false;
    for (const [index, part] of classification.semanticParts.entries()) {
        const preserveBaseIdentity = part.kind === 'text' && !preservedTextIdentity;
        if (part.kind === 'text') preservedTextIdentity = true;
        const identity = semanticItemId({
            stableId,
            localId,
            kind: part.kind,
            index,
            preserveBaseIdentity,
        });

        if (part.kind === 'text') {
            if (
                isRootClaudeUserFact(classification.row)
                && classification.messageRole === 'user'
            ) {
                const raw = createClaudeUserTextRaw(part.text);
                if (!raw) continue;
                items.push({
                    ...identity,
                    createdAtMs,
                    messageRole: 'user',
                    userProjection: 'source_fact',
                    raw,
                });
                continue;
            }
            if (classification.messageRole !== 'agent' && classification.messageRole !== 'event') continue;
            const raw = createClaudeAgentMessageRaw(part.text);
            if (!raw) continue;
            items.push({
                ...identity,
                createdAtMs,
                messageRole: classification.messageRole,
                raw,
            });
            continue;
        }

        const data = part.kind === 'thinking'
            ? { type: 'thinking', text: part.text }
            : part.kind === 'tool_use'
                ? {
                    type: 'tool-call',
                    callId: part.callId,
                    name: part.name,
                    input: part.input,
                    id: identity.id,
                }
                : part.kind === 'tool_result'
                    ? {
                        type: 'tool-result',
                        callId: part.callId,
                        output: part.output,
                        id: identity.id,
                        ...(part.isError === undefined ? {} : { isError: part.isError }),
                    }
                    : null;
        const fallbackSource = part.kind === 'unsupported' ? part.source : 'content';
        const raw = data === null
            ? createClaudeAgentMessageRaw(unsupportedContentMessage(fallbackSource))
            : createClaudeAgentSemanticRaw(data);
        const admittedRaw = raw ?? createClaudeAgentMessageRaw(
            unsupportedContentMessage(fallbackSource),
        );
        if (!admittedRaw) continue;
        items.push({
            ...identity,
            createdAtMs,
            messageRole: 'event',
            raw: admittedRaw,
        });
    }
    const maxItems = params.maxItems === undefined
        ? null
        : Math.max(1, Math.trunc(params.maxItems));
    if (maxItems === null || items.length <= maxItems) return items;
    const raw = createClaudeAgentMessageRaw(unsupportedContentMessage('content'));
    if (!raw) return [];
    return [{
        id: stableId,
        localId,
        createdAtMs,
        messageRole: 'event',
        raw,
    }];
}
