import * as React from 'react';

import { listServerProfiles, type ActiveServerSnapshot, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { listServerSelectionTargets, resolveNewSessionServerTarget } from '@/sync/domains/server/selection/serverSelectionResolver';
import { resolveActiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import type { ResolvedActiveServerSelection, ServerSelectionTarget } from '@/sync/domains/server/selection/serverSelectionTypes';
import type { Settings } from '@/sync/domains/settings/settings';

type RequestedTargetParams = Readonly<{
    spawnServerIdParam?: string | null;
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

export function useNewSessionServerTargetState(params: Readonly<{
    settings: Settings;
    activeServerSnapshot: ActiveServerSnapshot;
    request: RequestedTargetParams;
}>): NewSessionServerTargetState {
    const serverProfiles = React.useMemo(() => {
        try {
            return listServerProfiles()
                .slice();
        } catch {
            return [];
        }
    }, [params.activeServerSnapshot.generation]);

    const availableServerIds = React.useMemo(() => {
        return serverProfiles.map((profile) => profile.id);
    }, [serverProfiles]);

    const serverSelectionGroups = React.useMemo(() => {
        return Array.isArray(params.settings.serverSelectionGroups)
            ? params.settings.serverSelectionGroups
            : [];
    }, [params.settings.serverSelectionGroups]);

    const serverTargets = React.useMemo(() => {
        return listServerSelectionTargets({
            serverProfiles,
            groupProfiles: serverSelectionGroups as any,
        });
    }, [serverProfiles, serverSelectionGroups]);

    const resolvedSettingsTarget = React.useMemo(() => {
        return resolveActiveServerSelectionFromRawSettings({
            activeServerId: params.activeServerSnapshot.serverId,
            availableServerIds,
            settings: {
                serverSelectionGroups: params.settings.serverSelectionGroups,
                serverSelectionActiveTargetKind: params.settings.serverSelectionActiveTargetKind,
                serverSelectionActiveTargetId: params.settings.serverSelectionActiveTargetId,
            },
        });
    }, [
        availableServerIds,
        params.activeServerSnapshot.serverId,
        params.settings.serverSelectionActiveTargetId,
        params.settings.serverSelectionActiveTargetKind,
        params.settings.serverSelectionGroups,
    ]);

    const selectedServerTarget = React.useMemo(() => {
        const resolvedTargetKey = `${resolvedSettingsTarget.activeTarget.kind}:${resolvedSettingsTarget.activeTarget.id}`;
        return serverTargets.find((target) => `${target.kind}:${target.id}` === resolvedTargetKey)
            ?? serverTargets.find((target) => target.kind === 'server')
            ?? null;
    }, [resolvedSettingsTarget.activeTarget.id, resolvedSettingsTarget.activeTarget.kind, serverTargets]);

    const allowedTargetServerIds = React.useMemo(() => {
        if (!selectedServerTarget) {
            return resolvedSettingsTarget.allowedServerIds;
        }
        if (selectedServerTarget.kind === 'group') {
            return selectedServerTarget.serverIds;
        }
        return [selectedServerTarget.serverId];
    }, [resolvedSettingsTarget.allowedServerIds, selectedServerTarget]);

    const requestedServerId = typeof params.request.spawnServerIdParam === 'string'
        ? params.request.spawnServerIdParam
        : null;
    const newSessionServerTarget = React.useMemo(() => {
        return resolveNewSessionServerTarget({
            requestedServerId,
            activeServerId: params.activeServerSnapshot.serverId,
            allowedServerIds: allowedTargetServerIds.length > 0 ? allowedTargetServerIds : resolvedSettingsTarget.allowedServerIds,
        });
    }, [
        allowedTargetServerIds,
        params.activeServerSnapshot.serverId,
        requestedServerId,
        resolvedSettingsTarget.allowedServerIds,
    ]);

    const targetServerId = newSessionServerTarget.targetServerId
        ?? resolvedSettingsTarget.activeServerId
        ?? params.activeServerSnapshot.serverId;
    const targetServerProfile = React.useMemo(() => {
        return serverProfiles.find((profile) => profile.id === targetServerId) ?? null;
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
