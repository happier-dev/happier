import type { RawJSONLines } from '../types';
import { extractAcpMediaContentBlocks } from '@/agent/acp/media/extractAcpMediaContentBlocks';
import type { SessionMediaSource } from '@/agent/core';
import { createAgentSessionMediaPersister } from '@/session/sessionMedia/createAgentSessionMediaPersister';
import { createSessionMediaAccessPolicy } from '@/session/sessionMedia/createSessionMediaAccessPolicy';
import { SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1, SESSION_MEDIA_MESSAGE_META_KIND_V1 } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
}

// Provider payloads are JSON. Image payloads stay out of the transcript even when
// extraction rejects their encoding. Native Read metadata can duplicate those bytes.
function replaceMediaBytes(value: unknown, data: ReadonlySet<string>): unknown {
    if (typeof value === 'string') return data.has(value.trim()) ? '[session media]' : value;
    if (Array.isArray(value)) return value.map(item => replaceMediaBytes(item, data));
    const object = record(value);
    return object ? Object.fromEntries(Object.entries(object).map(([key, item]) => [key, replaceMediaBytes(item, data)])) : value;
}

export async function persistClaudeToolResultMedia(params: Readonly<{
    body: RawJSONLines;
    meta?: Record<string, unknown>;
    workingDirectory: string;
    sessionId: string;
}>): Promise<Readonly<{ body: RawJSONLines; meta?: Record<string, unknown> }>> {
    const { body, meta } = params;
    if (body.type !== 'user' || !Array.isArray(body.message.content)) return { body, meta };
    const media: SessionMediaSource[] = [];
    const data = new Set<string>();
    for (const value of body.message.content) {
        const block = record(value);
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const extracted = extractAcpMediaContentBlocks(block.content, {
            source: 'claude-tool-result', originSource: 'tool-output',
            toolCallId: block.tool_use_id, providerEventId: body.uuid,
        });
        media.push(...extracted.media);
        for (const payload of extracted.inlineData) data.add(payload);
        for (const diagnostic of extracted.diagnostics) {
            logger.infoFile('[claude] Tool-result media unavailable', { code: diagnostic.code });
        }
    }
    if (media.length === 0 && data.size === 0) return { body, meta };
    // The protocol envelope owns this budget; do not persist files the row cannot reference.
    if (media.length > SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1) {
        logger.infoFile('[claude] Tool-result media exceeded the transcript envelope budget', {
            droppedCount: media.length - SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1,
        });
    }
    const result = media.length > 0 ? await createAgentSessionMediaPersister({
        workingDirectory: params.workingDirectory, sessionId: params.sessionId,
        accessPolicy: createSessionMediaAccessPolicy({ workingDirectory: params.workingDirectory }),
    }).persist({ type: 'session-media', source: 'claude-tool-result', media: media.slice(0, SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1) }) : null;
    const envelope = result ? { kind: SESSION_MEDIA_MESSAGE_META_KIND_V1, payload: result } : null;
    return {
        body: {
            ...body,
            message: {
                ...body.message,
                content: body.message.content.map(value => record(value)?.type === 'tool_result' ? replaceMediaBytes(value, data) : value),
            },
            ...('toolUseResult' in body ? { toolUseResult: replaceMediaBytes(body.toolUseResult, data) } : {}),
        },
        meta: envelope ? { ...meta, [meta?.happier === undefined ? 'happier' : 'happierMedia']: envelope } : meta,
    };
}
