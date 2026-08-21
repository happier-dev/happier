import { logger } from '@/ui/logger';

import {
  asRecord,
  extractErrorDetail,
  extractMeta,
  extractToolInput,
  extractToolOutput,
} from '../content';
import type { HandlerContext, HandlerResult, SessionUpdate } from '../types';
import { mergeToolCallSnapshot } from './mergeToolCallSnapshot';
import type { AcpToolCallSnapshot } from './types';

export type AcpToolCallUpdateSource = 'tool_call' | 'tool_call_update';

function extractTextFromContentBlocks(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const record = asRecord(item);
    const nested = asRecord(record?.content);
    const text = typeof record?.text === 'string'
      ? record.text
      : typeof nested?.text === 'string'
        ? nested.text
        : null;
    if (text === null) return null;
    parts.push(text);
  }
  return parts.join('');
}

function inferToolKind(update: SessionUpdate): string | null {
  const text = extractTextFromContentBlocks(extractToolInput(update));
  if (!text) return null;
  return /^Command:\s*\S+/m.test(text) && /\bExit Code:\s*\d+/m.test(text) ? 'execute' : null;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeStatus(value: unknown): AcpToolCallSnapshot['status'] | undefined {
  return value === 'pending'
    || value === 'in_progress'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
    ? value
    : undefined;
}

function isTerminalStatus(status: AcpToolCallSnapshot['status'] | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function extractTerminalOutputData(update: SessionUpdate): string | null {
  const terminalOutput = asRecord(extractMeta(update)?.terminal_output);
  const data = typeof terminalOutput?.data === 'string' ? terminalOutput.data : null;
  return data && data.length > 0 ? data : null;
}

function buildSnapshotPatch(params: Readonly<{
  update: SessionUpdate;
  source: AcpToolCallUpdateSource;
  toolCallId: string;
  kind: string;
  status: AcpToolCallSnapshot['status'] | undefined;
}>): AcpToolCallSnapshot {
  const { update, source, toolCallId, kind, status } = params;
  const patch: Record<string, unknown> = { toolCallId, kind };
  if (status !== undefined) patch.status = status;
  if (hasOwn(update, 'title')) patch.title = update.title ?? null;
  if (hasOwn(update, 'locations')) patch.locations = update.locations ?? null;
  if (hasOwn(update, 'content')) patch.content = Array.isArray(update.content) ? update.content : null;

  const hasExplicitInput = hasOwn(update, 'rawInput') || hasOwn(update, 'input');
  if (hasExplicitInput || (source === 'tool_call' && hasOwn(update, 'content'))) {
    patch.rawInput = extractToolInput(update);
  }

  const hasExplicitOutput = hasOwn(update, 'rawOutput')
    || hasOwn(update, 'output')
    || hasOwn(update, 'result')
    || hasOwn(update, 'liveContent')
    || hasOwn(update, 'live_content')
    || (source === 'tool_call_update' && hasOwn(update, 'content'));
  const terminalOutputData = extractTerminalOutputData(update);
  if (hasExplicitOutput) patch.rawOutput = extractToolOutput(update);
  else if (
    isTerminalStatus(status)
    && terminalOutputData !== null
  ) {
    patch.rawOutput = {
      stdoutChunk: terminalOutputData,
      _terminal: true,
    };
  }
  else if (
    (status === 'completed' || status === 'failed' || status === 'cancelled')
    && (Array.isArray(update.rawInput) || Array.isArray(update.input))
  ) {
    patch.rawOutput = extractToolOutput(update);
  }

  const meta = extractMeta(update);
  if (hasOwn(update, 'meta')) patch._meta = meta;
  return patch as AcpToolCallSnapshot;
}

function withAcpResultMetadata(
  value: unknown,
  snapshot: AcpToolCallSnapshot,
): Record<string, unknown> {
  const acp: Record<string, unknown> = {
    kind: typeof snapshot.kind === 'string' ? snapshot.kind : 'unknown',
  };
  if (typeof snapshot.title === 'string' && snapshot.title.trim()) acp.title = snapshot.title;
  if (Array.isArray(snapshot.locations) && snapshot.locations.length > 0) acp.locations = snapshot.locations;
  if (snapshot._meta) acp.meta = snapshot._meta;
  const record = asRecord(value);
  return record
    ? { ...record, _acp: { ...(asRecord(record._acp) ?? {}), ...acp } }
    : { output: value, _acp: acp };
}

function buildTerminalResult(
  status: AcpToolCallSnapshot['status'],
  snapshot: AcpToolCallSnapshot,
): Readonly<{ value: unknown; isError?: boolean }> | undefined {
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') return undefined;
  if (!hasOwn(snapshot, 'rawOutput')) return undefined;
  if (status === 'completed') return { value: withAcpResultMetadata(snapshot.rawOutput, snapshot) };

  const detail = extractErrorDetail(snapshot.rawOutput);
  const base = detail
    ? { error: detail, status }
    : { error: `Tool call ${status}`, status };
  return {
    isError: true,
    value: withAcpResultMetadata(base, snapshot),
  };
}

function emitTerminalOutputFromMeta(update: SessionUpdate, ctx: HandlerContext, toolCallId: string): void {
  const data = extractTerminalOutputData(update);
  if (!data) return;
  const toolName = ctx.toolCalls.get(toolCallId)?.toolName
    ?? ctx.transport.extractToolNameFromId?.(toolCallId)
    ?? (typeof update.kind === 'string' ? update.kind : 'unknown');
  ctx.emit({
    type: 'tool-result',
    toolName,
    callId: toolCallId,
    result: { stdoutChunk: data, _stream: true, _terminal: true },
  });
}

export function projectToolCallUpdate(
  incoming: SessionUpdate,
  ctx: HandlerContext,
  source: AcpToolCallUpdateSource,
): HandlerResult {
  if (ctx.transport.shouldProcessToolUpdate?.(incoming, { source }) === false) {
    return { handled: true };
  }
  const update = ctx.transport.sanitizeToolUpdateContent?.(incoming) ?? incoming;
  const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
  if (!toolCallId.trim()) return { handled: false };
  if (ctx.toolCalls.isFinalized(toolCallId)) return { handled: true };

  const previous = ctx.toolCalls.get(toolCallId);
  const incomingStatus = normalizeStatus(update.status);
  const status = incomingStatus
    ?? (source === 'tool_call' ? 'in_progress' : undefined);
  const kind = typeof update.kind === 'string' && update.kind.trim()
    ? update.kind
    : ctx.transport.extractToolNameFromId?.(toolCallId)
      ?? inferToolKind(update)
      ?? (typeof previous?.snapshot.kind === 'string' ? previous.snapshot.kind : 'unknown');
  const patch = buildSnapshotPatch({ update, source, toolCallId, kind, status });
  const merged = mergeToolCallSnapshot(previous?.snapshot ?? null, patch);
  const wasActive = previous !== null;

  if (!wasActive) {
    ctx.clearIdleTimeout();
    ctx.emit({ type: 'status', status: 'running' });
    logger.debug(`[AcpBackend] Tool call started: ${toolCallId} (${kind}) from ${source}`);
  }
  const accepted = ctx.toolCalls.observe(patch, {
    terminalResult: buildTerminalResult(merged.status, merged),
  });
  if (!accepted) return { handled: true };
  if (source === 'tool_call_update' && !isTerminalStatus(merged.status)) {
    emitTerminalOutputFromMeta(update, ctx, toolCallId);
  }

  return {
    handled: true,
    toolCallCountSincePrompt: ctx.toolCallCountSincePrompt + (wasActive ? 0 : 1),
  };
}
