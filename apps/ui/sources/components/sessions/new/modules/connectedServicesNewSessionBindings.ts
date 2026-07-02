import type { AgentCore, ConnectedServiceId, ConnectedServiceKind } from '@happier-dev/agents';
import {
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceBindingSelectionV1,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { isConnectedServiceProfileKindSupportedForAgent } from '@/sync/domains/connectedServices/filterConnectedServiceV2ProfilesForAgent';
import {
  resolveConnectedServiceDefaultProfileId,
  resolveConnectedServiceProfileLabel,
} from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';

export type ConnectedServicesProfileOption = Readonly<{
  profileId: string;
  status: 'connected' | 'needs_reauth' | 'unsupported_kind';
  kind?: 'oauth' | 'token' | null;
  providerEmail?: string | null;
  label?: string | null;
  unsupportedSubtitleKey?:
    | 'connectedServices.defaultAuth.warning.connected_service_unsupported'
    | 'connectedServices.detail.connectSetupTokenSubtitle';
}>;

type ConnectedServiceV2ProfileProjection = Readonly<{
  profileId: string;
  status: 'connected' | 'refreshing' | 'needs_reauth' | 'refresh_failed_retryable';
  kind?: ConnectedServiceKind | null;
  providerEmail?: string | null;
}>;

export type ConnectedServicesProfileOptionsByServiceId = Readonly<Record<string, ConnectedServicesProfileOption[]>>;

export type ConnectedServicesAccountGroupOption = Readonly<{
  groupId: string;
  label: string;
  activeProfileId: string;
  generation?: number;
  enabledMemberCount: number;
  autoSwitch: boolean;
  status: 'ready' | 'exhausted' | 'needs_members';
}>;

export type ConnectedServicesAccountGroupOptionsByServiceId = Readonly<Record<string, ConnectedServicesAccountGroupOption[]>>;

export function resolveAgentSupportedConnectedServiceIds(params: Readonly<{
  connectedServicesFeatureEnabled: boolean;
  agentCore: { connectedServices?: { supportedServiceIds?: ReadonlyArray<ConnectedServiceId> } | null };
}>): ReadonlyArray<ConnectedServiceId> {
  if (!params.connectedServicesFeatureEnabled) return [];
  return params.agentCore.connectedServices?.supportedServiceIds ?? [];
}

function normalizeConnectedServiceKind(kind: ConnectedServiceKind | null | undefined): 'oauth' | 'token' | null {
  if (kind === 'oauth' || kind === 'token') return kind;
  return null;
}

function resolveUnsupportedProfileSubtitleKey(serviceId: ConnectedServiceId):
  | 'connectedServices.defaultAuth.warning.connected_service_unsupported'
  | 'connectedServices.detail.connectSetupTokenSubtitle' {
  const entry = getConnectedServiceRegistryEntry(serviceId);
  return entry.supportsToken && entry.tokenKind === 'setup-token'
    ? 'connectedServices.detail.connectSetupTokenSubtitle'
    : 'connectedServices.defaultAuth.warning.connected_service_unsupported';
}

export function buildConnectedServiceProfileOptionsByServiceId(params: Readonly<{
  accountProfileConnectedServicesV2: ReadonlyArray<{ serviceId: ConnectedServiceId; profiles?: ReadonlyArray<ConnectedServiceV2ProfileProjection> }>;
  agentCore: Pick<AgentCore, 'connectedServices'> | null;
  supportedConnectedServiceIds: ReadonlyArray<ConnectedServiceId>;
  labelsByKey: Record<string, string | undefined>;
}>): ConnectedServicesProfileOptionsByServiceId {
  const out: Record<string, ConnectedServicesProfileOption[]> = {};
  const rows = params.accountProfileConnectedServicesV2 ?? [];

  for (const entry of rows) {
    const serviceId = entry.serviceId;
    if (params.supportedConnectedServiceIds.length > 0 && !params.supportedConnectedServiceIds.includes(serviceId)) continue;
    const rawProfiles = entry.profiles ?? [];
    out[serviceId] = rawProfiles
      .map((p): ConnectedServicesProfileOption => {
        const profileId = String(p.profileId ?? '').trim();
        const label = profileId
          ? resolveConnectedServiceProfileLabel({
              labelsByKey: params.labelsByKey,
              serviceId,
              profileId,
            })
          : null;
        const kind = normalizeConnectedServiceKind(p.kind);
        const kindSupported = isConnectedServiceProfileKindSupportedForAgent({
          agentCore: params.agentCore,
          serviceId,
          kind,
        });
        return {
          profileId,
          status: kindSupported
            ? p.status === 'connected' ? 'connected' : 'needs_reauth'
            : 'unsupported_kind',
          kind,
          providerEmail: p.providerEmail ?? null,
          label,
          ...(kindSupported ? {} : { unsupportedSubtitleKey: resolveUnsupportedProfileSubtitleKey(serviceId) }),
        };
      })
      .filter((p) => p.profileId.length > 0);
  }

  return out;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readGroupEnabledMemberCount(rawGroup: Record<string, unknown>): number {
  const explicitCount = readNumber(rawGroup.enabledMemberCount);
  if (explicitCount > 0) return explicitCount;

  const memberProfileIds = Array.isArray(rawGroup.memberProfileIds) ? rawGroup.memberProfileIds : [];
  const memberProfileIdCount = memberProfileIds.filter((profileId) => readString(profileId).length > 0).length;
  if (memberProfileIdCount > 0) return memberProfileIdCount;

  const members = Array.isArray(rawGroup.members) ? rawGroup.members : [];
  return members.filter((member) => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) return false;
    return (member as { enabled?: unknown }).enabled !== false;
  }).length;
}

function readGroupAutoSwitch(rawGroup: Record<string, unknown>): boolean {
  if (typeof rawGroup.autoSwitch === 'boolean') return rawGroup.autoSwitch;
  const policy = rawGroup.policy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return false;
  return readBoolean((policy as { autoSwitch?: unknown }).autoSwitch);
}

function readGroupStatus(rawGroup: Record<string, unknown>): ConnectedServicesAccountGroupOption['status'] {
  const state = rawGroup.state;
  const normalizedStateStatus =
    state && typeof state === 'object' && !Array.isArray(state)
      ? readString((state as { status?: unknown }).status)
      : '';
  const normalizedLegacyStatus = readString(rawGroup.status);
  const normalizedStatus = normalizedStateStatus || normalizedLegacyStatus;
  if (normalizedStatus === 'exhausted') return 'exhausted';
  return 'ready';
}

export function buildConnectedServiceAccountGroupOptionsByServiceId(params: Readonly<{
  accountGroupsFeatureEnabled: boolean;
  accountProfileConnectedServicesV2: ReadonlyArray<{ serviceId: ConnectedServiceId; groups?: unknown }>;
  supportedConnectedServiceIds: ReadonlyArray<ConnectedServiceId>;
}>): ConnectedServicesAccountGroupOptionsByServiceId {
  if (!params.accountGroupsFeatureEnabled) return {};

  const out: Record<string, ConnectedServicesAccountGroupOption[]> = {};
  for (const entry of params.accountProfileConnectedServicesV2) {
    const serviceId = entry.serviceId;
    if (params.supportedConnectedServiceIds.length > 0 && !params.supportedConnectedServiceIds.includes(serviceId)) continue;

    const groups: ConnectedServicesAccountGroupOption[] = [];
    const rawGroups = Array.isArray(entry.groups) ? entry.groups : [];
    for (const rawGroup of rawGroups) {
      if (!rawGroup || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) continue;
      const group = rawGroup as Record<string, unknown>;
      const groupId = readString(group.groupId);
      const activeProfileId = readString(group.activeProfileId);
      if (!groupId || !activeProfileId) continue;
      const enabledMemberCount = readGroupEnabledMemberCount(group);
      const generation = typeof group.generation === 'number' && Number.isInteger(group.generation) && group.generation >= 0
        ? group.generation
        : null;

      groups.push({
        groupId,
        label: readString(group.displayName) || readString(group.label) || groupId,
        activeProfileId,
        ...(generation === null ? {} : { generation }),
        enabledMemberCount,
        autoSwitch: readGroupAutoSwitch(group),
        status: enabledMemberCount <= 0
          ? 'needs_members'
          : readGroupStatus(group),
      });
    }

    if (groups.length > 0) {
      out[serviceId] = groups;
    }
  }

  return out;
}

export function buildConnectedServicesBindingsPayload(params: Readonly<{
  supportedConnectedServiceIds: ReadonlyArray<ConnectedServiceId>;
  connectedServiceProfileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
  connectedServiceAccountGroupOptionsByServiceId?: ConnectedServicesAccountGroupOptionsByServiceId;
  connectedServicesBindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
  defaultProfileByServiceId: Record<string, string | undefined>;
  accountGroupsFeatureEnabled?: boolean;
}>): ConnectedServiceBindingsV1 | null {
  if (params.supportedConnectedServiceIds.length === 0) return null;

  const bindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV1> = {};
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
      if (binding?.selection === 'group') {
        if (params.accountGroupsFeatureEnabled === false) {
          bindingsByServiceId[serviceId] = { source: 'native' };
          continue;
        }

        const groupId = readString(binding.groupId);
        const selectedGroup = (params.connectedServiceAccountGroupOptionsByServiceId?.[serviceId] ?? [])
          .find((group) => group.groupId === groupId);
        const activeProfileId = readString(selectedGroup?.activeProfileId);
        if (
          selectedGroup
          && selectedGroup.status === 'ready'
          && activeProfileId
          && connectedProfileIds.includes(activeProfileId)
        ) {
          bindingsByServiceId[serviceId] = {
            source: 'connected',
            selection: 'group',
            groupId,
          };
          connectedCount += 1;
          continue;
        }

        bindingsByServiceId[serviceId] = { source: 'native' };
        continue;
      }

      const explicit = binding?.source === 'connected' && binding.selection === 'profile'
        ? readString(binding.profileId)
        : '';
      if (explicit && !connectedProfileIds.includes(explicit)) {
        bindingsByServiceId[serviceId] = { source: 'native' };
        continue;
      }
      const selected =
        explicit
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
      bindingsByServiceId[serviceId] = { source: 'connected', selection: 'profile', profileId: selected };
      connectedCount += 1;
      continue;
    }

    bindingsByServiceId[serviceId] = { source: 'native' };
  }

  return connectedCount > 0 ? ConnectedServiceBindingsV1Schema.parse({ v: 1, bindingsByServiceId }) : null;
}
