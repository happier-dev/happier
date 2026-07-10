import type { RawJSONLines } from './rawJsonLines.js';

const CLAUDE_JSONL_RESET_REPLAY_SUPPRESS_CLOCK_SKEW_MS = 30_000;

export type ClaudeJsonlResetReplaySuppressor = Readonly<{
  markReset(nowMs?: number): void;
  shouldSuppress(row: Readonly<Record<string, unknown>> | RawJSONLines): boolean;
  getSuppressBeforeMs(): number | null;
  clear(): void;
}>;

export function readClaudeJsonlRowTimestampMs(row: Readonly<Record<string, unknown>>): number | null {
  const value = row.timestamp ?? row.createdAt ?? row.created_at;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createClaudeJsonlResetReplaySuppressor(params: Readonly<{
  nowMs?: () => number;
}> = {}): ClaudeJsonlResetReplaySuppressor {
  const readNowMs = params.nowMs ?? (() => Date.now());
  let suppressBeforeMs: number | null = null;

  return {
    markReset(nowMs = readNowMs()) {
      suppressBeforeMs = nowMs - CLAUDE_JSONL_RESET_REPLAY_SUPPRESS_CLOCK_SKEW_MS;
    },
    shouldSuppress(row) {
      if (suppressBeforeMs === null) return false;
      const timestampMs = readClaudeJsonlRowTimestampMs(row);
      if (timestampMs === null) return true;
      if (timestampMs < suppressBeforeMs) return true;
      suppressBeforeMs = null;
      return false;
    },
    getSuppressBeforeMs() {
      return suppressBeforeMs;
    },
    clear() {
      suppressBeforeMs = null;
    },
  };
}
