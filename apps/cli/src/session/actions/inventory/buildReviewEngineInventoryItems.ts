import { buildBackendTargetKey, buildBackendTargetKeyV2, type AccountSettings } from '@happier-dev/protocol';

import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type {
  ResolvedAgentContribution,
  ResolvedAgentRuntimeContribution,
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

function readReviewEngineDefinitionField(
  backend: ResolvedAgentRuntimeContribution,
  agent: ResolvedAgentContribution | undefined,
  field: 'title' | 'subtitle',
): string {
  const definitions: readonly unknown[] = [
    backend.richDefinition?.definition,
    backend.definition,
    agent?.richDefinition?.definition,
    agent?.definition,
  ];
  for (const definition of definitions) {
    const value = isRecord(definition) ? readTrimmedString(definition[field]) : '';
    if (value) return value;
  }
  return '';
}

function readReviewEngineLabel(
  backend: ResolvedAgentRuntimeContribution,
  agent: ResolvedAgentContribution | undefined,
): string {
  return readReviewEngineDefinitionField(backend, agent, 'title') || backend.id;
}

function readReviewEngineDescription(
  backend: ResolvedAgentRuntimeContribution,
  agent: ResolvedAgentContribution | undefined,
): string | undefined {
  return readReviewEngineDefinitionField(backend, agent, 'subtitle') || undefined;
}

function isReviewExecutionRunBackend(backend: ResolvedAgentRuntimeContribution): boolean {
  const session = backend.capabilities?.session;
  const executionRun = backend.capabilities?.executionRun;
  const review = isRecord(executionRun) ? executionRun.review : null;
  const intents = isRecord(review) && Array.isArray(review.intents) ? review.intents : [];

  return isRecord(session)
    && session.supported === false
    && executionRun?.supported !== false
    && isRecord(review)
    && intents.includes('review');
}

export function buildReviewEngineInventoryItems(params: Readonly<{
  limit?: unknown;
  includeDisabled?: boolean;
  accountSettings?: AccountSettings | null;
}>): readonly ActionReviewEngineInventoryItem[] {
  const accountSettings = params.accountSettings ?? null;
  const includeDisabled = params.includeDisabled === true;
  const limit = normalizeLimit(params.limit);
  const registry = getResolvedContributionRegistry();
  const items = registry.agentRuntimes
    .filter(isReviewExecutionRunBackend)
    .map((backend) => {
      const agent = registry.agentDefinitionsById.get(backend.agentId);
      const description = readReviewEngineDescription(backend, agent);
      const targetKey = buildBackendTargetKeyV2({
        kind: 'backend',
        backendId: backend.id,
        sourceKind: 'built_in',
      });
      const legacyTargetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: backend.id });
      return {
        engineId: backend.id,
        value: backend.id,
        label: readReviewEngineLabel(backend, agent),
        ...(description ? { description } : {}),
        enabled: isBackendEnabled(accountSettings, [targetKey, legacyTargetKey]),
        backendId: backend.id,
      };
    })
    .filter((item) => includeDisabled || item.enabled !== false);

  return limit ? items.slice(0, limit) : items;
}
