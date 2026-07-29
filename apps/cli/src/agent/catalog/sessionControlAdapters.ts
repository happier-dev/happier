import type { AgentId } from '@happier-dev/agents';

import { resolveCatalogAgentId } from './resolution';
import type {
  SessionCatalogControlAdapter,
  SessionGoalControlAdapter,
  SessionUsageLimitRecoveryControlAdapter,
} from './types';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import {
  createNativeInactiveCatalogAdapter,
  createNativeInactiveGoalAdapter,
  createNativeInactiveUsageAdapter,
} from './nativeInactiveSessionControlAdapters';

function resolveInactiveCapabilities(catalogId: AgentId) {
  const sessions = readAgentSessionCapabilities(
    getResolvedContributionRegistry().agentDefinitionsById
      .get(catalogId)
      ?.richDefinition
      ?.definition,
  );
  return Object.freeze({
    goals: Object.freeze({
      get: sessions?.goals?.inactive?.get === true,
      set: sessions?.goals?.inactive?.set !== undefined,
      clear: sessions?.goals?.inactive?.clear === true,
    }),
    catalog: Object.freeze({
      vendorPlugins: sessions?.catalog?.inactive?.includes('vendorPlugins') === true,
      skills: sessions?.catalog?.inactive?.includes('skills') === true,
    }),
    usage: Object.freeze({
      checkNow: sessions?.usageLimitRecovery?.inactive?.includes('checkNow') === true,
      consumeResetCredit: sessions?.usageLimitRecovery?.inactive?.includes('consumeResetCredit') === true,
    }),
  });
}

export async function resolveInactiveSessionGoalControls(
  agentId?: AgentId | null,
): Promise<SessionGoalControlAdapter | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const native = resolveInactiveCapabilities(catalogId).goals;
  if (!native.get && !native.set && !native.clear) return null;
  return createNativeInactiveGoalAdapter({ agentId: catalogId, native });
}

export async function resolveInactiveSessionCatalogControls(
  agentId?: AgentId | null,
): Promise<SessionCatalogControlAdapter | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const native = resolveInactiveCapabilities(catalogId).catalog;
  if (!native.vendorPlugins && !native.skills) return null;
  return createNativeInactiveCatalogAdapter({ agentId: catalogId, native });
}

export async function resolveInactiveSessionUsageLimitRecoveryControls(
  agentId?: AgentId | null,
): Promise<SessionUsageLimitRecoveryControlAdapter | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = getResolvedContributionRegistry().catalogEntriesById[catalogId];
  const backoffPolicy = entry?.sessionUsageLimitRecoveryBackoffPolicy ?? null;
  const native = resolveInactiveCapabilities(catalogId).usage;
  if (!backoffPolicy && !native.checkNow && !native.consumeResetCredit) return null;
  return createNativeInactiveUsageAdapter({
    agentId: catalogId,
    backoffPolicy,
    native,
  });
}
