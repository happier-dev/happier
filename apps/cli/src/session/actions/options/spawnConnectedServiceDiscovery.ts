import {
  AGENTS_CORE,
  buildConnectedServiceAccountGroupOptionsByServiceId,
  buildConnectedServiceProfileOptionsByServiceId,
  resolveAgentIdFromFlavor,
  resolveAgentSupportedConnectedServiceIds,
  resolveConnectedServiceDefaultProfileId,
  type AgentCore,
  type ConnectedServiceId,
} from '@happier-dev/agents';
import type { AccountProfileResponse, AccountSettings, ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';

import { listConnectedServiceAuthGroups } from '@/api/connectedServices/connectedServiceCredentialApi';
import { logger } from '@/ui/logger';

import { normalizeActionOptionLimit } from './actionOptionInputNormalization';

export type SpawnConnectedServiceOptionItem = Readonly<{
  value: string;
  label: string;
  serviceId: ConnectedServiceId;
  profiles: ReturnType<typeof buildConnectedServiceProfileOptionsByServiceId>[string];
  accountGroups: ReturnType<typeof buildConnectedServiceAccountGroupOptionsByServiceId>[string];
  defaultProfileId?: string;
}>;

function readStringRecord(value: unknown): Record<string, string | undefined> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string | undefined> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') out[key] = raw;
  }
  return out;
}

function resolveAgentCore(agentId: unknown): AgentCore {
  const resolved = resolveAgentIdFromFlavor(agentId) ?? 'claude';
  return AGENTS_CORE[resolved];
}

export async function listSpawnConnectedServiceItems(params: Readonly<{
  token: string;
  accountSettings: AccountSettings | Readonly<Record<string, unknown>>;
  accountProfile: AccountProfileResponse;
  agentId?: string | null;
  connectedServicesFeatureEnabled: boolean;
  accountGroupsFeatureEnabled: boolean;
  includeUnavailable?: boolean;
  limit?: unknown;
}>): Promise<Readonly<{ items: readonly SpawnConnectedServiceOptionItem[] }>> {
  const settingsRecord = params.accountSettings as Readonly<Record<string, unknown>>;
  const agentCore = resolveAgentCore(params.agentId);
  const supportedConnectedServiceIds = resolveAgentSupportedConnectedServiceIds({
    connectedServicesFeatureEnabled: params.connectedServicesFeatureEnabled,
    agentCore,
  });
  const profileOptionsByServiceId = buildConnectedServiceProfileOptionsByServiceId({
    accountProfileConnectedServicesV2: params.accountProfile.connectedServicesV2,
    agentCore,
    supportedConnectedServiceIds,
    labelsByKey: readStringRecord(settingsRecord.connectedServicesProfileLabelByKey),
  });
  const accountGroupsByServiceId: Record<string, readonly ConnectedServiceAuthGroupV1[]> = {};
  if (params.accountGroupsFeatureEnabled && agentCore.connectedServices?.sessionAuthSwitch) {
    await Promise.all(supportedConnectedServiceIds.map(async (serviceId) => {
      const projection = params.accountProfile.connectedServicesV2.find((entry) => entry.serviceId === serviceId);
      if (!projection?.groups.length) return;
      try {
        accountGroupsByServiceId[serviceId] = await listConnectedServiceAuthGroups({ token: params.token, serviceId });
      } catch {
        // API diagnostics are debug-only in runner processes. Make this degraded read observable by default.
        logger.warnFile('[connected-services] Pool policy unavailable; listing projected choices with unknown autoSwitch', { serviceId });
      }
    }));
  }
  const accountGroupOptionsByServiceId = buildConnectedServiceAccountGroupOptionsByServiceId({
    accountGroupsFeatureEnabled: params.accountGroupsFeatureEnabled,
    accountProfileConnectedServicesV2: params.accountProfile.connectedServicesV2,
    supportedConnectedServiceIds,
    accountGroupsByServiceId,
  });
  const defaultProfileByServiceId = readStringRecord(settingsRecord.connectedServicesDefaultProfileByServiceId);

  const items: SpawnConnectedServiceOptionItem[] = [];
  for (const serviceId of supportedConnectedServiceIds) {
    const profiles = profileOptionsByServiceId[serviceId] ?? [];
    const accountGroups = params.accountGroupsFeatureEnabled && agentCore.connectedServices?.sessionAuthSwitch
      ? accountGroupOptionsByServiceId[serviceId] ?? []
      : [];
    if (params.includeUnavailable !== true && profiles.length === 0 && accountGroups.length === 0) {
      continue;
    }
    const connectedProfileIds = profiles
      .filter((profile) => profile.status === 'connected')
      .map((profile) => profile.profileId);
    const defaultProfileId = resolveConnectedServiceDefaultProfileId({
      serviceId,
      connectedProfileIds,
      defaultProfileByServiceId,
    });
    items.push({
      value: serviceId,
      label: serviceId,
      serviceId,
      profiles,
      accountGroups,
      ...(defaultProfileId ? { defaultProfileId } : {}),
    });
  }

  const explicitLimit = normalizeActionOptionLimit(params.limit);
  const sorted = items.sort((left, right) => left.serviceId.localeCompare(right.serviceId));
  const limited = explicitLimit ? sorted.slice(0, explicitLimit) : sorted;
  return { items: limited };
}
