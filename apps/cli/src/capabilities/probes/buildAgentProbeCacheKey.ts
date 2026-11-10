import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import { buildBackendTargetKey } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import type { ProbedCatalogOptionValue } from '@happier-dev/protocol/capabilities';

export function buildAgentProbeCacheKey(params: Readonly<{
  agentId: CatalogAgentLookupId;
  cwd: string;
  modelId?: string;
  backendTarget?: BackendTargetRefV1;
  variant?: string;
  connectedServiceSelection?: string | null;
  profile?: string | null;
  configOptionOverrides?: Readonly<Record<string, ProbedCatalogOptionValue>>;
}>): string {
  const normalizedCwd = String(params.cwd ?? '').trim();
  // A concrete built-in target is another address for the same Agent probe,
  // not a separate native catalog. Configured definitions remain distinct.
  const targetKey = params.backendTarget
    && !(params.backendTarget.kind === 'builtInAgent' && params.backendTarget.agentId === params.agentId)
    ? buildBackendTargetKey(params.backendTarget) : 'none';
  // Always include agentId even when the probe is scoped to a backend target, so cache keys cannot
  // collide across agents that might eventually share target-key space (e.g. configured backends).
  const configEntries = Object.entries(params.configOptionOverrides ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const configScope = configEntries.length > 0 ? `:config:${JSON.stringify(configEntries)}` : '';
  const modelScope = params.modelId === undefined ? '' : `:model:${JSON.stringify(params.modelId)}`;
  return `agent:${params.agentId}:target:${targetKey}:cwd:${normalizedCwd}:v:${params.variant ?? 'default'}:profile:${params.profile ?? 'none'}:connected:${params.connectedServiceSelection ?? 'none'}${configScope}${modelScope}`;
}
