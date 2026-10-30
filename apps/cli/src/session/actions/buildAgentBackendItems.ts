import {
  AGENT_IDS,
  getProviderCliRuntimeSpec,
  type AgentId,
} from '@happier-dev/agents';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { isBackendEnabledByAccountSettings } from '@/settings/backendEnabled';

export type AgentBackendItem = Readonly<{
  targetKey: string;
  label: string;
  enabled: boolean;
  agentId: AgentId;
}>;

/**
 * Inventory for `agents.backends.list`: every catalog backend, filtered by the account's
 * provider disable setting. Disabled backends are omitted unless `includeDisabled` is set,
 * in which case they are reported with `enabled: false`.
 */
export function buildAgentBackendItems(params: Readonly<{
  settings: Record<string, unknown> | undefined;
  includeDisabled?: boolean;
  limit?: unknown;
}>): readonly AgentBackendItem[] {
  const items = AGENT_IDS.map((agentId) => {
    const backendTarget = { kind: 'builtInAgent', agentId } as const;
    return {
      targetKey: buildBackendTargetKey(backendTarget),
      label: getProviderCliRuntimeSpec(agentId).title,
      enabled: params.settings
        ? isBackendEnabledByAccountSettings({ backendTarget, settings: params.settings })
        : true,
      agentId,
    };
  }).filter((item) => params.includeDisabled === true || item.enabled);
  const limit = normalizeLimit(params.limit);
  return limit ? items.slice(0, limit) : items;
}

function normalizeLimit(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.min(200, Math.floor(parsed)));
}
