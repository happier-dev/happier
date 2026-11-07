import { createHash } from 'node:crypto';
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

// Native Read metadata can duplicate bytes in the tool-result image blocks.
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
    for (const value of body.message.content) {
        const block = record(value);
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const extracted = extractAcpMediaContentBlocks(block.content, {
            source: 'claude-tool-result', originSource: 'tool-output',
            toolCallId: block.tool_use_id, providerEventId: body.uuid,
        });
        media.push(...extracted.media);
        for (const diagnostic of extracted.diagnostics) {
            logger.infoFile('[claude] Tool-result media unavailable', { code: diagnostic.code });
        }
    }
    if (media.length === 0) return { body, meta };
    // The protocol envelope owns this budget; do not persist files the row cannot reference.
    if (media.length > SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1) {
        logger.infoFile('[claude] Tool-result media exceeded the transcript envelope budget', {
            droppedCount: media.length - SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1,
        });
    }
    const result = await createAgentSessionMediaPersister({
        workingDirectory: params.workingDirectory, sessionId: params.sessionId,
        accessPolicy: createSessionMediaAccessPolicy({ workingDirectory: params.workingDirectory }),
    }).persist({ type: 'session-media', source: 'claude-tool-result', media: media.slice(0, SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1) });
    const envelope = { kind: SESSION_MEDIA_MESSAGE_META_KIND_V1, payload: result };
    // Only discard a source whose bytes the media owner actually persisted.
    // Its existing content digest also distinguishes successes from partial failures.
    const persistedHashes = new Set(result.media.map(item => item.sha256));
    const data = new Set(media.flatMap(source => source.kind === 'base64'
        && persistedHashes.has(createHash('sha256').update(Buffer.from(source.data, 'base64')).digest('hex'))
        ? [source.data] : []));
    return {
        body: {
            ...body,
            message: {
                ...body.message,
                content: body.message.content.map(value => record(value)?.type === 'tool_result' ? replaceMediaBytes(value, data) : value),
            },
            ...('toolUseResult' in body ? { toolUseResult: replaceMediaBytes(body.toolUseResult, data) } : {}),
        },
        meta: { ...meta, [meta?.happier === undefined ? 'happier' : 'happierMedia']: envelope },
    };
}
