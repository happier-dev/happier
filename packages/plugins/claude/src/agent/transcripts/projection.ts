import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/plugin-sdk/experimental/sessions';

import { classifyClaudeNativeTranscriptRow } from './nativeSemanticProjection.js';
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

    const classification = classifyClaudeNativeTranscriptRow(params.lineValue);
    if (
        classification.rawType
        && classification.rawType !== 'user'
        && classification.rawType !== 'assistant'
    ) {
        return [];
    }

    if (classification.content.kind === 'opaque') {
        return [
            {
                id: stableId,
                localId: stableId,
                createdAtMs,
                messageRole: classification.messageRole,
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
                            original: classification.content.original,
                        },
                    },
                },
            },
        ];
    }

    if (classification.content.kind === 'compact_summary') {
        return [
            {
                id: stableId,
                localId: stableId,
                createdAtMs,
                messageRole: 'agent',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'claude_compact_summary',
                            text: classification.content.text,
                        },
                    },
                },
            },
        ];
    }
    if (classification.content.kind === 'slash_command') {
        return [
            {
                id: stableId,
                localId: stableId,
                createdAtMs,
                messageRole: 'user',
                raw: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: classification.content.text,
                    },
                },
            },
        ];
    }
    if (classification.content.kind === 'local_command_output') {
        return [
            {
                id: stableId,
                localId: stableId,
                createdAtMs,
                messageRole: 'agent',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'claude_local_command_output',
                            text: classification.content.text,
                        },
                    },
                },
            },
        ];
    }
    if (classification.content.kind !== 'message' || !classification.row) return [];
    const normalized = classification.row;
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
                messageRole: classification.messageRole,
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
            messageRole: classification.messageRole,
            raw: {
                role: 'agent',
                content: { type: 'output', data: normalizedForOutput },
            },
        },
    ];
}
