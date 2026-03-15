import type { HandlerContext, HandlerResult, SessionUpdate } from './types';

function extractThinkingText(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return payload.trim().length > 0 ? payload : null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const textCandidate = record.text ?? record.message ?? record.content;
  if (typeof textCandidate !== 'string') return null;
  return textCandidate.trim().length > 0 ? textCandidate : null;
}

export function handleAvailableCommandsUpdate(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const commands = Array.isArray(update.availableCommands) ? update.availableCommands : null;
  if (!commands) return { handled: false };
  ctx.emit({
    type: 'event',
    name: 'available_commands_update',
    payload: { availableCommands: commands },
  });
  return { handled: true };
}

export function handleCurrentModeUpdate(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const modeId = typeof update.currentModeId === 'string' ? update.currentModeId : null;
  if (!modeId) return { handled: false };
  ctx.emit({
    type: 'event',
    name: 'current_mode_update',
    payload: { currentModeId: modeId },
  });
  return { handled: true };
}

/**
 * Handle plan update.
 */
export function handlePlanUpdate(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  if (update.sessionUpdate === 'plan' && update.entries !== undefined) {
    ctx.emit({
      type: 'event',
      name: 'plan',
      payload: { entries: update.entries },
    });
    return { handled: true };
  }

  if (update.plan !== undefined) {
    ctx.emit({
      type: 'event',
      name: 'plan',
      payload: update.plan,
    });
    return { handled: true };
  }

  return { handled: false };
}

/**
 * Handle explicit thinking field.
 */
export function handleThinkingUpdate(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const text = extractThinkingText(update.thinking);
  if (!text) {
    return { handled: false };
  }

  ctx.emit({
    type: 'event',
    name: 'thinking',
    payload: { text },
  });

  return { handled: true };
}
