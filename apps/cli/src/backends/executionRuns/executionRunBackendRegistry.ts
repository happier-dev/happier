import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';
import type { BackendIsolationBundle, BackendIsolationRequest } from '@/backends/isolation/types';

import { executionRunBackendFactory as claude, resolveIsolation as claudeResolveIsolation } from '@/backends/claude/executionRuns/executionRunBackendFactory';
import { executionRunBackendFactory as codex } from '@/backends/codex/executionRuns/executionRunBackendFactory';
import { executionRunBackendFactory as gemini } from '@/backends/gemini/executionRuns/executionRunBackendFactory';
import { executionRunBackendFactory as opencode } from '@/backends/opencode/executionRuns/executionRunBackendFactory';
import { executionRunBackendFactory as auggie } from '@/backends/auggie/executionRuns/executionRunBackendFactory';
import { executionRunBackendFactory as qwen } from '@/backends/qwen/executionRuns/executionRunBackendFactory';
import { executionRunBackendFactory as kimi } from '@/backends/kimi/executionRuns/executionRunBackendFactory';
import { executionRunBackendFactory as kilo } from '@/backends/kilo/executionRuns/executionRunBackendFactory';
import { executionRunBackendFactory as copilot } from '@/backends/copilot/executionRuns/executionRunBackendFactory';

import { listNativeReviewEngineIds, resolveNativeReviewExecutionRunBackendFactory } from '@/agent/reviews/engines/nativeReviewEngines';

export type ExecutionRunBackendDescriptor = Readonly<{
  factory: ExecutionRunBackendFactory;
  resolveIsolation?: (request: BackendIsolationRequest, baseBundle: BackendIsolationBundle) => BackendIsolationBundle;
}>;

const REGISTRY: Record<string, ExecutionRunBackendDescriptor> = {
  claude: { factory: claude, resolveIsolation: claudeResolveIsolation },
  codex: { factory: codex },
  gemini: { factory: gemini },
  opencode: { factory: opencode },
  auggie: { factory: auggie },
  qwen: { factory: qwen },
  kimi: { factory: kimi },
  kilo: { factory: kilo },
  copilot: { factory: copilot },
};

for (const engineId of listNativeReviewEngineIds()) {
  const factory = resolveNativeReviewExecutionRunBackendFactory(engineId);
  if (factory) {
    REGISTRY[engineId] = { factory };
  }
}

export function resolveExecutionRunBackendDescriptor(backendId: string): ExecutionRunBackendDescriptor | null {
  const key = String(backendId ?? '').trim();
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(REGISTRY, key) ? REGISTRY[key]! : null;
}

export function resolveExecutionRunBackendFactory(backendId: string): ExecutionRunBackendFactory | null {
  return resolveExecutionRunBackendDescriptor(backendId)?.factory ?? null;
}

// Preferred name: matches plan terminology and makes call sites self-describing.
export function getExecutionRunBackendFactory(backendId: string): ExecutionRunBackendFactory | null {
  return resolveExecutionRunBackendFactory(backendId);
}

export function getExecutionRunBackendDescriptor(backendId: string): ExecutionRunBackendDescriptor | null {
  return resolveExecutionRunBackendDescriptor(backendId);
}
