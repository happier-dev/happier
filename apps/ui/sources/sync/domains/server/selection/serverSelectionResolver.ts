import {
    filterServerSelectionGroupsToAvailableServers,
    normalizeStoredServerSelectionGroups,
} from './serverSelectionMutations';
import type {
    ActiveServerSelectionTarget,
    EffectiveServerSelection,
    NewSessionServerTargeting,
    ResolvedActiveServerSelection,
    ResolvedNewSessionServerTarget,
    ServerSelectionGroup,
    ServerSelectionPresentation,
    ServerSelectionSettingsLike,
    ServerSelectionTarget,
    ServerSelectionTargetKind,
} from './serverSelectionTypes';

type ServerProfileLike = Readonly<{
    id: string;
    name: string;
    serverUrl: string;
}>;

type GroupProfileNormalized = Readonly<{
    id: string;
    name: string;
    serverIds: string[];
    presentation: ServerSelectionPresentation;
}>;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function normalizeTargetKind(raw: unknown): ServerSelectionTargetKind | null {
    return raw === 'server' || raw === 'group' ? raw : null;
}

function normalizePresentation(raw: unknown): ServerSelectionPresentation {
    return raw === 'flat-with-badge' ? 'flat-with-badge' : 'grouped';
}

function normalizeServerIds(serverIds: ReadonlyArray<string>, available: ReadonlySet<string>): string[] {
    const seen = new Set<string>();
    const next: string[] = [];
    for (const raw of serverIds) {
        const id = normalizeId(raw);
        if (!id) continue;
        if (!available.has(id)) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        next.push(id);
    }
    return next;
}

function normalizeGroupProfiles(
    rawGroups: ReadonlyArray<ServerSelectionGroup> | null | undefined,
    availableServerIds: ReadonlySet<string>,
): GroupProfileNormalized[] {
    const normalizedGroups = filterServerSelectionGroupsToAvailableServers(
        normalizeStoredServerSelectionGroups(rawGroups),
        availableServerIds,
    );
    return normalizedGroups.map((group) => ({
        id: group.id,
        name: group.name,
        serverIds: normalizeServerIds(group.serverIds, availableServerIds),
        presentation: normalizePresentation(group.presentation),
    }));
}

function resolveFallbackServerId(activeServerIdRaw: string, availableServerIds: string[]): string {
    const activeServerId = normalizeId(activeServerIdRaw);
    if (activeServerId && availableServerIds.includes(activeServerId)) return activeServerId;
    return availableServerIds[0] ?? '';
}

function toServerTarget(serverId: string): ActiveServerSelectionTarget {
    return { kind: 'server', id: serverId, serverId };
}

function toGroupTarget(group: GroupProfileNormalized): ActiveServerSelectionTarget {
    return { kind: 'group', id: group.id, groupId: group.id, serverIds: group.serverIds.slice() };
}

function resolveGroupSelection(
    group: GroupProfileNormalized,
    fallbackServerId: string,
    explicit: boolean,
): ResolvedActiveServerSelection {
    const activeServerId = group.serverIds.includes(fallbackServerId) ? fallbackServerId : (group.serverIds[0] ?? '');
    return {
        activeTarget: toGroupTarget(group),
        activeServerId,
        allowedServerIds: group.serverIds.slice(),
        enabled: true,
        presentation: group.presentation,
        explicit,
    };
}

function isConcurrentModeRuntimeEnabled(): boolean {
    const raw = String(process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT ?? '').trim().toLowerCase();
    if (!raw) return true;
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
    return true;
}

function normalizeResolvedServerIds(ids: ReadonlyArray<string>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const rawId of ids) {
        const id = normalizeId(rawId);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        result.push(id);
    }
    return result;
}

export function listServerSelectionTargets(params: Readonly<{
    serverProfiles: ReadonlyArray<ServerProfileLike>;
    groupProfiles: ReadonlyArray<ServerSelectionGroup>;
}>): ServerSelectionTarget[] {
    const availableIds = new Set(
        params.serverProfiles.map((profile) => normalizeId(profile.id)).filter(Boolean),
    );
    const groups = normalizeGroupProfiles(params.groupProfiles, availableIds).filter((group) => group.serverIds.length > 0);

    return [
        ...params.serverProfiles.map((profile) => {
            const id = normalizeId(profile.id);
            return {
                kind: 'server' as const,
                id,
                serverId: id,
                name: normalizeId(profile.name) || id,
                serverUrl: normalizeId(profile.serverUrl),
            };
        }),
        ...groups.map((group) => ({
            kind: 'group' as const,
            id: group.id,
            groupId: group.id,
            name: group.name,
            serverIds: group.serverIds.slice(),
            presentation: group.presentation,
        })),
    ];
}

export function resolveActiveServerSelection(params: Readonly<{
    activeServerId: string;
    availableServerIds: ReadonlyArray<string>;
    settings: ServerSelectionSettingsLike;
}>): ResolvedActiveServerSelection {
    const availableServerIds = Array.from(
        new Set(params.availableServerIds.map((id) => normalizeId(id)).filter(Boolean)),
    );
    const availableSet = new Set(availableServerIds);
    const fallbackServerId = resolveFallbackServerId(params.activeServerId, availableServerIds);
    const groups = normalizeGroupProfiles(params.settings.serverSelectionGroups, availableSet);
    const groupById = new Map(groups.map((group) => [group.id, group]));

    const explicitKind = normalizeTargetKind(params.settings.serverSelectionActiveTargetKind);
    const explicitId = normalizeId(params.settings.serverSelectionActiveTargetId);
    if (explicitKind === 'server' && explicitId && availableSet.has(explicitId)) {
        return {
            activeTarget: toServerTarget(explicitId),
            activeServerId: explicitId,
            allowedServerIds: [explicitId],
            enabled: false,
            presentation: 'grouped',
            explicit: true,
        };
    }

    if (explicitKind === 'group' && explicitId) {
        const group = groupById.get(explicitId);
        if (group && group.serverIds.length > 0) {
            return resolveGroupSelection(group, fallbackServerId, true);
        }
    }

    if (fallbackServerId) {
        return {
            activeTarget: toServerTarget(fallbackServerId),
            activeServerId: fallbackServerId,
            allowedServerIds: [fallbackServerId],
            enabled: false,
            presentation: 'grouped',
            explicit: false,
        };
    }

    return {
        activeTarget: toServerTarget(''),
        activeServerId: '',
        allowedServerIds: [],
        enabled: false,
        presentation: 'grouped',
        explicit: false,
    };
}

export function getEffectiveServerSelection(params: Readonly<{
    activeServerId: string;
    availableServerIds: ReadonlyArray<string>;
    settings: ServerSelectionSettingsLike;
}>): EffectiveServerSelection {
    const resolved = resolveActiveServerSelection(params);

    if (!isConcurrentModeRuntimeEnabled() && resolved.enabled) {
        const available = new Set(params.availableServerIds.map((id) => normalizeId(id)).filter(Boolean));
        const normalizedActiveServerId = normalizeId(params.activeServerId);
        const fallbackServerId = available.has(normalizedActiveServerId)
            ? normalizedActiveServerId
            : resolved.activeServerId;
        return {
            enabled: false,
            serverIds: fallbackServerId ? [fallbackServerId] : [],
            presentation: resolved.presentation,
        };
    }

    return {
        enabled: resolved.enabled,
        serverIds: resolved.allowedServerIds,
        presentation: resolved.presentation,
    };
}

export function getNewSessionServerTargeting(params: Readonly<{
    activeServerId: string;
    availableServerIds: ReadonlyArray<string>;
    settings: ServerSelectionSettingsLike;
}>): NewSessionServerTargeting {
    const selection = getEffectiveServerSelection(params);
    const allowedServerIds = normalizeResolvedServerIds(selection.serverIds);
    return {
        allowedServerIds,
        pickerEnabled: selection.enabled && allowedServerIds.length > 1,
    };
}

export function resolveNewSessionServerTarget(params: Readonly<{
    requestedServerId?: string | null;
    activeServerId: string;
    allowedServerIds: ReadonlyArray<string>;
}>): ResolvedNewSessionServerTarget {
    const allowedServerIds = normalizeResolvedServerIds(params.allowedServerIds);
    if (allowedServerIds.length === 0) {
        return {
            targetServerId: null,
            rejectedRequestedServerId: null,
        };
    }

    const activeServerId = normalizeId(params.activeServerId);
    const fallbackServerId = allowedServerIds.includes(activeServerId) ? activeServerId : (allowedServerIds[0] ?? null);
    const requestedServerId = normalizeId(params.requestedServerId);

    if (!requestedServerId) {
        return {
            targetServerId: fallbackServerId,
            rejectedRequestedServerId: null,
        };
    }

    if (allowedServerIds.includes(requestedServerId)) {
        return {
            targetServerId: requestedServerId,
            rejectedRequestedServerId: null,
        };
    }

    return {
        targetServerId: fallbackServerId,
        rejectedRequestedServerId: requestedServerId,
    };
}
