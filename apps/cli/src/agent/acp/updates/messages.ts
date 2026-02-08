import { logger } from '@/ui/logger';

import { extractTextFromContentBlock } from './content';
import { DEFAULT_IDLE_TIMEOUT_MS, type HandlerContext, type HandlerResult, type SessionUpdate } from './types';

/**
 * Handle agent_message_chunk update (text output from model).
 */
export function handleAgentMessageChunk(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const text = extractTextFromContentBlock(update.content);
  if (typeof text !== 'string' || text.length === 0) return { handled: false };
  // Some ACP providers emit whitespace-only chunks (often "\n") as keepalives.
  // Dropping these avoids spammy blank lines and reduces unnecessary UI churn.
  if (!text.trim()) return { handled: true };

  // Filter out "thinking" messages (start with **...**)
  const isThinking = /^\*\*[^*]+\*\*\n/.test(text);

  if (isThinking) {
    ctx.emit({
      type: 'event',
      name: 'thinking',
      payload: { text },
    });
  } else {
    logger.debug(`[AcpBackend] Received message chunk (length: ${text.length}): ${text.substring(0, 50)}...`);
    ctx.emit({
      type: 'model-output',
      textDelta: text,
    });

    // Reset idle timeout - more chunks are coming.
    ctx.clearIdleTimeout();

    // Set timeout to emit 'idle' after a short delay when no more chunks arrive.
    const idleTimeoutMs = ctx.transport.getIdleTimeout?.() ?? DEFAULT_IDLE_TIMEOUT_MS;
    ctx.setIdleTimeout(() => {
      if (ctx.activeToolCalls.size === 0) {
        logger.debug('[AcpBackend] No more chunks received, emitting idle status');
        ctx.emitIdleStatus();
      } else {
        logger.debug(`[AcpBackend] Delaying idle status - ${ctx.activeToolCalls.size} active tool calls`);
      }
    }, idleTimeoutMs);
  }

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
