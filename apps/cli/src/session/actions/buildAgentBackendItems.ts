import {
  AGENT_IDS,
  getProviderCliRuntimeSpec,
  type AgentId,
} from '@happier-dev/agents';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import { resolveProviderCliCommand } from '@happier-dev/cli-common/providers';

import { isBackendEnabledByAccountSettings } from '@/settings/backendEnabled';

export type AgentBackendItem = Readonly<{
  targetKey: string;
  label: string;
  enabled: boolean;
  agentId: AgentId;
}>;

/**
 * Inventory for `agents.backends.list`: every catalog backend, filtered by the account's
 * provider disable setting and by local CLI availability. Disabled backends are omitted
 * unless `includeDisabled` is set (reported with `enabled: false`); backends whose CLI
 * cannot be resolved on this machine are omitted so agents choose only launchable targets.
 */
export function buildAgentBackendItems(params: Readonly<{
  settings: Record<string, unknown> | undefined;
  includeDisabled?: boolean;
  limit?: unknown;
  processEnv?: NodeJS.ProcessEnv;
}>): readonly AgentBackendItem[] {
  const processEnv = params.processEnv ?? process.env;
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
  })
    .filter((item) => params.includeDisabled === true || item.enabled)
    .filter((item) => Boolean(resolveProviderCliCommand(item.agentId, { processEnv })));
  const limit = normalizeLimit(params.limit);
  return limit ? items.slice(0, limit) : items;
}

function normalizeLimit(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.min(200, Math.floor(parsed)));
}
