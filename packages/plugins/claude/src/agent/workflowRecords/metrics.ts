import {
  SESSION_WORKFLOW_RUN_SNAPSHOT_RESULT_PREVIEW_MAX,
  SESSION_WORKFLOW_RUN_SNAPSHOT_SUMMARY_MAX,
} from '@happier-dev/plugin-sdk/experimental/sessions/workState';

/**
 * The ONE metrics/result-preview mapper for Claude workflow normalization (CWF2).
 *
 * Every token/toolCall/duration/model/resultPreview value written into a
 * `SessionWorkflowRunSnapshotV1` agent or run must pass through here so the mapping cannot drift
 * across the tracker, phase rollups, and run aggregation. UI never re-parses raw provider payloads.
 */

function readFiniteNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

export function readTokensUsed(value: unknown): number | undefined {
  return readFiniteNonNegativeInt(value);
}

export function readToolCalls(value: unknown): number | undefined {
  return readFiniteNonNegativeInt(value);
}

/** Claude reports durations in milliseconds; the protocol contract stores seconds. */
export function readDurationSecondsFromMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value / 1000;
}

export function readModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 400) : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatScalar(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

function summarizeStructuredPreview(record: Record<string, unknown>): string | undefined {
  for (const key of ['summary', 'message', 'result', 'verdict']) {
    const value = formatScalar(record[key]);
    if (value) return value;
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const formatted = formatScalar(value);
    if (!formatted) continue;
    parts.push(`${key}: ${formatted}`);
    if (parts.length >= 4) break;
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function normalizeStructuredJsonPreview(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isPlainRecord(parsed)) return undefined;
    return summarizeStructuredPreview(parsed);
  } catch {
    return undefined;
  }
}

/** Deterministic, bounded result preview normalization (W1 bound). */
export function normalizeResultPreview(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const structured = normalizeStructuredJsonPreview(trimmed);
  return truncate(structured ?? trimmed, SESSION_WORKFLOW_RUN_SNAPSHOT_RESULT_PREVIEW_MAX);
}

/** Deterministic, bounded summary normalization (W1 bound). */
export function normalizeSummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return truncate(trimmed, SESSION_WORKFLOW_RUN_SNAPSHOT_SUMMARY_MAX);
}

/** Read `usage.total_tokens` / `usage.tool_uses` / `usage.duration_ms` from a Claude usage object. */
export type ClaudeWorkflowUsageMetrics = Readonly<{
  tokensUsed?: number;
  toolCalls?: number;
  timeUsedSeconds?: number;
}>;

export function readUsageMetrics(usage: unknown): ClaudeWorkflowUsageMetrics {
  if (!usage || typeof usage !== 'object') return {};
  const record = usage as Record<string, unknown>;
  const tokensUsed = readTokensUsed(record.total_tokens);
  const toolCalls = readToolCalls(record.tool_uses);
  const timeUsedSeconds = readDurationSecondsFromMs(record.duration_ms);
  return {
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(timeUsedSeconds !== undefined ? { timeUsedSeconds } : {}),
  };
}
