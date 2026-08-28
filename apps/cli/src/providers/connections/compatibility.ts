import {
  projectProviderBindingCompatibilityForConnectionV1,
  resolveProviderBindingCompatibilityWithFingerprintV1,
} from '@happier-dev/protocol';
import type { DaemonProviderAgentCompatibilitySummaryV1 } from '@happier-dev/protocol/rpc';

import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import type { ResolvedAgentContribution } from '@/plugins/projection/registry/types';
import type { ResolvedProviderConnectionRecord } from '@/providers/registry';
import { resolveProviderSourceFacts } from '@/providers/registry/sourceFacts';

function readAgentName(
  contribution: ResolvedAgentContribution,
  agentId: string,
): string {
  const rich = contribution.richDefinition;
  if (rich) {
    const title = rich.definition.title;
    const localizedTitle = typeof title === 'string' ? title : title.fallback;
    if (localizedTitle.trim().length > 0) return localizedTitle.trim();
  }
  const runtimeTitle = contribution.runtimeSpec?.title;
  return typeof runtimeTitle === 'string' && runtimeTitle.trim().length > 0
    ? runtimeTitle.trim()
    : agentId;
}

/**
 * Bounded, non-secret connection-level projection for Settings → Works with.
 * Static support and the executable adapter are read from one leased generation;
 * the UI never infers compatibility from protocol names.
 */
export function projectProviderConnectionCompatibility(input: Readonly<{
  lease: PluginRuntimeRegistryLease;
  connection: ResolvedProviderConnectionRecord;
}>): readonly DaemonProviderAgentCompatibilitySummaryV1[] {
  const facts = resolveProviderSourceFacts(input.connection);
  const summaries: DaemonProviderAgentCompatibilitySummaryV1[] = [];
  const definitions = [...input.lease.registry.contributes.agentDefinitionsById.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [agentId, contribution] of definitions) {
    const agentTargetKey = `backend:${agentId}`;
    const agentName = readAgentName(contribution, agentId);
    // A static declaration without an active adapter is not incompatibility.
    // Omit it until the same leased generation has executable runtime truth.
    if (
      contribution.definition.providerRequirements !== undefined
      && !input.lease.registry.agentRuntimesByAgentId.has(agentId)
    ) {
      continue;
    }
    try {
      const adapter = readLeasedAgentProviderBindingAdapter({ lease: input.lease, agentId });
      if (!adapter) {
        summaries.push({
          agentTargetKey,
          agentName,
          status: 'incompatible',
          reasons: ['agent_external_providers_unsupported'],
        });
        continue;
      }
      const compatibility = resolveProviderBindingCompatibilityWithFingerprintV1({
        agentTargetKey,
        endpoints: facts.endpointTemplates,
        credential: facts.credential,
        agent: adapter.support,
        compatibilityOverrides: facts.compatibilityOverrides,
        adapterVersion: adapter.adapter.adapterVersion,
      });
      const projected = projectProviderBindingCompatibilityForConnectionV1(compatibility.result);
      if (projected.status === 'verified') {
        summaries.push({ agentTargetKey, agentName, status: 'verified', reasons: [] });
      } else if (projected.status === 'experimental') {
        summaries.push({ agentTargetKey, agentName, status: 'experimental', reasons: [...projected.reasons] });
      } else {
        summaries.push({ agentTargetKey, agentName, status: 'incompatible', reasons: [...projected.reasons] });
      }
    } catch {
      summaries.push({ agentTargetKey, agentName, status: 'incompatible', reasons: ['adapter_contract_invalid'] });
    }
  }
  return Object.freeze(summaries);
}
