import type { MessageMeta } from '../../domains/messages/messageMetaTypes';
import type { ToolResultUpdate } from './toolResultUpdateTypes';

const ORPHAN_TOOL_RESULT_TTL_MS = 10 * 60_000;
const MAX_ORPHAN_TOOL_RESULTS_PER_TOOL = 100;
const MAX_TOTAL_ORPHAN_TOOL_RESULTS = 1_000;

export type BufferedToolResult = {
  key: string;
  createdAt: number;
  meta?: MessageMeta;
  toolResult: ToolResultUpdate;
};

export type OrphanToolResultBucket = {
  updatedAt: number;
  results: BufferedToolResult[];
};

type OrphanToolResultState = {
  orphanToolResults: Map<string, OrphanToolResultBucket>;
};

function pruneOrphanToolResults(state: OrphanToolResultState, now: number): void {
  for (const [toolUseId, bucket] of state.orphanToolResults) {
    if (now - bucket.updatedAt > ORPHAN_TOOL_RESULT_TTL_MS) {
      state.orphanToolResults.delete(toolUseId);
    }
  }

  let total = 0;
  for (const bucket of state.orphanToolResults.values()) {
    total += bucket.results.length;
  }
  if (total <= MAX_TOTAL_ORPHAN_TOOL_RESULTS) return;

  const buckets = [...state.orphanToolResults.entries()].sort(
    (a, b) => a[1].updatedAt - b[1].updatedAt
  );
  for (const [toolUseId, bucket] of buckets) {
    state.orphanToolResults.delete(toolUseId);
    total -= bucket.results.length;
    if (total <= MAX_TOTAL_ORPHAN_TOOL_RESULTS) break;
  }
}

export function bufferOrphanToolResult(params: Readonly<{
  state: OrphanToolResultState;
  toolUseId: string;
  result: BufferedToolResult;
  now?: number;
}>): void {
  const { state, toolUseId, result } = params;
  const now = typeof params.now === 'number' ? params.now : Date.now();

  pruneOrphanToolResults(state, now);

  const bucket = state.orphanToolResults.get(toolUseId) ?? { updatedAt: now, results: [] };
  bucket.updatedAt = now;

  const alreadyBuffered = bucket.results.some((existing) => existing.key === result.key);
  if (!alreadyBuffered) {
    bucket.results.push(result);
  }

  if (bucket.results.length > MAX_ORPHAN_TOOL_RESULTS_PER_TOOL) {
    bucket.results.splice(0, bucket.results.length - MAX_ORPHAN_TOOL_RESULTS_PER_TOOL);
  }

  state.orphanToolResults.set(toolUseId, bucket);
  pruneOrphanToolResults(state, now);
}

export function drainOrphanToolResults(params: Readonly<{
  state: OrphanToolResultState;
  toolUseId: string;
}>): BufferedToolResult[] | null {
  const { state, toolUseId } = params;
  const bucket = state.orphanToolResults.get(toolUseId);
  if (!bucket) return null;

  state.orphanToolResults.delete(toolUseId);
  return [...bucket.results].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.key.localeCompare(b.key);
  });
}

