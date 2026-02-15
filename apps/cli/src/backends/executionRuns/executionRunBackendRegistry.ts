import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';

import { executionRunBackendFactory as claude } from '@/backends/claude/executionRuns/executionRunBackendFactory';
import { executionRunBackendFactory as codex } from '@/backends/codex/executionRuns/executionRunBackendFactory';
import { executionRunBackendFactory as gemini } from '@/backends/gemini/executionRuns/executionRunBackendFactory';
import { executionRunBackendFactory as opencode } from '@/backends/opencode/executionRuns/executionRunBackendFactory';
import { executionRunBackendFactory as auggie } from '@/backends/auggie/executionRuns/executionRunBackendFactory';
import { executionRunBackendFactory as qwen } from '@/backends/qwen/executionRuns/executionRunBackendFactory';
import { executionRunBackendFactory as kimi } from '@/backends/kimi/executionRuns/executionRunBackendFactory';
import { executionRunBackendFactory as kilo } from '@/backends/kilo/executionRuns/executionRunBackendFactory';

import { listNativeReviewEngineIds, resolveNativeReviewExecutionRunBackendFactory } from '@/agent/reviews/engines/nativeReviewEngines';

const REGISTRY: Record<string, ExecutionRunBackendFactory> = {
  claude,
  codex,
  gemini,
  opencode,
  auggie,
  qwen,
  kimi,
  kilo,
};

for (const engineId of listNativeReviewEngineIds()) {
  const factory = resolveNativeReviewExecutionRunBackendFactory(engineId);
  if (factory) {
    REGISTRY[engineId] = factory;
  }
}

export function resolveExecutionRunBackendFactory(backendId: string): ExecutionRunBackendFactory | null {
  const key = String(backendId ?? '').trim();
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(REGISTRY, key) ? REGISTRY[key]! : null;
}

// Preferred name: matches plan terminology and makes call sites self-describing.
export function getExecutionRunBackendFactory(backendId: string): ExecutionRunBackendFactory | null {
  return resolveExecutionRunBackendFactory(backendId);
}
