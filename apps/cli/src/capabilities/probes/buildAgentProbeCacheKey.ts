import type { CatalogAgentId } from '@/backends/types';
import { buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';

export function buildAgentProbeCacheKey(params: Readonly<{
  agentId: CatalogAgentId;
  cwd: string;
  backendTarget?: BackendTargetRefV1;
  variant?: string;
}>): string {
  const normalizedCwd = String(params.cwd ?? '').trim();
  const targetKey = params.backendTarget ? buildBackendTargetKey(params.backendTarget) : 'none';
  // Always include agentId even when the probe is scoped to a backend target, so cache keys cannot
  // collide across agents that might eventually share target-key space (e.g. configured backends).
  return `agent:${params.agentId}:target:${targetKey}:cwd:${normalizedCwd}:v:${params.variant ?? 'default'}`;
}
