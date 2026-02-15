import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { ServerSelectionGroup } from '@/sync/domains/server/selection/serverSelectionTypes';
import { promptSignedOutServerSwitchConfirmation } from '@/components/settings/server/modals/ServerSwitchAuthPrompt';

import type { ServerAuthStatus } from './useServerAuthStatusByServerId';

function toGroupProfileId(rawName: string): string {
    const base = String(rawName ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-');
    return base || `group-${Date.now()}`;
}

export function useServerSettingsGroupActions(params: Readonly<{
    servers: ReadonlyArray<ServerProfile>;
    activeServerId: string;
    validServerIds: ReadonlySet<string>;
    authStatusByServerId: Readonly<Record<string, ServerAuthStatus>>;

    normalizedGroupProfiles: ReadonlyArray<ServerSelectionGroup>;
    activeGroupId: string | null;
    groupPresentation: 'grouped' | 'flat-with-badge';

    setRevision: React.Dispatch<React.SetStateAction<number>>;
    onSwitchServerById: (serverId: string) => Promise<void>;
    onAfterSignedOutSwitch: () => void;

    setServerSelectionActiveTargetKind: (value: 'server' | 'group' | null) => void;
    setServerSelectionActiveTargetId: (value: string | null) => void;
    setServerSelectionGroups: (value: ServerSelectionGroup[]) => void;
}>) {
    const onSwitchGroup = React.useCallback(async (profile: ServerSelectionGroup) => {
        const nextServerIds = Array.from(new Set(profile.serverIds.map((id) => String(id ?? '').trim()).filter(Boolean)));
        if (nextServerIds.length === 0) {
            Modal.alert(t('common.error'), t('server.serverGroupMustHaveServer'));
            return;
        }

        const nextServerId = nextServerIds.includes(params.activeServerId) ? params.activeServerId : nextServerIds[0]!;
        let authStatus: ServerAuthStatus = params.authStatusByServerId[nextServerId] ?? 'unknown';
        if (authStatus === 'unknown') {
            const nextProfile = params.servers.find((server) => server.id === nextServerId) ?? null;
            if (nextProfile) {
                try {
                    const creds = await TokenStorage.getCredentialsForServerUrl(nextProfile.serverUrl);
                    authStatus = creds ? 'signedIn' : 'signedOut';
                } catch {
                    authStatus = 'unknown';
                }
            }
        }
        if (authStatus === 'signedOut') {
            const shouldContinue = await promptSignedOutServerSwitchConfirmation();
            if (!shouldContinue) return;
        }

        params.setServerSelectionActiveTargetKind('group');
        params.setServerSelectionActiveTargetId(profile.id);

        if (nextServerId !== params.activeServerId) {
            await params.onSwitchServerById(nextServerId);
        }
        if (authStatus === 'signedOut') {
            params.onAfterSignedOutSwitch();
        }
        params.setRevision((r) => r + 1);
    }, [params]);

    const onRenameGroup = React.useCallback(async (profile: ServerSelectionGroup) => {
        const next = await Modal.prompt(
            t('server.renameServerGroup'),
            t('server.renameServerGroupPrompt'),
            { defaultValue: profile.name, placeholder: t('server.serverGroupNamePlaceholder') },
        );
        if (!next) return;
        const trimmed = next.trim();
        if (!trimmed) return;
        const nextProfiles = params.normalizedGroupProfiles.map((item) => item.id !== profile.id ? item : { ...item, name: trimmed });
        params.setServerSelectionGroups(nextProfiles.slice());
    }, [params]);

    const onRemoveGroup = React.useCallback(async (profile: ServerSelectionGroup) => {
        const confirmed = await Modal.confirm(
            t('server.removeServerGroup'),
            t('server.removeServerGroupConfirm', { name: profile.name }),
            { confirmText: t('common.remove'), destructive: true },
        );
        if (!confirmed) return;

        const nextProfiles = params.normalizedGroupProfiles.filter((item) => item.id !== profile.id);
        params.setServerSelectionGroups(nextProfiles.slice());
        if (params.activeGroupId === profile.id) {
            params.setServerSelectionActiveTargetKind('server');
            params.setServerSelectionActiveTargetId(params.activeServerId || null);
        }
    }, [params]);

    const onCreateServerGroup = React.useCallback(async (input: { name: string; serverIds: string[] }) => {
        const trimmedName = String(input.name ?? '').trim();
        const nextServerIds = Array.from(new Set((input.serverIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean)));
        if (!trimmedName) return false;
        if (nextServerIds.length === 0) {
            Modal.alert(t('common.error'), t('server.serverGroupMustHaveServer'));
            return false;
        }

        const baseId = toGroupProfileId(trimmedName);
        const existingIds = new Set(params.normalizedGroupProfiles.map((profile) => profile.id));
        let id = baseId;
        let suffix = 2;
        while (existingIds.has(id)) {
            id = `${baseId}-${suffix}`;
            suffix += 1;
        }

        const nextServerId = nextServerIds.includes(params.activeServerId) ? params.activeServerId : nextServerIds[0]!;
        const nextProfile = params.servers.find((srv) => srv.id === nextServerId) ?? null;
        let authStatus: ServerAuthStatus = params.authStatusByServerId[nextServerId] ?? 'unknown';
        if (authStatus === 'unknown' && nextProfile) {
            try {
                const creds = await TokenStorage.getCredentialsForServerUrl(nextProfile.serverUrl);
                authStatus = creds ? 'signedIn' : 'signedOut';
            } catch {
                authStatus = 'unknown';
            }
        }
        if (authStatus === 'signedOut') {
            const shouldContinue = await promptSignedOutServerSwitchConfirmation();
            if (!shouldContinue) return false;
        }

        const nextGroup: ServerSelectionGroup = {
            id,
            name: trimmedName,
            serverIds: nextServerIds,
            presentation: params.groupPresentation,
        };
        const nextProfiles = [...params.normalizedGroupProfiles, nextGroup];
        params.setServerSelectionGroups(nextProfiles.slice());

        params.setServerSelectionActiveTargetKind('group');
        params.setServerSelectionActiveTargetId(nextGroup.id);

        if (nextServerId !== params.activeServerId) {
            await params.onSwitchServerById(nextServerId);
        }
        if (authStatus === 'signedOut') {
            params.onAfterSignedOutSwitch();
        }
        params.setRevision((r) => r + 1);
        return true;
    }, [params]);

    return {
        onSwitchGroup,
        onRenameGroup,
        onRemoveGroup,
        onCreateServerGroup,
    } as const;
}
