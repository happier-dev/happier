import { buildBackendTargetKey, buildBackendTargetKeyV2, type AccountSettings } from '@happier-dev/protocol';

import { readAgentContributionDisplayTitle } from '@/agent/catalog/agentDisplayTitle';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import type {
  ResolvedAgentContribution,
} from '@/plugins/projection/registry/types';

import { isBackendEnabled } from './backendAvailability';

export type ActionReviewEngineInventoryItem = Readonly<{
  engineId: string;
  value: string;
  label: string;
  enabled: boolean;
  backendId: string;
  description?: string;
}>;

function normalizeLimit(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.min(200, Math.floor(parsed)));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The Agent's declared title is owned by `readAgentContributionDisplayTitle`;
 * only the review-engine subtitle is read locally.
 */
function readReviewEngineDescription(
  agent: ResolvedAgentContribution,
): string | undefined {
  const definitions: readonly unknown[] = [
    agent.richDefinition?.definition,
    agent.definition,
  ];
  for (const definition of definitions) {
    const value = isRecord(definition) ? readTrimmedString(definition.subtitle) : '';
    if (value) return value;
  }
  return undefined;
}

export function buildReviewEngineInventoryItems(params: Readonly<{
  limit?: unknown;
  includeDisabled?: boolean;
  accountSettings?: AccountSettings | null;
}>): readonly ActionReviewEngineInventoryItem[] {
  const accountSettings = params.accountSettings ?? null;
  const includeDisabled = params.includeDisabled === true;
  const limit = normalizeLimit(params.limit);
  const registry = readAgentCatalogSnapshot();
  const agentIdByQualifiedIdentity = new Map(
    [...registry.agentDefinitionsById.values()].flatMap((agent) => (
      agent.identity
        ? [[`${agent.identity.pluginId}\0${agent.identity.localId}`, agent.id] as const]
        : []
    )),
  );
  const reviewAgentIds = new Set(
    (registry.executionRunProfiles ?? [])
      .filter((profile) => profile.definition.intent === 'review')
      .flatMap((profile) => profile.definition.compatibleAgents.flatMap((reference) => {
        const localId = typeof reference === 'string' ? reference : reference.localId;
        const pluginId = typeof reference === 'string' ? profile.pluginId : reference.pluginId;
        const qualifiedAgentId = pluginId
          ? agentIdByQualifiedIdentity.get(`${pluginId}\0${localId}`)
          : undefined;
        if (qualifiedAgentId) return [qualifiedAgentId];
        return registry.agentDefinitionsById.has(localId) ? [localId] : [];
      })),
  );
  const items = [...reviewAgentIds]
    .sort()
    .flatMap((agentId) => {
      const agent = registry.agentDefinitionsById.get(agentId);
      if (!agent) return [];
      const description = readReviewEngineDescription(agent);
      const targetKey = buildBackendTargetKeyV2({
        kind: 'backend',
        backendId: agent.id,
        sourceKind: 'built_in',
      });
      const legacyTargetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: agent.id });
      return [{
        engineId: agent.id,
        value: agent.id,
        label: readAgentContributionDisplayTitle(agent, agent.id) ?? agent.id,
        ...(description ? { description } : {}),
        enabled: isBackendEnabled(accountSettings, [targetKey, legacyTargetKey]),
        backendId: agent.id,
      }];
    })
    .filter((item) => includeDisabled || item.enabled !== false);

  return limit ? items.slice(0, limit) : items;
}
