import { buildBackendTargetKey, buildBackendTargetKeyV2, type AccountSettings } from '@happier-dev/protocol';

import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedBackendContribution } from '@/plugins/projection/registry/types';

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

function readReviewEngineLabel(backend: ResolvedBackendContribution): string {
  const richDefinition: unknown = backend.richDefinition?.definition;
  const title = isRecord(richDefinition) ? readTrimmedString(richDefinition.title) : '';
  return title || backend.id;
}

function readReviewEngineDescription(backend: ResolvedBackendContribution): string | undefined {
  const richDefinition: unknown = backend.richDefinition?.definition;
  const subtitle = isRecord(richDefinition) ? readTrimmedString(richDefinition.subtitle) : '';
  return subtitle || undefined;
}

function isReviewExecutionRunBackend(backend: ResolvedBackendContribution): boolean {
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
  const items = getResolvedContributionRegistry().backends
    .filter(isReviewExecutionRunBackend)
    .map((backend) => {
      const targetKey = buildBackendTargetKeyV2({
        kind: 'backend',
        backendId: backend.id,
        sourceKind: 'built_in',
      });
      const legacyTargetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: backend.id });
      return {
        engineId: backend.id,
        value: backend.id,
        label: readReviewEngineLabel(backend),
        ...(readReviewEngineDescription(backend) ? { description: readReviewEngineDescription(backend) } : {}),
        enabled: isBackendEnabled(accountSettings, [targetKey, legacyTargetKey]),
        backendId: backend.id,
      };
    })
    .filter((item) => includeDisabled || item.enabled !== false);

  return limit ? items.slice(0, limit) : items;
}
