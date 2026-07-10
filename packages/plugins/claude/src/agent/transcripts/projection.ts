import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/plugin-sdk/sessions';

import { INTERNAL_CLAUDE_EVENT_TYPES } from './internalEventTypes.js';
import { parseRawJsonLinesObject } from './parseRawJsonLines.js';
import { normalizeClaudeToolUseNamesInRawJsonLines } from './toolUseNames.js';
import type { RawJSONLines } from './rawJsonLines.js';
import {
    isClaudeInternalTranscriptMessage,
    readClaudeVisibleCompactSummaryText,
    readClaudeVisibleLocalCommandOutputText,
    readClaudeVisibleSlashCommandText,
} from './visibility.js';

function parseJsonlLineValue(value: unknown): unknown | null {
    if (!value) return null;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        try {
            return JSON.parse(trimmed) as unknown;
        } catch {
            return null;
        }
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    return null;
}

export function projectClaudeJsonlLineToRawMessage(lineValue: unknown): RawJSONLines | null {
    const rawObject = parseJsonlLineValue(lineValue);
    if (!rawObject || typeof rawObject !== 'object' || Array.isArray(rawObject)) {
        return null;
    }

    const rawType = (rawObject as { type?: unknown }).type;
    if (typeof rawType === 'string' && INTERNAL_CLAUDE_EVENT_TYPES.has(rawType)) {
        return null;
    }

    const parsed = parseRawJsonLinesObject(rawObject);
    if (!parsed) return null;
    const normalized = normalizeClaudeToolUseNamesInRawJsonLines(parsed);
    return isClaudeInternalTranscriptMessage(normalized) ? null : normalized;
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
            const num = Math.trunc(candidate);
            return num < 1_000_000_000_000 ? num * 1000 : num;
        }
    }
    return 0;
}

function stableOffsetId(prefix: string, offset: number): string {
    const padded = Math.max(0, Math.trunc(offset)).toString().padStart(12, '0');
    return `${prefix}:${padded}`;
}

function ensureClaudeOutputMessageRole(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const typedValue = value as Record<string, unknown>;
    if (typedValue.type !== 'assistant' && typedValue.type !== 'user') return value;
    const message = typedValue.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return value;
    const typedMessage = message as Record<string, unknown>;
    if (typeof typedMessage.role === 'string' && typedMessage.role.trim().length > 0) {
        return value;
    }
    return {
        ...typedValue,
        message: {
            ...typedMessage,
            role: typedValue.type,
        },
    };
}

export function projectClaudeJsonlLineToDirectMessages(params: Readonly<{
    fileRelPath: string;
    lineStartOffsetBytes: number;
    lineValue: unknown;
}>): ExternalSessionTranscriptRawMessageV1[] {
    const createdAtMs = extractEnvelopeTimestampMs(params.lineValue);
    const idPrefix = `claude:${params.fileRelPath}`;
    const stableId = stableOffsetId(idPrefix, params.lineStartOffsetBytes);

    const rawObject = parseJsonlLineValue(params.lineValue);
    const rawType = (() => {
        if (!rawObject || typeof rawObject !== 'object' || Array.isArray(rawObject)) return null;
        const tag = (rawObject as { type?: unknown }).type;
        return typeof tag === 'string' ? tag : null;
    })();

    if (rawType && rawType !== 'user' && rawType !== 'assistant') {
        return [];
    }

    const parsed = parseRawJsonLinesObject(rawObject);
    if (!parsed) {
        return [
            {
                id: stableId,
                localId: stableId,
                createdAtMs,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'opaque',
                            reason: 'schema_mismatch',
                            source: {
                                fileRelPath: params.fileRelPath,
                                lineStartOffsetBytes: params.lineStartOffsetBytes,
                            },
                            original: rawObject ?? params.lineValue,
                        },
                    },
                },
            },
        ];
    }

    const normalized = normalizeClaudeToolUseNamesInRawJsonLines(parsed);
    const compactSummary = readClaudeVisibleCompactSummaryText(normalized);
    if (compactSummary) {
        return [
            {
                id: stableId,
                localId: stableId,
                createdAtMs,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'claude_compact_summary',
                            text: compactSummary,
                        },
                    },
                },
            },
        ];
    }
    const slashCommand = readClaudeVisibleSlashCommandText(normalized);
    if (slashCommand) {
        return [
            {
                id: stableId,
                localId: stableId,
                createdAtMs,
                raw: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: slashCommand,
                    },
                },
            },
        ];
    }
    const localCommandOutput = readClaudeVisibleLocalCommandOutputText(normalized);
    if (localCommandOutput) {
        return [
            {
                id: stableId,
                localId: stableId,
                createdAtMs,
                raw: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'claude_local_command_output',
                            text: localCommandOutput,
                        },
                    },
                },
            },
        ];
    }
    if (isClaudeInternalTranscriptMessage(normalized)) return [];
    const normalizedForOutput = ensureClaudeOutputMessageRole(normalized);

    if (
        normalized.type === 'user' &&
        typeof (normalized as { message?: { content?: unknown } }).message?.content === 'string' &&
        (normalized as { isSidechain?: unknown }).isSidechain !== true &&
        (normalized as { isMeta?: unknown }).isMeta !== true
    ) {
        return [
            {
                id: stableId,
                localId: stableId,
                createdAtMs,
                raw: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: String((normalized as { message: { content: string } }).message.content),
                    },
                },
            },
        ];
    }

    return [
        {
            id: stableId,
            localId: stableId,
            createdAtMs,
            raw: {
                role: 'agent',
                content: { type: 'output', data: normalizedForOutput },
            },
        },
    ];
}
