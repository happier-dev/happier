import { logger } from '@/ui/logger';

import { extractAcpMediaContentBlocks } from '../media/extractAcpMediaContentBlocks';
import { extractTextFromContentBlock } from './content';
import { DEFAULT_IDLE_TIMEOUT_MS, type HandlerContext, type HandlerResult, type SessionUpdate } from './types';
import { resolvePostToolCallIdleTimeoutMs } from '../timeouts/acpBackendTimeouts';

let acpMessageMediaSequence = 0;

function nextAcpMessageMediaId(): string {
  acpMessageMediaSequence += 1;
  return `acp-media-message-${acpMessageMediaSequence}`;
}

function extractTextFromMessageContent(content: unknown): string | null {
  const direct = extractTextFromContentBlock(content);
  if (direct !== null) return direct;

  const items =
    Array.isArray(content)
      ? content
      : (content && typeof content === 'object' && !Array.isArray(content) && Array.isArray((content as { content?: unknown }).content)
        ? (content as { content: unknown[] }).content
        : null);
  if (!items) return null;

  const parts: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const text = extractTextFromContentBlock(item);
    if (typeof text === 'string') parts.push(text);
  }
  return parts.length > 0 ? parts.join('') : null;
}

function extractSessionMediaFromMessageContent(update: SessionUpdate): ReturnType<typeof extractAcpMediaContentBlocks> {
  const providerEventId = typeof update.id === 'string' ? update.id : nextAcpMessageMediaId();
  return extractAcpMediaContentBlocks(update.content, {
    originSource: 'acp-content',
    providerEventId,
  });
}

function emitSessionMediaExtractionResult(
  result: ReturnType<typeof extractAcpMediaContentBlocks>,
  ctx: HandlerContext,
  options?: Readonly<{
    localId?: string;
    messageText?: string;
  }>,
): boolean {
  if (result.media.length > 0) {
    ctx.emit({
      type: 'event',
      name: 'session_media',
      payload: {
        localId: options?.localId ?? nextAcpMessageMediaId(),
        role: 'output',
        category: 'generated',
        ...(typeof options?.messageText === 'string' ? { messageText: options.messageText } : {}),
        media: result.media,
      },
    });
  }
  if (result.diagnostics.length > 0) {
    ctx.emit({
      type: 'event',
      name: 'session_media_diagnostics',
      payload: { diagnostics: result.diagnostics },
    });
  }
  return result.media.length > 0 || result.diagnostics.length > 0;
}

function refreshMessageIdleTimeout(ctx: HandlerContext): void {
  ctx.clearIdleTimeout();

  const idleTimeoutMs =
    (ctx.toolCallCountSincePrompt === 0
      ? ctx.transport.getPreToolCallIdleTimeoutMs?.()
      : null) ??
    (ctx.toolCallCountSincePrompt > 0 && ctx.activeToolCalls.size === 0
      ? resolvePostToolCallIdleTimeoutMs(ctx.transport)
      : null) ??
    ctx.transport.getIdleTimeout?.() ??
    DEFAULT_IDLE_TIMEOUT_MS;
  ctx.setIdleTimeout(() => {
    if (ctx.activeToolCalls.size === 0) {
      logger.debug('[AcpBackend] No more chunks received, emitting idle status');
      ctx.emitIdleStatus();
    } else {
      logger.debug(`[AcpBackend] Delaying idle status - ${ctx.activeToolCalls.size} active tool calls`);
    }
  }, idleTimeoutMs);
}

/**
 * Handle agent_message_chunk update (text output from model).
 */
export function handleAgentMessageChunk(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const text = extractTextFromMessageContent(update.content);
  const mediaResult = extractSessionMediaFromMessageContent(update);
  const mediaHandled = mediaResult.media.length > 0 || mediaResult.diagnostics.length > 0;
  if (typeof text !== 'string' || text.length === 0) {
    if (mediaHandled) emitSessionMediaExtractionResult(mediaResult, ctx);
    return { handled: mediaHandled };
  }
  // Preserve media-only transcript rows without treating their whitespace label as visible text.
  if (!text.trim() && mediaHandled) {
    if (mediaHandled) emitSessionMediaExtractionResult(mediaResult, ctx);
    return { handled: true };
  }

  logger.debug(`[AcpBackend] Received message chunk (length: ${text.length})`);
  if (mediaResult.media.length > 0) {
    const localId = typeof update.id === 'string' ? update.id : undefined;
    emitSessionMediaExtractionResult(mediaResult, ctx, {
      ...(localId ? { localId } : {}),
      messageText: text,
    });
    refreshMessageIdleTimeout(ctx);
    return { handled: true };
  }

  ctx.emit({
    type: 'model-output',
    textDelta: text,
  });
  emitSessionMediaExtractionResult(mediaResult, ctx);

  // Reset idle timeout - more chunks are coming.
  refreshMessageIdleTimeout(ctx);

  return { handled: true };
}

/**
 * Handle agent_thought_chunk update (Gemini's thinking/reasoning).
 */
export function handleAgentThoughtChunk(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const text = extractTextFromContentBlock(update.content);
  if (typeof text !== 'string' || text.length === 0) return { handled: false };
  if (!text.trim()) return { handled: true };

  // Log thinking chunks when tool calls are active.
  if (ctx.activeToolCalls.size > 0) {
    const activeToolCallsList = Array.from(ctx.activeToolCalls);
    logger.debug(
      `[AcpBackend] 💭 Thinking chunk received (${text.length} chars) during active tool calls: ${activeToolCallsList.join(', ')}`,
    );
  }

  ctx.emit({
    type: 'event',
    name: 'thinking',
    payload: { text },
  });

  refreshMessageIdleTimeout(ctx);

  return { handled: true };
}

export function handleUserMessageChunk(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const text = extractTextFromContentBlock(update.content);
  if (typeof text !== 'string' || text.length === 0) return { handled: false };
  ctx.emit({
    type: 'event',
    name: 'user_message_chunk',
    payload: { text },
  });
  return { handled: true };
}

/**
 * Handle legacy messageChunk format.
 */
export function handleLegacyMessageChunk(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  if (!update.messageChunk) {
    return { handled: false };
  }

  const chunk = update.messageChunk;
  if (chunk.textDelta) {
    ctx.emit({
      type: 'model-output',
      textDelta: chunk.textDelta,
    });
    return { handled: true };
  }

  return { handled: false };
}
