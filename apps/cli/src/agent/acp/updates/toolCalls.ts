import { logger } from '@/ui/logger';

import {
  asRecord,
  attachAcpMetadataToArgs,
  extractErrorDetail,
  extractMeta,
  extractToolInput,
  extractToolOutput,
  hasMeaningfulToolUpdate,
  parseArgsFromContent,
} from './content';
import {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  type HandlerContext,
  type HandlerResult,
  type SessionUpdate,
} from './types';

/**
 * Format duration for logging.
 */
export function formatDuration(startTime: number | undefined): string {
  if (!startTime) return 'unknown';
  const duration = Date.now() - startTime;
  return `${(duration / 1000).toFixed(2)}s`;
}

/**
 * Format duration in minutes for logging.
 */
export function formatDurationMinutes(startTime: number | undefined): string {
  if (!startTime) return 'unknown';
  const duration = Date.now() - startTime;
  return (duration / 1000 / 60).toFixed(2);
}

function extractTextFromContentBlocks(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const record = asRecord(item);
    if (!record) return null;

    if (typeof record.text === 'string') {
      parts.push(record.text);
      continue;
    }

    const nested = asRecord(record.content);
    if (nested && typeof nested.text === 'string') {
      parts.push(nested.text);
      continue;
    }

    return null;
  }

  return parts.length > 0 ? parts.join('') : null;
}

function inferToolKindFromUpdate(update: SessionUpdate): string | null {
  // Some ACP providers omit kind and embed a formatted command result payload in rawInput/input.
  // Heuristic: the well-known wrapper includes Command/Exit Code lines.
  const rawInput = extractToolInput(update);
  const text = extractTextFromContentBlocks(rawInput);
  if (!text) return null;

  const hasCommand = /^Command:\s*\S+/m.test(text);
  const hasExitCode = /\bExit Code:\s*\d+/m.test(text);
  if (hasCommand && hasExitCode) return 'execute';

  return null;
}

function buildToolNameInferenceInput(rawInputRecord: Record<string, unknown> | null, update: SessionUpdate): Record<string, unknown> {
  const title = typeof update.title === 'string' ? update.title.trim() : '';
  if (!title) return rawInputRecord ?? {};

  if (!rawInputRecord) {
    return { title, description: title, _acp: { title } };
  }

  const next: Record<string, unknown> = { ...rawInputRecord };
  const currentTitle = typeof next.title === 'string' ? next.title.trim() : '';
  if (!currentTitle) {
    next.title = title;
  }
  const currentDescription = typeof next.description === 'string' ? next.description.trim() : '';
  if (!currentDescription) {
    next.description = title;
  }

  const acp = asRecord(next._acp) ?? {};
  const acpTitle = typeof acp.title === 'string' ? acp.title.trim() : '';
  if (!acpTitle) {
    next._acp = { ...acp, title };
  }

  return next;
}

function emitTerminalOutputFromMeta(update: SessionUpdate, ctx: HandlerContext): void {
  const meta = extractMeta(update);
  if (!meta) return;
  const entry = meta.terminal_output;
  const obj = asRecord(entry);
  if (!obj) return;
  const data = typeof obj.data === 'string' ? obj.data : null;
  if (!data) return;
  const toolCallId = update.toolCallId;
  if (!toolCallId) return;
  const toolKindStr = typeof update.kind === 'string' ? update.kind : undefined;
  const toolName =
    ctx.toolCallIdToNameMap.get(toolCallId) ??
    ctx.transport.extractToolNameFromId?.(toolCallId) ??
    toolKindStr ??
    'unknown';

  // Represent terminal output as a streaming tool-result update for the same toolCallId.
  // The UI reducer can append stdout/stderr without marking the tool as completed.
  ctx.emit({
    type: 'tool-result',
    toolName,
    callId: toolCallId,
    result: {
      stdoutChunk: data,
      _stream: true,
      _terminal: true,
    },
  });
}

function emitToolCallRefresh(
  toolCallId: string,
  toolKind: string | unknown,
  update: SessionUpdate,
  ctx: HandlerContext,
): void {
  const toolKindStr = typeof toolKind === 'string' ? toolKind : undefined;

  const rawInput = extractToolInput(update);
  const cachedInput = ctx.toolCallIdToInputMap.get(toolCallId) ?? null;
  const rawInputRecord = asRecord(rawInput);

  const cachedRecord = asRecord(cachedInput);
  const toolNameInferenceInput = buildToolNameInferenceInput(rawInputRecord ?? cachedRecord, update);
  if (Object.keys(toolNameInferenceInput).length > 0) {
    ctx.toolCallIdToInputMap.set(toolCallId, toolNameInferenceInput);
  }

  const baseName =
    ctx.toolCallIdToNameMap.get(toolCallId) ??
    ctx.transport.extractToolNameFromId?.(toolCallId) ??
    toolKindStr ??
    'unknown';
  const realToolName =
    ctx.transport.determineToolName?.(baseName, toolCallId, toolNameInferenceInput, {
      recentPromptHadChangeTitle: false,
      toolCallCountSincePrompt: ctx.toolCallCountSincePrompt,
  }) ?? baseName;

  const effectiveRawInput =
    rawInputRecord && Object.keys(rawInputRecord).length > 0
      ? rawInput
      : (cachedRecord && Object.keys(cachedRecord).length > 0 ? cachedRecord : rawInput);

  const parsedArgs = parseArgsFromContent(effectiveRawInput);
  const args = { ...parsedArgs };

  if (update.locations && Array.isArray(update.locations)) {
    args.locations = update.locations;
  }
  attachAcpMetadataToArgs(args, update, toolKindStr || 'unknown', effectiveRawInput);

  ctx.emit({
    type: 'tool-call',
    toolName: realToolName,
    args,
    callId: toolCallId,
  });
}

/**
 * Start tracking a new tool call.
 */
export function startToolCall(
  toolCallId: string,
  toolKind: string | unknown,
  update: SessionUpdate,
  ctx: HandlerContext,
  source: 'tool_call' | 'tool_call_update',
): void {
  const startTime = Date.now();
  const toolKindStr = typeof toolKind === 'string' ? toolKind : undefined;
  const isInvestigation = ctx.transport.isInvestigationTool?.(toolCallId, toolKindStr) ?? false;

  const rawInput = extractToolInput(update);
  const cachedInput = ctx.toolCallIdToInputMap.get(toolCallId) ?? null;
  const rawInputRecord = asRecord(rawInput);
  const cachedRecord = asRecord(cachedInput);
  const toolNameInferenceInput = buildToolNameInferenceInput(rawInputRecord ?? cachedRecord, update);
  if (Object.keys(toolNameInferenceInput).length > 0) {
    ctx.toolCallIdToInputMap.set(toolCallId, toolNameInferenceInput);
  }

  // Determine a stable tool name (never use `update.title`, which is human-readable and can vary per call).
  const seededName = ctx.toolCallIdToNameMap.get(toolCallId);
  const extractedName = ctx.transport.extractToolNameFromId?.(toolCallId);
  const baseName = seededName ?? extractedName ?? toolKindStr ?? 'unknown';
  const toolName =
    ctx.transport.determineToolName?.(baseName, toolCallId, toolNameInferenceInput, {
      recentPromptHadChangeTitle: false,
      toolCallCountSincePrompt: ctx.toolCallCountSincePrompt,
    }) ?? baseName;

  // Store mapping for permission requests.
  ctx.toolCallIdToNameMap.set(toolCallId, toolName);

  ctx.activeToolCalls.add(toolCallId);
  ctx.toolCallStartTimes.set(toolCallId, startTime);

  logger.debug(
    `[AcpBackend] ⏱️ Set startTime for ${toolCallId} at ${new Date(startTime).toISOString()} (from ${source})`,
  );
  logger.debug(
    `[AcpBackend] 🔧 Tool call START: ${toolCallId} (${toolKind} -> ${toolName})${isInvestigation ? ' [INVESTIGATION TOOL]' : ''}`,
  );

  if (isInvestigation) {
    logger.debug('[AcpBackend] 🔍 Investigation tool detected - extended timeout (10min) will be used');
  }

  // Set timeout for tool call completion.
  // Some ACP providers send `status: pending` while waiting for a user permission response. Do not start
  // the execution timeout until the tool is actually in progress, otherwise long permission waits can
  // cause spurious timeouts and confusing UI state.
  if (update.status !== 'pending') {
    const timeoutMs =
      ctx.transport.getToolCallTimeout?.(toolCallId, toolKindStr) ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;

    if (!ctx.toolCallTimeouts.has(toolCallId)) {
      const timeout = setTimeout(() => {
        const duration = formatDuration(ctx.toolCallStartTimes.get(toolCallId));
        logger.debug(
          `[AcpBackend] ⏱️ Tool call TIMEOUT (from ${source}): ${toolCallId} (${toolKind}) after ${(timeoutMs / 1000).toFixed(0)}s - Duration: ${duration}, removing from active set`,
        );

        ctx.activeToolCalls.delete(toolCallId);
        ctx.toolCallStartTimes.delete(toolCallId);
        ctx.toolCallTimeouts.delete(toolCallId);
        ctx.toolCallIdToNameMap.delete(toolCallId);
        ctx.toolCallIdToInputMap.delete(toolCallId);

        if (ctx.activeToolCalls.size === 0) {
          logger.debug('[AcpBackend] No more active tool calls after timeout, emitting idle status');
          ctx.emitIdleStatus();
        }
      }, timeoutMs);

      ctx.toolCallTimeouts.set(toolCallId, timeout);
      logger.debug(
        `[AcpBackend] ⏱️ Set timeout for ${toolCallId}: ${(timeoutMs / 1000).toFixed(0)}s${isInvestigation ? ' (investigation tool)' : ''}`,
      );
    } else {
      logger.debug(`[AcpBackend] Timeout already set for ${toolCallId}, skipping`);
    }
  } else {
    logger.debug(
      `[AcpBackend] Tool call ${toolCallId} is pending permission; skipping execution timeout setup`,
    );
  }

  // Clear idle timeout - tool call is starting.
  ctx.clearIdleTimeout();

  // Emit running status.
  ctx.emit({ type: 'status', status: 'running' });

  // Parse args and emit tool-call event.
  const effectiveRawInput =
    rawInputRecord && Object.keys(rawInputRecord).length > 0
      ? rawInput
      : (cachedRecord && Object.keys(cachedRecord).length > 0 ? cachedRecord : rawInput);

  const parsedArgs = parseArgsFromContent(effectiveRawInput);
  const args = { ...parsedArgs };

  // Extract locations if present.
  if (update.locations && Array.isArray(update.locations)) {
    args.locations = update.locations;
  }

  attachAcpMetadataToArgs(args, update, toolKindStr || 'unknown', effectiveRawInput);

  // Log investigation tool objective.
  if (isInvestigation && args.objective) {
    logger.debug(`[AcpBackend] 🔍 Investigation tool objective: ${String(args.objective).substring(0, 100)}...`);
  }

  ctx.emit({
    type: 'tool-call',
    toolName,
    args,
    callId: toolCallId,
  });
}

/**
 * Complete a tool call successfully.
 */
export function completeToolCall(
  toolCallId: string,
  toolKind: string | unknown,
  update: SessionUpdate,
  ctx: HandlerContext,
): void {
  const startTime = ctx.toolCallStartTimes.get(toolCallId);
  const duration = formatDuration(startTime);
  const toolKindStr = typeof toolKind === 'string' ? toolKind : 'unknown';
  const resolvedToolName = ctx.toolCallIdToNameMap.get(toolCallId) ?? toolKindStr;

  ctx.activeToolCalls.delete(toolCallId);
  ctx.toolCallStartTimes.delete(toolCallId);
  ctx.toolCallIdToNameMap.delete(toolCallId);
  ctx.toolCallIdToInputMap.delete(toolCallId);

  const timeout = ctx.toolCallTimeouts.get(toolCallId);
  if (timeout) {
    clearTimeout(timeout);
    ctx.toolCallTimeouts.delete(toolCallId);
  }

  logger.debug(
    `[AcpBackend] ✅ Tool call COMPLETED: ${toolCallId} (${resolvedToolName}) - Duration: ${duration}. Active tool calls: ${ctx.activeToolCalls.size}`,
  );

  const output = extractToolOutput(update);
  const record = asRecord(output);
  if (record) {
    const meta = extractMeta(update);
    const acp: Record<string, unknown> = { kind: toolKindStr };
    if (typeof update.title === 'string' && update.title.trim().length > 0) acp.title = update.title;
    if (Array.isArray(update.locations) && update.locations.length > 0) acp.locations = update.locations;
    if (meta) acp.meta = meta;
    record._acp = { ...(asRecord(record._acp) ?? {}), ...acp };
  }

  ctx.emit({
    type: 'tool-result',
    toolName: resolvedToolName,
    result: output,
    callId: toolCallId,
  });

  // If no more active tool calls, emit idle.
  if (ctx.activeToolCalls.size === 0) {
    ctx.clearIdleTimeout();
    logger.debug('[AcpBackend] All tool calls completed, emitting idle status');
    ctx.emitIdleStatus();
  }
}

/**
 * Fail a tool call.
 */
export function failToolCall(
  toolCallId: string,
  status: 'failed' | 'cancelled',
  toolKind: string | unknown,
  update: SessionUpdate,
  ctx: HandlerContext,
): void {
  const startTime = ctx.toolCallStartTimes.get(toolCallId);
  const duration = startTime ? Date.now() - startTime : null;
  const toolKindStr = typeof toolKind === 'string' ? toolKind : 'unknown';
  const resolvedToolName = ctx.toolCallIdToNameMap.get(toolCallId) ?? toolKindStr;
  const isInvestigation = ctx.transport.isInvestigationTool?.(toolCallId, toolKindStr) ?? false;
  const hadTimeout = ctx.toolCallTimeouts.has(toolCallId);

  // Log detailed timing for investigation tools BEFORE cleanup.
  if (isInvestigation) {
    const durationStr = formatDuration(startTime);
    const durationMinutes = formatDurationMinutes(startTime);
    logger.debug(
      `[AcpBackend] 🔍 Investigation tool ${status.toUpperCase()} after ${durationMinutes} minutes (${durationStr})`,
    );

    // Check for 3-minute timeout pattern (Gemini CLI internal timeout).
    if (duration) {
      const threeMinutes = 3 * 60 * 1000;
      const tolerance = 5000;
      if (Math.abs(duration - threeMinutes) < tolerance) {
        logger.debug(
          '[AcpBackend] 🔍 ⚠️ Investigation tool failed at ~3 minutes - likely Gemini CLI timeout, not our timeout',
        );
      }
    }

    logger.debug(
      '[AcpBackend] 🔍 Investigation tool FAILED - full content:',
      JSON.stringify(extractToolOutput(update), null, 2),
    );
    logger.debug(
      `[AcpBackend] 🔍 Investigation tool timeout status BEFORE cleanup: ${hadTimeout ? 'timeout was set' : 'no timeout was set'}`,
    );
    logger.debug(
      `[AcpBackend] 🔍 Investigation tool startTime status BEFORE cleanup: ${startTime ? `set at ${new Date(startTime).toISOString()}` : 'not set'}`,
    );
  }

  // Cleanup.
  ctx.activeToolCalls.delete(toolCallId);
  ctx.toolCallStartTimes.delete(toolCallId);
  ctx.toolCallIdToNameMap.delete(toolCallId);
  ctx.toolCallIdToInputMap.delete(toolCallId);

  const timeout = ctx.toolCallTimeouts.get(toolCallId);
  if (timeout) {
    clearTimeout(timeout);
    ctx.toolCallTimeouts.delete(toolCallId);
    logger.debug(`[AcpBackend] Cleared timeout for ${toolCallId} (tool call ${status})`);
  } else {
    logger.debug(
      `[AcpBackend] No timeout found for ${toolCallId} (tool call ${status}) - timeout may not have been set`,
    );
  }

  const durationStr = formatDuration(startTime);
  logger.debug(
    `[AcpBackend] ❌ Tool call ${status.toUpperCase()}: ${toolCallId} (${resolvedToolName}) - Duration: ${durationStr}. Active tool calls: ${ctx.activeToolCalls.size}`,
  );

  // Extract error detail.
  const errorDetail = extractErrorDetail(extractToolOutput(update));
  if (errorDetail) {
    logger.debug(`[AcpBackend] ❌ Tool call error details: ${errorDetail.substring(0, 500)}`);
  } else {
    logger.debug(`[AcpBackend] ❌ Tool call ${status} but no error details in content`);
  }

  // Emit tool-result with error.
  ctx.emit({
    type: 'tool-result',
    toolName: resolvedToolName,
    result: (() => {
      const base = errorDetail ? { error: errorDetail, status } : { error: `Tool call ${status}`, status };
      const meta = extractMeta(update);
      const acp: Record<string, unknown> = { kind: toolKindStr };
      if (typeof update.title === 'string' && update.title.trim().length > 0) acp.title = update.title;
      if (Array.isArray(update.locations) && update.locations.length > 0) acp.locations = update.locations;
      if (meta) acp.meta = meta;
      return { ...base, _acp: acp };
    })(),
    callId: toolCallId,
  });

  // If no more active tool calls, emit idle.
  if (ctx.activeToolCalls.size === 0) {
    ctx.clearIdleTimeout();
    logger.debug('[AcpBackend] All tool calls completed/failed, emitting idle status');
    ctx.emitIdleStatus();
  }
}

/**
 * Handle tool_call_update session update.
 */
export function handleToolCallUpdate(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const status = update.status;
  const toolCallId = update.toolCallId;

  if (!toolCallId) {
    logger.debug('[AcpBackend] Tool call update without toolCallId:', update);
    return { handled: false };
  }

  const inferredToolKind = inferToolKindFromUpdate(update);
  const toolKind =
    typeof update.kind === 'string'
      ? update.kind
      : (ctx.transport.extractToolNameFromId?.(toolCallId) ?? inferredToolKind ?? 'unknown');
  let toolCallCountSincePrompt = ctx.toolCallCountSincePrompt;

  // Some ACP providers stream terminal output via tool_call_update.meta.
  emitTerminalOutputFromMeta(update, ctx);

  const isTerminalStatus = status === 'completed' || status === 'failed' || status === 'cancelled';
  // Some ACP providers can emit a terminal tool_call_update without ever sending an in_progress/pending
  // update first (notably: Gemini), or after a permission gate without any intermediate updates (Qwen).
  // If we didn't track this tool call as active, seed a synthetic tool-call so downstream normalization
  // can map tool-result to a canonical tool family.
  if (isTerminalStatus && !ctx.activeToolCalls.has(toolCallId)) {
    startToolCall(toolCallId, toolKind, { ...update, status: 'pending' }, ctx, 'tool_call_update');
  }

  if (status === 'in_progress' || status === 'pending') {
    if (!ctx.activeToolCalls.has(toolCallId)) {
      toolCallCountSincePrompt++;
      startToolCall(toolCallId, toolKind, update, ctx, 'tool_call_update');
    } else {
      // If the tool call was previously pending permission, it may not have an execution timeout yet.
      // Arm the timeout as soon as it transitions to in_progress.
      if (status === 'in_progress' && !ctx.toolCallTimeouts.has(toolCallId)) {
        const toolKindStr = typeof toolKind === 'string' ? toolKind : undefined;
        const timeoutMs =
          ctx.transport.getToolCallTimeout?.(toolCallId, toolKindStr) ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
        const timeout = setTimeout(() => {
          const duration = formatDuration(ctx.toolCallStartTimes.get(toolCallId));
          logger.debug(
            `[AcpBackend] ⏱️ Tool call TIMEOUT (from tool_call_update): ${toolCallId} (${toolKind}) after ${(timeoutMs / 1000).toFixed(0)}s - Duration: ${duration}, removing from active set`,
          );

          ctx.activeToolCalls.delete(toolCallId);
          ctx.toolCallStartTimes.delete(toolCallId);
          ctx.toolCallTimeouts.delete(toolCallId);
          ctx.toolCallIdToNameMap.delete(toolCallId);
          ctx.toolCallIdToInputMap.delete(toolCallId);

          if (ctx.activeToolCalls.size === 0) {
            logger.debug('[AcpBackend] No more active tool calls after timeout, emitting idle status');
            ctx.emitIdleStatus();
          }
        }, timeoutMs);
        ctx.toolCallTimeouts.set(toolCallId, timeout);
        logger.debug(
          `[AcpBackend] ⏱️ Set timeout for ${toolCallId}: ${(timeoutMs / 1000).toFixed(0)}s (armed on in_progress)`,
        );
      }

      if (hasMeaningfulToolUpdate(update)) {
        // Refresh the existing tool call message with updated title/rawInput/locations (without
        // resetting timeouts/start times).
        emitToolCallRefresh(toolCallId, toolKind, update, ctx);
      } else {
        logger.debug(`[AcpBackend] Tool call ${toolCallId} already tracked, status: ${status}`);
      }
    }
  } else if (status === 'completed') {
    completeToolCall(toolCallId, toolKind, update, ctx);
  } else if (status === 'failed' || status === 'cancelled') {
    failToolCall(toolCallId, status, toolKind, update, ctx);
  }

  return { handled: true, toolCallCountSincePrompt };
}

/**
 * Handle tool_call session update (direct tool call).
 */
export function handleToolCall(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const toolCallId = update.toolCallId;
  const status = update.status;

  logger.debug(
    `[AcpBackend] Received tool_call: toolCallId=${toolCallId}, status=${status}, kind=${update.kind}`,
  );

  // tool_call can come without explicit status, assume 'in_progress' if missing.
  const isInProgress = !status || status === 'in_progress' || status === 'pending';

  if (!toolCallId || !isInProgress) {
    logger.debug(`[AcpBackend] Tool call ${toolCallId} not in progress (status: ${status}), skipping`);
    return { handled: false };
  }

  if (ctx.activeToolCalls.has(toolCallId)) {
    logger.debug(`[AcpBackend] Tool call ${toolCallId} already in active set, skipping`);
    return { handled: true };
  }

  startToolCall(toolCallId, update.kind, update, ctx, 'tool_call');
  return { handled: true };
}
