import {
  isConnectedServiceCredentialHealthStatusUsable,
  normalizeConnectedServiceCredentialHealthStatus,
  type ConnectedServiceCredentialHealthStatusV1,
} from '@happier-dev/protocol';

import type { AgentCore, ConnectedServiceId, ConnectedServiceKind } from '../types.js';

export type ConnectedServicesProfileOption = Readonly<{
  profileId: string;
  status: ConnectedServiceCredentialHealthStatusV1 | 'unsupported_kind';
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
  /** Enabled member profile ids (deduped) — drives pool-adoption suggestions. */
  memberProfileIds?: ReadonlyArray<string>;
  generation?: number;
  enabledMemberCount: number;
  autoSwitch: boolean;
  status: 'ready' | 'exhausted' | 'needs_members';
}>;

export type ConnectedServicesAccountGroupOptionsByServiceId = Readonly<Record<string, ConnectedServicesAccountGroupOption[]>>;

export function connectedServiceProfileKey(params: Readonly<{ serviceId: string; profileId: string }>): string {
  const serviceId = encodeURIComponent(String(params.serviceId).trim());
  const profileId = encodeURIComponent(String(params.profileId).trim());
  return `${serviceId}/${profileId}`;
}

function connectedServiceProfileLegacyKey(params: Readonly<{ serviceId: string; profileId: string }>): string {
  return `${String(params.serviceId).trim()}/${String(params.profileId).trim()}`;
}

export function resolveConnectedServiceProfileLabel(params: Readonly<{
  labelsByKey: Readonly<Record<string, string | undefined>>;
  serviceId: string;
  profileId: string;
}>): string | null {
  const key = connectedServiceProfileKey({ serviceId: params.serviceId, profileId: params.profileId });
  const raw = params.labelsByKey[key]
    ?? params.labelsByKey[connectedServiceProfileLegacyKey({ serviceId: params.serviceId, profileId: params.profileId })];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

export function resolveConnectedServiceDefaultProfileId(params: Readonly<{
  serviceId: string;
  connectedProfileIds: ReadonlyArray<string>;
  defaultProfileByServiceId: Readonly<Record<string, string | undefined>>;
}>): string | null {
  const fallback = params.connectedProfileIds[0] ?? null;
  if (!fallback) return null;
  const preferredRaw = params.defaultProfileByServiceId[String(params.serviceId).trim()];
  const preferred = typeof preferredRaw === 'string' ? preferredRaw.trim() : '';
  if (!preferred) return fallback;
  return params.connectedProfileIds.includes(preferred) ? preferred : fallback;
}

export function resolveAgentSupportedConnectedServiceIds(params: Readonly<{
  connectedServicesFeatureEnabled: boolean;
  agentCore: { connectedServices?: { supportedServiceIds?: ReadonlyArray<ConnectedServiceId> } | null };
}>): ReadonlyArray<ConnectedServiceId> {
  if (!params.connectedServicesFeatureEnabled) return [];
  return params.agentCore.connectedServices?.supportedServiceIds ?? [];
}

export function isConnectedServiceProfileStatusSelectable(
  status: ConnectedServicesProfileOption['status'],
): boolean {
  return status !== 'unsupported_kind'
    && isConnectedServiceCredentialHealthStatusUsable(status);
}

export function isConnectedServiceProfileOptionSelectable(
  option: Pick<ConnectedServicesProfileOption, 'status'>,
): boolean {
  return isConnectedServiceProfileStatusSelectable(option.status);
}

export function isConnectedServiceProfileKindSupportedForAgent(params: Readonly<{
  agentCore: Pick<AgentCore, 'connectedServices'> | null;
  serviceId: ConnectedServiceId;
  kind: ConnectedServiceKind | null;
}>): boolean {
  const allowedKinds = params.agentCore?.connectedServices?.supportedKindsByServiceId?.[params.serviceId];
  if (!Array.isArray(allowedKinds) || allowedKinds.length === 0) return true;
  if (!params.kind) return true;

  const allowed = new Set<ConnectedServiceKind>(allowedKinds);
  return allowed.has(params.kind);
}

export function filterConnectedServiceV2ProfilesForAgent(params: Readonly<{
  agentCore: Pick<AgentCore, 'connectedServices'> | null;
  serviceId: ConnectedServiceId;
  profiles: ReadonlyArray<ConnectedServiceV2ProfileProjection>;
}>): ReadonlyArray<ConnectedServiceV2ProfileProjection> {
  return params.profiles.filter((profile) => isConnectedServiceProfileKindSupportedForAgent({
    agentCore: params.agentCore,
    serviceId: params.serviceId,
    kind: profile.kind ?? null,
  }));
}

function normalizeConnectedServiceKind(kind: ConnectedServiceKind | null | undefined): 'oauth' | 'token' | null {
  if (kind === 'oauth' || kind === 'token') return kind;
  return null;
}

export function buildConnectedServiceProfileOptionsByServiceId(params: Readonly<{
  accountProfileConnectedServicesV2: ReadonlyArray<{
    serviceId: ConnectedServiceId;
    profiles?: ReadonlyArray<ConnectedServiceV2ProfileProjection>;
  }>;
  agentCore: Pick<AgentCore, 'connectedServices'> | null;
  supportedConnectedServiceIds: ReadonlyArray<ConnectedServiceId>;
  labelsByKey: Record<string, string | undefined>;
  resolveUnsupportedSubtitleKey?: (serviceId: ConnectedServiceId) => ConnectedServicesProfileOption['unsupportedSubtitleKey'] | null | undefined;
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
        const unsupportedSubtitleKey = kindSupported ? null : params.resolveUnsupportedSubtitleKey?.(serviceId) ?? null;
        return {
          profileId,
          status: kindSupported
            ? normalizeConnectedServiceCredentialHealthStatus(p.status)
            : 'unsupported_kind',
          kind,
          providerEmail: p.providerEmail ?? null,
          label,
          ...(unsupportedSubtitleKey ? { unsupportedSubtitleKey } : {}),
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

function readGroupMemberProfileIds(rawGroup: Record<string, unknown>): ReadonlyArray<string> {
  const memberProfileIds = Array.isArray(rawGroup.memberProfileIds) ? rawGroup.memberProfileIds : [];
  const projectedIds = memberProfileIds
    .map(readString)
    .filter(Boolean);
  if (projectedIds.length > 0) return Array.from(new Set(projectedIds));

  const members = Array.isArray(rawGroup.members) ? rawGroup.members : [];
  const memberIds = members
    .map((member) => {
      if (!member || typeof member !== 'object' || Array.isArray(member)) return '';
      if ((member as { enabled?: unknown }).enabled === false) return '';
      return readString((member as { profileId?: unknown }).profileId);
    })
    .filter(Boolean);
  return Array.from(new Set(memberIds));
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

      const memberProfileIds = readGroupMemberProfileIds(group);
      groups.push({
        groupId,
        label: readString(group.displayName) || readString(group.label) || groupId,
        activeProfileId,
        ...(memberProfileIds.length > 0 ? { memberProfileIds } : {}),
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
