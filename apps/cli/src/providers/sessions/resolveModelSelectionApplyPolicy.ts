import {
  AgentProviderRequirementsV1Schema,
  resolveModelSelectionApplyPolicyV1,
  type ModelSelectionApplyPolicy,
  type ProviderBoundModelRef,
} from '@happier-dev/protocol';
import type { AgentModelConfig } from '@happier-dev/agents';

import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
export { resolveProviderAuthorizationApplyPolicy } from './providerAuthorizationApplyPolicy';

type AgentDefinitionPolicyRegistry = Readonly<{
  contributes: Readonly<{
    agentDefinitionsById: ReadonlyMap<string, Readonly<{
      definition: Readonly<{
        ownedBackendIds?: readonly string[];
        providerRequirements?: unknown;
      }>;
    }>>;
  }>;
}>;

function hasProviderBinding(selection: ProviderBoundModelRef | null): boolean {
  return selection?.providerConnectionId != null;
}

export function resolveNativeAgentModelApplyPolicy(
  modelConfig: Pick<
    AgentModelConfig,
    'supportsSelection' | 'nonAcpApplyScope' | 'acpApplyBehavior'
  >,
): Extract<
  ModelSelectionApplyPolicy,
  'live' | 'restart_session' | 'unsupported'
> {
  if (!modelConfig.supportsSelection) return 'unsupported';
  if (
    modelConfig.nonAcpApplyScope === 'spawn_only'
    || modelConfig.acpApplyBehavior === 'restart_session'
  ) {
    return 'restart_session';
  }
  return 'live';
}

/**
 * Applies the Agent-owned model policy to native-only changes and requires a
 * restart whenever a Provider binding crosses an unverified runtime seam.
 */
export function resolveSessionModelSelectionApplyPolicy(params: Readonly<{
  current: ProviderBoundModelRef | null;
  next: ProviderBoundModelRef | null;
  agentPolicy: ModelSelectionApplyPolicy;
}>): ModelSelectionApplyPolicy {
  if (!hasProviderBinding(params.current) && !hasProviderBinding(params.next)) {
    return params.agentPolicy;
  }

  if (params.current === null || params.next === null) {
    return 'restart_session';
  }

  const policy = resolveModelSelectionApplyPolicyV1({
    current: params.current,
    next: params.next,
    agentPolicy: params.agentPolicy,
    liveProviderRebindingVerified: false,
  });
  return policy === 'live' ? 'restart_session' : policy;
}

export function resolveAgentProviderApplyPolicyFromRegistry(params: Readonly<{
  registry: AgentDefinitionPolicyRegistry;
  backendId: string;
}>): ModelSelectionApplyPolicy {
  const matches = [...params.registry.contributes.agentDefinitionsById.values()]
    .filter((entry) => entry.definition.ownedBackendIds?.includes(params.backendId) === true);
  if (matches.length === 0) return 'unsupported';
  if (matches.length > 1) {
    throw new Error(`Multiple agents own provider model policy for backend '${params.backendId}'`);
  }
  const support = AgentProviderRequirementsV1Schema.safeParse(matches[0]?.definition.providerRequirements);
  return support.success ? support.data.applyPolicy : 'unsupported';
}

export async function resolveAuthoritativeAgentProviderApplyPolicy(params: Readonly<{
  backendId: string;
}>): Promise<ModelSelectionApplyPolicy> {
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  try {
    return resolveAgentProviderApplyPolicyFromRegistry({
      registry: lease.registry,
      backendId: params.backendId,
    });
  } finally {
    await lease.release();
  }
}
