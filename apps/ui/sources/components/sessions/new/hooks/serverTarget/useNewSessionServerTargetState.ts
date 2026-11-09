import * as React from 'react';
import { useUsableHomeServerIds } from '@/sync/domains/scope/usableHomeServerIds';

import {
    listServerProfiles,
    resolveServerProfileScopeId,
    type ActiveServerSnapshot,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { listServerSelectionTargets, resolveNewSessionServerTarget } from '@/sync/domains/server/selection/serverSelectionResolver';
import { resolveActiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import { toServerSelectionSettings } from '@/sync/domains/server/selection/serverSelectionSettingsAdapter';
import {
    listServerProfileScopeIds,
    normalizeServerSelectionSettingsForProfileScopeIds,
    resolveServerProfileScopeIdForSelectionIdentifier,
} from '@/sync/domains/server/selection/serverSelectionProfileScopeIds';
import type { ResolvedActiveServerSelection, ServerSelectionTarget } from '@/sync/domains/server/selection/serverSelectionTypes';
import type { Settings } from '@/sync/domains/settings/settings';

type RequestedTargetParams = Readonly<{
    spawnServerIdParam?: string | null;
    persistedTargetServerId?: string | null;
}>;

export type NewSessionServerTargetState = Readonly<{
    serverProfiles: ReadonlyArray<ServerProfile>;
    serverTargets: ReadonlyArray<ServerSelectionTarget>;
    selectedServerTarget: ServerSelectionTarget | null;
    resolvedSettingsTarget: ResolvedActiveServerSelection;
    allowedTargetServerIds: string[];
    targetServerId: string | null;
    rejectedRequestedServerId: string | null;
    targetServerProfile: ServerProfile | null;
    targetServerName: string;
    showServerPickerChip: boolean;
}>;

export type NewSessionServerTargetSettings = Pick<
    Settings,
    'serverSelectionGroups' | 'serverSelectionActiveTargetKind' | 'serverSelectionActiveTargetId'
>;

export function useNewSessionServerTargetState(params: Readonly<{
    /** Authenticated creation host placement; independent of saved Account Homes. */
    hostTargetServerId?: string;
    settings: NewSessionServerTargetSettings;
    activeServerId?: string;
    activeServerSnapshot?: ActiveServerSnapshot;
    serverProfiles?: ReadonlyArray<ServerProfile>;
    request: RequestedTargetParams;
}>): NewSessionServerTargetState {
    const serverProfiles = React.useMemo(() => {
        if (params.serverProfiles) {
            return params.serverProfiles.slice();
        }
        try {
            return listServerProfiles()
                .slice();
        } catch {
            return [];
        }
    }, [params.serverProfiles]);
    const activeServerId = params.activeServerId ?? params.activeServerSnapshot?.serverId ?? '';

    const availableServerIds = React.useMemo(() => {
        return listServerProfileScopeIds(serverProfiles);
    }, [serverProfiles]);

    const serverSelectionGroups = React.useMemo(() => {
        return Array.isArray(params.settings.serverSelectionGroups)
            ? params.settings.serverSelectionGroups
            : [];
    }, [params.settings.serverSelectionGroups]);

    const usableServerIds = useUsableHomeServerIds();
    const serverTargets = React.useMemo(() => {
        const scopedSettings = normalizeServerSelectionSettingsForProfileScopeIds({
            serverSelectionGroups,
            serverSelectionActiveTargetKind: params.settings.serverSelectionActiveTargetKind,
            serverSelectionActiveTargetId: params.settings.serverSelectionActiveTargetId,
        }, serverProfiles);
        return listServerSelectionTargets({
            currentServerId: activeServerId,
            serverProfiles: serverProfiles.map((profile) => ({
                ...profile,
                id: resolveServerProfileScopeId(profile),
            })),
            groupProfiles: toServerSelectionSettings(scopedSettings).serverSelectionGroups ?? [],
            usableServerIds,
        });
    }, [activeServerId, usableServerIds, params.settings.serverSelectionActiveTargetId, params.settings.serverSelectionActiveTargetKind, serverProfiles, serverSelectionGroups]);

    const resolvedSettingsTarget = React.useMemo(() => {
        const settings = normalizeServerSelectionSettingsForProfileScopeIds({
            serverSelectionGroups,
            serverSelectionActiveTargetKind: params.settings.serverSelectionActiveTargetKind,
            serverSelectionActiveTargetId: params.settings.serverSelectionActiveTargetId,
        }, serverProfiles);
        return resolveActiveServerSelectionFromRawSettings({
            activeServerId,
            availableServerIds,
            settings,
            usableServerIds,
        });
    }, [
        usableServerIds,
        activeServerId,
        availableServerIds,
        params.settings.serverSelectionActiveTargetId,
        params.settings.serverSelectionActiveTargetKind,
        params.settings.serverSelectionGroups,
        serverProfiles,
    ]);

    const explicitSettingsServerId = React.useMemo(() => {
        if (params.settings.serverSelectionActiveTargetKind !== 'server') return null;
        const id = String(params.settings.serverSelectionActiveTargetId ?? '').trim();
        return id || null;
    }, [params.settings.serverSelectionActiveTargetId, params.settings.serverSelectionActiveTargetKind]);
    const explicitServerTargetId = React.useMemo(() => {
        if (!explicitSettingsServerId) return null;
        const mappedId = normalizeServerSelectionSettingsForProfileScopeIds({
            serverSelectionGroups: [],
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: explicitSettingsServerId,
        }, serverProfiles).serverSelectionActiveTargetId;
        return typeof mappedId === 'string' && availableServerIds.includes(mappedId) ? mappedId : null;
    }, [
        availableServerIds,
        explicitSettingsServerId,
        serverProfiles,
    ]);
    const explicitSettingsServerRejected = explicitSettingsServerId !== null && explicitServerTargetId === null;

    const selectedServerTarget = React.useMemo(() => {
        if (explicitSettingsServerRejected) return null;
        if (explicitServerTargetId) {
            const target = serverTargets.find((candidate) => candidate.kind === 'server' && candidate.id === explicitServerTargetId);
            if (target) return target;
        }
        const resolvedTargetKey = `${resolvedSettingsTarget.activeTarget.kind}:${resolvedSettingsTarget.activeTarget.id}`;
        return serverTargets.find((target) => `${target.kind}:${target.id}` === resolvedTargetKey)
            ?? serverTargets.find((target) => target.kind === 'server')
            ?? null;
    }, [
        explicitSettingsServerRejected,
        explicitServerTargetId,
        resolvedSettingsTarget.activeTarget.id,
        resolvedSettingsTarget.activeTarget.kind,
        serverTargets,
    ]);

    const allowedTargetServerIds = React.useMemo(() => {
        if (params.hostTargetServerId) return [params.hostTargetServerId];
        if (explicitSettingsServerRejected) return [];
        if (!selectedServerTarget) {
            return resolvedSettingsTarget.allowedServerIds;
        }
        if (selectedServerTarget.kind === 'group') {
            return selectedServerTarget.serverIds;
        }
        return [selectedServerTarget.serverId];
    }, [explicitSettingsServerRejected, params.hostTargetServerId, resolvedSettingsTarget.allowedServerIds, selectedServerTarget]);

    const routeRequestedServerId = typeof params.request.spawnServerIdParam === 'string'
        ? resolveServerProfileScopeIdForSelectionIdentifier(serverProfiles, params.request.spawnServerIdParam)
            ?? (params.request.spawnServerIdParam.trim() || null)
        : null;
    const persistedRequestedServerId = typeof params.request.persistedTargetServerId === 'string'
        ? resolveServerProfileScopeIdForSelectionIdentifier(serverProfiles, params.request.persistedTargetServerId)
            ?? (params.request.persistedTargetServerId.trim() || null)
        : null;
    const capturedAuthoringServerIdRef = React.useRef<string | null>(null);
    const requestedServerId = params.hostTargetServerId ?? routeRequestedServerId
        ?? persistedRequestedServerId
        ?? capturedAuthoringServerIdRef.current
        ?? (explicitSettingsServerRejected ? explicitSettingsServerId : null);
    const normalizableRequestedServerId = routeRequestedServerId
        ?? (persistedRequestedServerId === null ? capturedAuthoringServerIdRef.current : null);
    const newSessionServerTarget = React.useMemo(() => {
        const requested = resolveNewSessionServerTarget({
            requestedServerId,
            activeServerId,
            allowedServerIds: allowedTargetServerIds,
        });
        if (requested.targetServerId !== null || requested.rejectedRequestedServerId === null) return requested;
        // Route Homes and an unpersisted implicit fallback are navigation/authoring context, not a
        // committed execution target. If the allowed Home set moves away from either, normalize
        // through the same allowed-active-then-first owner. A persisted/committed Home still fails
        // closed so a restored exact target is never silently moved. The rejection remains visible
        // to hosts, and an empty allowed set still has no canonical Home to fall back to.
        if (requested.rejectedRequestedServerId !== normalizableRequestedServerId) return requested;
        const normalized = resolveNewSessionServerTarget({
            requestedServerId: null,
            activeServerId,
            allowedServerIds: allowedTargetServerIds,
        });
        return {
            targetServerId: normalized.targetServerId,
            rejectedRequestedServerId: requested.rejectedRequestedServerId,
        };
    }, [
        activeServerId,
        allowedTargetServerIds,
        normalizableRequestedServerId,
        requestedServerId,
    ]);

    const targetServerId = newSessionServerTarget.targetServerId;
    React.useEffect(() => {
        if (targetServerId !== null) {
            capturedAuthoringServerIdRef.current = targetServerId;
        }
    }, [targetServerId]);
    const targetServerProfile = React.useMemo(() => {
        return serverProfiles.find((profile) => resolveServerProfileScopeId(profile) === targetServerId || profile.id === targetServerId) ?? null;
    }, [serverProfiles, targetServerId]);

    return {
        serverProfiles,
        serverTargets,
        selectedServerTarget,
        resolvedSettingsTarget,
        allowedTargetServerIds,
        targetServerId,
        rejectedRequestedServerId: newSessionServerTarget.rejectedRequestedServerId,
        targetServerProfile,
        targetServerName: targetServerProfile?.name ?? targetServerId ?? '',
        showServerPickerChip: allowedTargetServerIds.length > 1,
    };
}
