import {
    ConnectedServiceBindingsV1Schema,
    isConnectedServiceCredentialHealthStatusUsable,
    normalizeConnectedServiceCredentialHealthStatus,
    type ConnectedServiceCredentialHealthStatusV1,
    type ConnectedServiceBindingSelectionV1,
    type ConnectedServiceBindingsV1,
    type ConnectedServiceAuthGroupV1,
} from '@happier-dev/protocol';

import type { AgentCore, ConnectedServiceId, ConnectedServiceKind } from '../types.js';

export type ConnectedServicesSessionAgentConnectedServices = Readonly<{
    supportedServiceIds?: ReadonlyArray<ConnectedServiceId>;
    supportedKindsByServiceId?: NonNullable<AgentCore['connectedServices']>['supportedKindsByServiceId'];
    sessionAuthSwitch?: NonNullable<AgentCore['connectedServices']>['sessionAuthSwitch'];
}>;

export type ConnectedServicesSessionAgentCore = Readonly<{
    id?: string;
    connectedServices?: ConnectedServicesSessionAgentConnectedServices | null;
}>;

export type ConnectedServiceProfileProjectionInput = Readonly<{
    profileId: string;
    status: string;
    kind?: ConnectedServiceKind | null;
    providerEmail?: string | null;
}>;

type ConnectedServiceProfileFilterProjection = Readonly<{
    profileId: string;
    status: ConnectedServiceCredentialHealthStatusV1;
    kind?: ConnectedServiceKind | null;
    providerEmail?: string | null;
}>;

export type ConnectedServiceSessionProjection = Readonly<{
    serviceId: ConnectedServiceId;
    profiles?: ReadonlyArray<ConnectedServiceProfileProjectionInput>;
    groups?: unknown;
}>;

export type ConnectedServicesProfileOption = Readonly<{
    profileId: string;
    status: ConnectedServiceCredentialHealthStatusV1 | 'unsupported_kind';
    kind?: 'oauth' | 'token' | null;
    providerEmail?: string | null;
    label?: string | null;
}>;

export type ConnectedServicesProfileOptionsByServiceId = Readonly<Record<string, ConnectedServicesProfileOption[]>>;

export type ConnectedServicesAccountGroupReadiness =
    | 'ready'
    | 'exhausted'
    | 'needs_members'
    | 'switching'
    | 'error'
    | 'unknown';

export type ConnectedServicesAccountGroupOption = Readonly<{
    groupId: string;
    label: string;
    activeProfileId: string;
    memberProfileIds?: ReadonlyArray<string>;
    generation?: number;
    enabledMemberCount: number;
    /** Null means the authoritative V3 policy could not be established. */
    autoSwitch: boolean | null;
    status: ConnectedServicesAccountGroupReadiness;
}>;

export type ConnectedServicesAccountGroupOptionsByServiceId = Readonly<Record<string, ConnectedServicesAccountGroupOption[]>>;

export type ConnectedServicesBindingOptionInput = Readonly<{
    source?: string;
    selection?: string;
    profileId?: string;
    groupId?: string;
}>;

export function connectedServiceProfileKey(params: Readonly<{ serviceId: string; profileId: string }>): string {
    const serviceId = encodeURIComponent(String(params.serviceId).trim());
    const profileId = encodeURIComponent(String(params.profileId).trim());
    return `${serviceId}/${profileId}`;
}

export function connectedServiceProfileLegacyKey(params: Readonly<{ serviceId: string; profileId: string }>): string {
    return `${String(params.serviceId).trim()}/${String(params.profileId).trim()}`;
}

export function resolveConnectedServiceProfileLabel(params: Readonly<{
    labelsByKey: Readonly<Record<string, string | undefined>>;
    serviceId: string;
    profileId: string;
}>): string | null {
    const raw = params.labelsByKey[connectedServiceProfileKey({
        serviceId: params.serviceId,
        profileId: params.profileId,
    })] ?? params.labelsByKey[connectedServiceProfileLegacyKey({
        serviceId: params.serviceId,
        profileId: params.profileId,
    })];
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
    agentCore: ConnectedServicesSessionAgentCore | null;
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
    agentCore: ConnectedServicesSessionAgentCore | null;
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<ConnectedServiceProfileFilterProjection>;
}>): ReadonlyArray<ConnectedServiceProfileFilterProjection> {
    return params.profiles.filter((profile) => isConnectedServiceProfileKindSupportedForAgent({
        agentCore: params.agentCore,
        serviceId: params.serviceId,
        kind: profile.kind ?? null,
    }));
}

export function resolveAgentSupportedConnectedServiceIds(params: Readonly<{
    connectedServicesFeatureEnabled: boolean;
    agentCore: ConnectedServicesSessionAgentCore;
}>): ReadonlyArray<ConnectedServiceId> {
    if (!params.connectedServicesFeatureEnabled) return [];
    return params.agentCore.connectedServices?.supportedServiceIds ?? [];
}

export function buildConnectedServiceProfileOptionsByServiceId(params: Readonly<{
    accountProfileConnectedServicesV2: ReadonlyArray<ConnectedServiceSessionProjection>;
    agentCore: ConnectedServicesSessionAgentCore;
    supportedConnectedServiceIds: ReadonlyArray<ConnectedServiceId>;
    labelsByKey: Record<string, string | undefined>;
}>): ConnectedServicesProfileOptionsByServiceId {
    const out: Record<string, ConnectedServicesProfileOption[]> = {};
    const rows = params.accountProfileConnectedServicesV2 ?? [];

    for (const entry of rows) {
        const serviceId = entry.serviceId;
        if (params.supportedConnectedServiceIds.length > 0 && !params.supportedConnectedServiceIds.includes(serviceId)) continue;
        const rawProfiles: ConnectedServiceProfileFilterProjection[] = (entry.profiles ?? []).map((profile) => ({
            profileId: profile.profileId,
            status: normalizeConnectedServiceCredentialHealthStatus(profile.status),
            kind: profile.kind ?? null,
            providerEmail: profile.providerEmail ?? null,
        }));
        out[serviceId] = rawProfiles
            .map((profile): ConnectedServicesProfileOption => {
                const profileId = String(profile.profileId ?? '').trim();
                const label = profileId
                    ? resolveConnectedServiceProfileLabel({
                        labelsByKey: params.labelsByKey,
                        serviceId,
                        profileId,
                    })
                    : null;
                const kind = profile.kind === 'token' ? 'token' : profile.kind === 'oauth' ? 'oauth' : null;
                const kindSupported = isConnectedServiceProfileKindSupportedForAgent({
                    agentCore: params.agentCore,
                    serviceId,
                    kind,
                });
                return {
                    profileId,
                    status: kindSupported
                        ? profile.status
                        : 'unsupported_kind',
                    kind,
                    providerEmail: profile.providerEmail ?? null,
                    label,
                };
            })
            .filter((profile) => profile.profileId.length > 0);
    }

    return out;
}

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
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

function readGroupAutoSwitch(rawGroup: Record<string, unknown>): boolean | null {
    const policy = rawGroup.policy;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;
    const autoSwitch = (policy as { autoSwitch?: unknown }).autoSwitch;
    return typeof autoSwitch === 'boolean' ? autoSwitch : null;
}

function readGroupStatus(rawGroup: Record<string, unknown>): Exclude<ConnectedServicesAccountGroupReadiness, 'needs_members'> {
    const state = rawGroup.state;
    const stateStatus = state && typeof state === 'object' && !Array.isArray(state)
        ? readString((state as { status?: unknown }).status)
        : '';
    const status = stateStatus || readString(rawGroup.status);
    if (status === 'exhausted') return 'exhausted';
    if (status === 'switching') return 'switching';
    if (status === 'error') return 'error';
    if (status === 'unknown') return 'unknown';
    return 'ready';
}

export function buildConnectedServiceAccountGroupOptionsByServiceId(params: Readonly<{
    accountGroupsFeatureEnabled: boolean;
    accountProfileConnectedServicesV2: ReadonlyArray<ConnectedServiceSessionProjection>;
    supportedConnectedServiceIds: ReadonlyArray<ConnectedServiceId>;
    /** Only consumers of policy need to load V3 groups. Missing entries retain the profile projection with unknown policy. */
    accountGroupsByServiceId?: Readonly<Record<string, ReadonlyArray<ConnectedServiceAuthGroupV1> | undefined>>;
}>): ConnectedServicesAccountGroupOptionsByServiceId {
    if (!params.accountGroupsFeatureEnabled) return {};

    const out: Record<string, ConnectedServicesAccountGroupOption[]> = {};

    for (const entry of params.accountProfileConnectedServicesV2 ?? []) {
        const serviceId = entry.serviceId;
        if (params.supportedConnectedServiceIds.length > 0 && !params.supportedConnectedServiceIds.includes(serviceId)) continue;
        const authoritativeGroups = params.accountGroupsByServiceId?.[serviceId];
        const rawGroups = authoritativeGroups ?? (Array.isArray(entry.groups) ? entry.groups : []);
        const groups: ConnectedServicesAccountGroupOption[] = [];
        for (const rawGroup of rawGroups) {
            if (!rawGroup || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) continue;
            const group = rawGroup as Record<string, unknown>;
            const groupId = readString(group.groupId);
            const activeProfileId = readString(group.activeProfileId);
            if (!groupId || !activeProfileId) continue;
            const enabledMemberCount = readGroupEnabledMemberCount(group);
            const memberProfileIds = readGroupMemberProfileIds(group);
            const generation = typeof group.generation === 'number' && Number.isInteger(group.generation) && group.generation >= 0
                ? group.generation
                : null;
            groups.push({
                groupId,
                label: readString(group.displayName) || readString(group.label) || groupId,
                activeProfileId,
                ...(memberProfileIds.length > 0 ? { memberProfileIds } : {}),
                ...(generation === null ? {} : { generation }),
                enabledMemberCount,
                autoSwitch: authoritativeGroups ? readGroupAutoSwitch(group) : null,
                status: enabledMemberCount <= 0
                    ? 'needs_members'
                    : readGroupStatus(group),
            });
        }
        out[serviceId] = groups;
    }

    return out;
}

export function resolveConnectedServiceAccountGroupViableProfileId(params: Readonly<{
    group: ConnectedServicesAccountGroupOption;
    connectedProfileIds: ReadonlyArray<string>;
}>): string | null {
    if (params.group.status !== 'ready') return null;
    const connectedProfileIdSet = new Set(params.connectedProfileIds.map((profileId) => profileId.trim()).filter(Boolean));
    if (connectedProfileIdSet.size === 0) return null;

    const memberProfileIds = (params.group.memberProfileIds ?? []).map((profileId) => profileId.trim()).filter(Boolean);
    const memberProfileIdSet = memberProfileIds.length > 0 ? new Set(memberProfileIds) : null;
    const activeProfileId = params.group.activeProfileId.trim();
    if (
        activeProfileId
        && connectedProfileIdSet.has(activeProfileId)
        && (!memberProfileIdSet || memberProfileIdSet.has(activeProfileId))
    ) return activeProfileId;

    for (const profileId of memberProfileIds) {
        const candidate = profileId.trim();
        if (candidate && connectedProfileIdSet.has(candidate)) return candidate;
    }

    return null;
}

export function buildConnectedServicesBindingsPayload(params: Readonly<{
    supportedConnectedServiceIds: ReadonlyArray<ConnectedServiceId>;
    connectedServiceProfileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
    accountGroupsFeatureEnabled?: boolean;
    accountGroupSwitchingEnabled?: boolean;
    connectedServiceAccountGroupOptionsByServiceId?: ConnectedServicesAccountGroupOptionsByServiceId;
    connectedServicesBindingsByServiceId: Readonly<Record<string, ConnectedServicesBindingOptionInput | undefined>>;
    defaultProfileByServiceId: Record<string, string | undefined>;
}>): ConnectedServiceBindingsV1 | null {
    if (params.supportedConnectedServiceIds.length === 0) return null;

    const bindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV1> = {};
    let connectedCount = 0;

    for (const serviceId of params.supportedConnectedServiceIds) {
        const options = params.connectedServiceProfileOptionsByServiceId[serviceId] ?? [];
        const connected = options.filter(isConnectedServiceProfileOptionSelectable);
        const binding = params.connectedServicesBindingsByServiceId[serviceId];
        const mode = binding?.source === 'connected' ? 'connected' : 'native';

        if (mode === 'connected') {
            const explicitGroupId = binding?.selection === 'group'
                ? readString(binding.groupId)
                : '';
            if (explicitGroupId) {
                bindingsByServiceId[serviceId] = {
                    source: 'connected',
                    selection: 'group',
                    groupId: explicitGroupId,
                };
                connectedCount += 1;
                continue;
            }
            const explicitProfileId = binding?.selection !== 'group'
                ? readString(binding?.profileId)
                : '';
            if (explicitProfileId) {
                bindingsByServiceId[serviceId] = {
                    source: 'connected',
                    selection: 'profile',
                    profileId: explicitProfileId,
                };
                connectedCount += 1;
                continue;
            }
            if (connected.length === 0) {
                bindingsByServiceId[serviceId] = { source: 'native' };
                continue;
            }
            const connectedProfileIds = connected.map((option) => option.profileId);
            if (binding?.selection === 'group') {
                if (params.accountGroupsFeatureEnabled === false || params.accountGroupSwitchingEnabled === false) {
                    bindingsByServiceId[serviceId] = { source: 'native' };
                    continue;
                }
                const groupId = typeof binding.groupId === 'string' ? binding.groupId.trim() : '';
                const group = groupId
                    ? params.connectedServiceAccountGroupOptionsByServiceId?.[serviceId]?.find((candidate) =>
                        candidate.groupId === groupId
                    )
                    : null;
                const viableGroupProfileId = group
                    ? resolveConnectedServiceAccountGroupViableProfileId({ group, connectedProfileIds })
                    : null;
                if (!groupId || !group || !viableGroupProfileId) {
                    bindingsByServiceId[serviceId] = { source: 'native' };
                    continue;
                }
                bindingsByServiceId[serviceId] = {
                    source: 'connected',
                    selection: 'group',
                    groupId,
                };
                connectedCount += 1;
                continue;
            }
            const selected = resolveConnectedServiceDefaultProfileId({
                    serviceId,
                    connectedProfileIds,
                    defaultProfileByServiceId: params.defaultProfileByServiceId,
                }) ?? connected[0]!.profileId;
            if (!selected) {
                bindingsByServiceId[serviceId] = { source: 'native' };
                continue;
            }
            bindingsByServiceId[serviceId] = {
                source: 'connected',
                selection: 'profile',
                profileId: selected,
            };
            connectedCount += 1;
            continue;
        }

        bindingsByServiceId[serviceId] = { source: 'native' };
    }

    // Explicit native choice must reach the daemon so its saved connected
    // default cannot reappear. An omitted choice still leaves defaulting there.
    const hasExplicitNativeBinding = params.supportedConnectedServiceIds.some((serviceId) =>
        params.connectedServicesBindingsByServiceId[serviceId]?.source === 'native',
    );
    return connectedCount > 0 || hasExplicitNativeBinding
        ? ConnectedServiceBindingsV1Schema.parse({ v: 1, bindingsByServiceId })
        : null;
}
