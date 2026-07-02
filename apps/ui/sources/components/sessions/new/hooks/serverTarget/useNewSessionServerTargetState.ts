import * as React from 'react';

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
    targetServerId: string;
    targetServerProfile: ServerProfile | null;
    targetServerName: string;
    showServerPickerChip: boolean;
}>;

export type NewSessionServerTargetSettings = Pick<
    Settings,
    'serverSelectionGroups' | 'serverSelectionActiveTargetKind' | 'serverSelectionActiveTargetId'
>;

export function useNewSessionServerTargetState(params: Readonly<{
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

    const serverTargets = React.useMemo(() => {
        const scopedSettings = normalizeServerSelectionSettingsForProfileScopeIds({
            serverSelectionGroups,
            serverSelectionActiveTargetKind: params.settings.serverSelectionActiveTargetKind,
            serverSelectionActiveTargetId: params.settings.serverSelectionActiveTargetId,
        }, serverProfiles);
        return listServerSelectionTargets({
            serverProfiles: serverProfiles.map((profile) => ({
                ...profile,
                id: resolveServerProfileScopeId(profile),
            })),
            groupProfiles: toServerSelectionSettings(scopedSettings).serverSelectionGroups ?? [],
        });
    }, [params.settings.serverSelectionActiveTargetId, params.settings.serverSelectionActiveTargetKind, serverProfiles, serverSelectionGroups]);

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
        });
    }, [
        activeServerId,
        availableServerIds,
        params.settings.serverSelectionActiveTargetId,
        params.settings.serverSelectionActiveTargetKind,
        params.settings.serverSelectionGroups,
        serverProfiles,
    ]);

    const explicitServerTargetId = React.useMemo(() => {
        if (params.settings.serverSelectionActiveTargetKind !== 'server') return null;
        const id = String(params.settings.serverSelectionActiveTargetId ?? '').trim();
        if (!id) return null;
        const mappedId = normalizeServerSelectionSettingsForProfileScopeIds({
            serverSelectionGroups: [],
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: id,
        }, serverProfiles).serverSelectionActiveTargetId;
        return typeof mappedId === 'string' && availableServerIds.includes(mappedId) ? mappedId : null;
    }, [
        availableServerIds,
        params.settings.serverSelectionActiveTargetId,
        params.settings.serverSelectionActiveTargetKind,
        serverProfiles,
    ]);

    const selectedServerTarget = React.useMemo(() => {
        if (explicitServerTargetId) {
            const target = serverTargets.find((candidate) => candidate.kind === 'server' && candidate.id === explicitServerTargetId);
            if (target) return target;
        }
        const resolvedTargetKey = `${resolvedSettingsTarget.activeTarget.kind}:${resolvedSettingsTarget.activeTarget.id}`;
        return serverTargets.find((target) => `${target.kind}:${target.id}` === resolvedTargetKey)
            ?? serverTargets.find((target) => target.kind === 'server')
            ?? null;
    }, [
        explicitServerTargetId,
        resolvedSettingsTarget.activeTarget.id,
        resolvedSettingsTarget.activeTarget.kind,
        serverTargets,
    ]);

    const allowedTargetServerIds = React.useMemo(() => {
        if (!selectedServerTarget) {
            return resolvedSettingsTarget.allowedServerIds;
        }
        if (selectedServerTarget.kind === 'group') {
            return selectedServerTarget.serverIds;
        }
        return [selectedServerTarget.serverId];
    }, [resolvedSettingsTarget.allowedServerIds, selectedServerTarget]);

    const routeRequestedServerId = typeof params.request.spawnServerIdParam === 'string'
        ? params.request.spawnServerIdParam.trim() || null
        : null;
    const persistedRequestedServerId = typeof params.request.persistedTargetServerId === 'string'
        ? params.request.persistedTargetServerId.trim() || null
        : null;
    const requestedServerId = routeRequestedServerId ?? persistedRequestedServerId;
    const newSessionServerTarget = React.useMemo(() => {
        return resolveNewSessionServerTarget({
            requestedServerId,
            activeServerId,
            allowedServerIds: allowedTargetServerIds.length > 0 ? allowedTargetServerIds : resolvedSettingsTarget.allowedServerIds,
        });
    }, [
        activeServerId,
        allowedTargetServerIds,
        requestedServerId,
        resolvedSettingsTarget.allowedServerIds,
    ]);

    const targetServerId = newSessionServerTarget.targetServerId
        ?? resolvedSettingsTarget.activeServerId
        ?? activeServerId;
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
        targetServerProfile,
        targetServerName: targetServerProfile?.name ?? targetServerId,
        showServerPickerChip: allowedTargetServerIds.length > 1,
    };
}
