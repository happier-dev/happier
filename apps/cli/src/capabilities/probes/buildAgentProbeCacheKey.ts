import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';
import { hashStableJsonIdentity } from '@/utils/stableJsonIdentity';

export function buildAgentProbeCacheKey(params: Readonly<{
  agentId: CatalogAgentLookupId;
  cwd: string;
  backendTarget?: BackendTargetRefV1;
  variant?: string;
  connectedServices?: unknown;
}>): string {
  const normalizedCwd = String(params.cwd ?? '').trim();
  const targetKey = params.backendTarget ? buildBackendTargetKey(params.backendTarget) : 'none';
  const connectedServicesKey = params.connectedServices === undefined
    ? 'none'
    : hashStableJsonIdentity(params.connectedServices);
  // Always include agentId even when the probe is scoped to a backend target, so cache keys cannot
  // collide across agents that might eventually share target-key space (e.g. configured backends).
  return `agent:${params.agentId}:target:${targetKey}:cwd:${normalizedCwd}:v:${params.variant ?? 'default'}:connectedServices:${connectedServicesKey}`;
}
