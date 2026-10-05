import { isBackendTargetDisabledByAccountSettings, type AccountSettings, type ReviewEngineCapabilities } from '@happier-dev/protocol';

import { readAgentContributionDisplayTitle } from '@/agent/catalog/agentDisplayTitle';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { readAgentExecutionRunCapabilities, readAgentStructuredOutputCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import type {
  ResolvedAgentContribution,
} from '@/plugins/projection/registry/types';

import { buildConfiguredAcpBackendInventoryItems } from './buildAgentBackendInventoryItems';

export type ActionReviewEngineInventoryItem = Readonly<{
  engineId: string;
  value: string;
  label: string;
  enabled: boolean;
  backendId: string;
  capabilities: ReviewEngineCapabilities;
  description?: string;
}>;

export type ReviewEngineScope = 'worktree' | 'paths';

type ReviewAgentCatalog = ReturnType<typeof readAgentCatalogSnapshot>;

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

/** Shared selector for the Action inventory and machine-capability projection. */
export function selectReviewEngineAgentIds(
  registry: ReviewAgentCatalog,
  scope: ReviewEngineScope = 'worktree',
): ReadonlySet<string> {
  const agentIdByQualifiedIdentity = new Map(
    [...registry.agentDefinitionsById.values()].flatMap((agent) => (
      agent.identity
        ? [[`${agent.identity.pluginId}\0${agent.identity.localId}`, agent.id] as const]
        : []
    )),
  );
  const reviewProfileAgentIds = new Set<string>();
  const exactPathProfileAgentIds = new Set<string>();
  for (const profile of registry.executionRunProfiles ?? []) {
    if (profile.definition.intent !== 'review') continue;
    const declaredScopes = profile.definition.metadata?.reviewScopes;
    const supportsExactPaths = !Array.isArray(declaredScopes) || declaredScopes.includes('paths');
    for (const reference of profile.definition.compatibleAgents) {
        const localId = typeof reference === 'string' ? reference : reference.localId;
        const pluginId = typeof reference === 'string' ? profile.pluginId : reference.pluginId;
        const qualifiedAgentId = pluginId
          ? agentIdByQualifiedIdentity.get(`${pluginId}\0${localId}`)
          : undefined;
        const agentId = qualifiedAgentId ?? (registry.agentDefinitionsById.has(localId) ? localId : null);
        if (!agentId) continue;
        reviewProfileAgentIds.add(agentId);
        if (supportsExactPaths) exactPathProfileAgentIds.add(agentId);
    }
  }
  const reviewAgentIds = new Set<string>();
  for (const agent of registry.agentDefinitionsById.values()) {
    const definition = agent.richDefinition?.definition;
    if (
      readAgentExecutionRunCapabilities(definition)?.open.includes('create')
      && (scope !== 'paths' || !reviewProfileAgentIds.has(agent.id) || exactPathProfileAgentIds.has(agent.id))
    ) {
      reviewAgentIds.add(agent.id);
    }
  }
  return reviewAgentIds;
}

export async function buildReviewEngineInventoryItems(params: Readonly<{
  limit?: unknown;
  includeDisabled?: boolean;
  accountSettings?: AccountSettings | null;
  scope?: ReviewEngineScope;
}>): Promise<readonly ActionReviewEngineInventoryItem[]> {
  const accountSettings = params.accountSettings ?? null;
  const includeDisabled = params.includeDisabled === true;
  const limit = normalizeLimit(params.limit);
  const registry = readAgentCatalogSnapshot();
  const reviewAgentIds = selectReviewEngineAgentIds(registry, params.scope);
  const agentItems = [...reviewAgentIds]
    .sort()
    .flatMap((agentId) => {
      const agent = registry.agentDefinitionsById.get(agentId);
      if (!agent) return [];
      const description = readReviewEngineDescription(agent);
      return [{
        engineId: agent.id,
        value: agent.id,
        label: readAgentContributionDisplayTitle(agent, agent.id) ?? agent.id,
        ...(description ? { description } : {}),
        enabled: !isBackendTargetDisabledByAccountSettings(accountSettings, { kind: 'backend', backendId: agent.id }),
        backendId: agent.id,
        capabilities: { structuredNarration: readAgentStructuredOutputCapabilities(agent.richDefinition?.definition)?.formats.includes('json') === true },
      }];
    });
  const configuredItems = (await buildConfiguredAcpBackendInventoryItems(accountSettings))
    .filter((item): item is typeof item & { backendId: string } => typeof item.backendId === 'string')
    .map((item): ActionReviewEngineInventoryItem => ({
      engineId: item.targetKey,
      value: item.targetKey,
      label: item.label,
      enabled: item.enabled,
      backendId: item.backendId,
      capabilities: { structuredNarration: false },
      ...(item.description ? { description: item.description } : {}),
    }));
  const items = [...agentItems, ...configuredItems]
    .filter((item) => includeDisabled || item.enabled !== false);

  return limit ? items.slice(0, limit) : items;
}
