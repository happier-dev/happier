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
  activeProfileId: string | null;
  /** Enabled member profile ids (deduped) — drives pool-adoption suggestions. */
  memberProfileIds?: ReadonlyArray<string>;
  generation?: number;
  enabledMemberCount: number;
  autoSwitch: boolean;
  status: 'ready' | 'exhausted' | 'needs_members';
}>;

export type ConnectedServicesAccountGroupOptionsByServiceId = Readonly<Record<string, ConnectedServicesAccountGroupOption[]>>;

export type ConnectedServiceSessionBindingIntent = Readonly<{
  source: 'native' | 'connected';
  selection?: 'profile' | 'group';
  profileId?: string;
  groupId?: string;
}>;

export type ConnectedServiceSessionSelection = Readonly<
  | { selection: 'profile'; profileId: string }
  | { selection: 'group'; groupId: string }
>;

export type ConnectedServiceSessionSelectionResolution = Readonly<
  | { status: 'no_selection' }
  | { status: 'valid_selection'; selection: ConnectedServiceSessionSelection }
  | {
      status: 'explicit_unavailable';
      selection: ConnectedServiceSessionSelection;
      reason:
        | 'profile_unavailable'
        | 'account_groups_disabled'
        | 'group_unavailable'
        | 'group_not_ready'
        | 'group_active_profile_unavailable';
    }
>;

export type ConnectedServiceSessionSelectionAvailability = Readonly<
  | { kind: 'deferred' }
  | {
      kind: 'known';
      profileOptions: ReadonlyArray<ConnectedServicesProfileOption>;
      groupOptions: ReadonlyArray<ConnectedServicesAccountGroupOption>;
      accountGroupsEnabled: boolean;
    }
>;

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
  agentCore: { connectedServices?: { supportedServiceIds?: ReadonlyArray<ConnectedServiceId> } | null };
}>): ReadonlyArray<ConnectedServiceId> {
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

/**
 * Canonical session-binding semantic resolver.
 *
 * Explicit connected intent is never rewritten to native merely because current projection truth
 * cannot satisfy it. UI callers provide known availability for preflight; daemon/CLI writers that
 * intentionally defer authoritative validation use the explicit deferred variant.
 */
export function resolveConnectedServiceSessionSelection(params: Readonly<{
  serviceId: string;
  binding: ConnectedServiceSessionBindingIntent | null | undefined;
  availability: ConnectedServiceSessionSelectionAvailability;
  defaultProfileByServiceId?: Readonly<Record<string, string | undefined>>;
}>): ConnectedServiceSessionSelectionResolution {
  if (params.binding?.source !== 'connected') return { status: 'no_selection' };

  if (params.binding.selection === 'group') {
    const groupId = readString(params.binding.groupId);
    if (!groupId) return { status: 'no_selection' };
    const selection = { selection: 'group' as const, groupId };
    if (params.availability.kind === 'deferred') {
      return { status: 'valid_selection', selection };
    }
    if (!params.availability.accountGroupsEnabled) {
      return { status: 'explicit_unavailable', selection, reason: 'account_groups_disabled' };
    }
    const group = params.availability.groupOptions.find((candidate) => candidate.groupId === groupId);
    if (!group) {
      return { status: 'explicit_unavailable', selection, reason: 'group_unavailable' };
    }
    if (group.status !== 'ready') {
      return { status: 'explicit_unavailable', selection, reason: 'group_not_ready' };
    }
    const activeProfileId = readString(group.activeProfileId);
    const activeProfileAvailable = activeProfileId.length > 0
      && params.availability.profileOptions.some((option) => (
        option.profileId === activeProfileId && isConnectedServiceProfileOptionSelectable(option)
      ));
    return activeProfileAvailable
      ? { status: 'valid_selection', selection }
      : { status: 'explicit_unavailable', selection, reason: 'group_active_profile_unavailable' };
  }

  const explicitProfileId = readString(params.binding.profileId);
  if (explicitProfileId) {
    const selection = { selection: 'profile' as const, profileId: explicitProfileId };
    if (params.availability.kind === 'deferred') {
      return { status: 'valid_selection', selection };
    }
    const profileAvailable = params.availability.profileOptions.some((option) => (
      option.profileId === explicitProfileId && isConnectedServiceProfileOptionSelectable(option)
    ));
    return profileAvailable
      ? { status: 'valid_selection', selection }
      : { status: 'explicit_unavailable', selection, reason: 'profile_unavailable' };
  }

  if (params.availability.kind === 'deferred') return { status: 'no_selection' };
  const connectedProfileIds = params.availability.profileOptions
    .filter(isConnectedServiceProfileOptionSelectable)
    .map((option) => option.profileId);
  const profileId = resolveConnectedServiceDefaultProfileId({
    serviceId: params.serviceId,
    connectedProfileIds,
    defaultProfileByServiceId: params.defaultProfileByServiceId ?? {},
  });
  return profileId
    ? { status: 'valid_selection', selection: { selection: 'profile', profileId } }
    : { status: 'no_selection' };
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
        return {
          profileId,
          status: normalizeConnectedServiceCredentialHealthStatus(p.status),
          kind,
          providerEmail: p.providerEmail ?? null,
          label,
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
      const activeProfileId = readString(group.activeProfileId) || null;
      if (!groupId) continue;
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
