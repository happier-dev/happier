import type { CatalogAgentId } from './ids';
import { findCatalogEntry } from './registry';
import { resolveCatalogAgentId } from './resolution';
import { readAgentCatalogSnapshot } from './snapshot';
import type {
  SessionCatalogControlAdapter,
  SessionGoalControlAdapter,
  SessionUsageLimitRecoveryControlAdapter,
} from './types';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import {
  createNativeInactiveCatalogAdapter,
  createNativeInactiveGoalAdapter,
  createNativeInactiveUsageAdapter,
} from './nativeInactiveSessionControlAdapters';

function resolveInactiveCapabilities(catalogId: CatalogAgentId) {
  const sessions = readAgentSessionCapabilities(
    readAgentCatalogSnapshot().agentDefinitionsById
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
  agentId?: CatalogAgentId | null,
): Promise<SessionGoalControlAdapter | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  if (!catalogId) return null;
  const native = resolveInactiveCapabilities(catalogId).goals;
  if (!native.get && !native.set && !native.clear) return null;
  return createNativeInactiveGoalAdapter({ agentId: catalogId, native });
}

export async function resolveInactiveSessionCatalogControls(
  agentId?: CatalogAgentId | null,
): Promise<SessionCatalogControlAdapter | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  if (!catalogId) return null;
  const native = resolveInactiveCapabilities(catalogId).catalog;
  if (!native.vendorPlugins && !native.skills) return null;
  return createNativeInactiveCatalogAdapter({ agentId: catalogId, native });
}

export async function resolveInactiveSessionUsageLimitRecoveryControls(
  agentId?: CatalogAgentId | null,
): Promise<SessionUsageLimitRecoveryControlAdapter | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  if (!catalogId) return null;
  const entry = findCatalogEntry(catalogId);
  const backoffPolicy = entry?.sessionUsageLimitRecoveryBackoffPolicy ?? null;
  const native = resolveInactiveCapabilities(catalogId).usage;
  if (!backoffPolicy && !native.checkNow && !native.consumeResetCredit) return null;
  return createNativeInactiveUsageAdapter({
    agentId: catalogId,
    backoffPolicy,
    native,
  });
}
