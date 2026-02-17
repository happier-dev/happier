import type { ConnectedServiceId } from '@happier-dev/agents';

import type {
  ConnectedServicesProfileOption,
  ConnectedServicesServiceBinding,
} from '@/components/sessions/new/components/ConnectedServicesAuthModal';
import { CONNECTED_SERVICES_BINDINGS_KEY } from '@/components/sessions/new/components/ConnectedServicesAuthModal';
import { filterConnectedServiceV2ProfilesForAgent } from '@/sync/domains/connectedServices/filterConnectedServiceV2ProfilesForAgent';
import {
  resolveConnectedServiceDefaultProfileId,
  resolveConnectedServiceProfileLabel,
} from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';

export type ConnectedServicesProfileOptionsByServiceId = Readonly<Record<string, ConnectedServicesProfileOption[]>>;

export type ConnectedServicesBindingsPayloadV1 = Readonly<{
  v: 1;
  bindingsByServiceId: Readonly<Record<string, { source: 'native' | 'connected'; profileId?: string }>>;
}>;

export function resolveAgentSupportedConnectedServiceIds(params: Readonly<{
  connectedServicesFeatureEnabled: boolean;
  agentCore: { connectedServices?: { supportedServiceIds?: ReadonlyArray<ConnectedServiceId> } | null };
}>): ReadonlyArray<ConnectedServiceId> {
  if (!params.connectedServicesFeatureEnabled) return [];
  return params.agentCore.connectedServices?.supportedServiceIds ?? [];
}

export function buildConnectedServiceProfileOptionsByServiceId(params: Readonly<{
  accountProfileConnectedServicesV2: ReadonlyArray<{ serviceId: ConnectedServiceId; profiles?: ReadonlyArray<any> }>;
  agentCore: any;
  supportedConnectedServiceIds: ReadonlyArray<ConnectedServiceId>;
  labelsByKey: Record<string, string | undefined>;
}>): ConnectedServicesProfileOptionsByServiceId {
  const out: Record<string, ConnectedServicesProfileOption[]> = {};
  const rows = params.accountProfileConnectedServicesV2 ?? [];

  for (const entry of rows) {
    const serviceId = entry.serviceId;
    if (params.supportedConnectedServiceIds.length > 0 && !params.supportedConnectedServiceIds.includes(serviceId)) continue;
    const rawProfiles = entry.profiles ?? [];
    const profiles = filterConnectedServiceV2ProfilesForAgent({
      agentCore: params.agentCore,
      serviceId,
      profiles: rawProfiles,
    });
    out[serviceId] = profiles
      .map((p): ConnectedServicesProfileOption => {
        const profileId = String(p.profileId ?? '').trim();
        const label = profileId
          ? resolveConnectedServiceProfileLabel({
              labelsByKey: params.labelsByKey,
              serviceId,
              profileId,
            })
          : null;
        return {
          profileId,
          status: p.status === 'connected' ? 'connected' : 'needs_reauth',
          providerEmail: p.providerEmail ?? null,
          label,
        };
      })
      .filter((p) => p.profileId.length > 0);
  }

  return out;
}

export function parseConnectedServicesBindingsByServiceIdFromAgentOptionState(params: Readonly<{
  agentOptionState: Record<string, unknown> | null;
}>): Readonly<Record<string, ConnectedServicesServiceBinding | undefined>> {
  const raw = params.agentOptionState?.[CONNECTED_SERVICES_BINDINGS_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, ConnectedServicesServiceBinding | undefined>;
}

export function buildConnectedServicesBindingsPayload(params: Readonly<{
  supportedConnectedServiceIds: ReadonlyArray<ConnectedServiceId>;
  connectedServiceProfileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
  connectedServicesBindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
  defaultProfileByServiceId: Record<string, string | undefined>;
}>): ConnectedServicesBindingsPayloadV1 | null {
  if (params.supportedConnectedServiceIds.length === 0) return null;

  const bindingsByServiceId: Record<string, { source: 'native' | 'connected'; profileId?: string }> = {};
  let connectedCount = 0;

  for (const serviceId of params.supportedConnectedServiceIds) {
    const options = params.connectedServiceProfileOptionsByServiceId[serviceId] ?? [];
    const connected = options.filter((o) => o.status === 'connected');
    const binding = params.connectedServicesBindingsByServiceId[serviceId];
    const mode = binding?.source === 'connected' ? 'connected' : 'native';

    if (mode === 'connected') {
      if (connected.length === 0) {
        bindingsByServiceId[serviceId] = { source: 'native' };
        continue;
      }
      const connectedProfileIds = connected.map((o) => o.profileId);
      const explicit = (binding?.profileId ?? '').trim();
      const selected =
        explicit && connectedProfileIds.includes(explicit)
          ? explicit
          : resolveConnectedServiceDefaultProfileId({
              serviceId,
              connectedProfileIds,
              defaultProfileByServiceId: params.defaultProfileByServiceId,
            }) ?? connected[0]!.profileId;
      if (!selected) {
        bindingsByServiceId[serviceId] = { source: 'native' };
        continue;
      }
      bindingsByServiceId[serviceId] = { source: 'connected', profileId: selected };
      connectedCount += 1;
      continue;
    }

    bindingsByServiceId[serviceId] = { source: 'native' };
  }

  return connectedCount > 0 ? { v: 1, bindingsByServiceId } : null;
}
