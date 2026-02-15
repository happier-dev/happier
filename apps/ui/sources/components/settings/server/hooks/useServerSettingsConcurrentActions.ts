import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import {
    normalizeStoredServerSelectionGroups,
    toggleServerSelectionGroupServerIdEnsuringNonEmpty,
} from '@/sync/domains/server/selection/serverSelectionMutations';
import type { ServerSelectionGroup, ServerSelectionPresentation } from '@/sync/domains/server/selection/serverSelectionTypes';

export function useServerSettingsConcurrentActions(params: Readonly<{
    activeGroupId: string | null;
    serverSelectionGroupsRaw: unknown;
    setServerSelectionGroups: (value: ServerSelectionGroup[]) => void;
}>) {
    const onToggleConcurrentServer = React.useCallback((serverId: string) => {
        if (!params.activeGroupId) return;
        const currentProfiles = normalizeStoredServerSelectionGroups(params.serverSelectionGroupsRaw);
        const nextProfiles = currentProfiles.map((profile) => {
            if (profile.id !== params.activeGroupId) return profile;
            const toggle = toggleServerSelectionGroupServerIdEnsuringNonEmpty(profile.serverIds, serverId);
            if (toggle.preventedEmpty) {
                Modal.alert(t('common.error'), t('server.serverGroupMustHaveServer'));
                return profile;
            }
            return { ...profile, serverIds: toggle.nextServerIds };
        });
        params.setServerSelectionGroups(nextProfiles.slice());
    }, [params]);

    const onTogglePresentation = React.useCallback(() => {
        if (!params.activeGroupId) return;
        const currentProfiles = normalizeStoredServerSelectionGroups(params.serverSelectionGroupsRaw);
        const nextProfiles = currentProfiles.map((profile) => {
            if (profile.id !== params.activeGroupId) return profile;
            const nextPresentation: ServerSelectionPresentation =
                profile.presentation === 'grouped' ? 'flat-with-badge' : 'grouped';
            return { ...profile, presentation: nextPresentation };
        });
        params.setServerSelectionGroups(nextProfiles.slice());
    }, [params]);

    return { onToggleConcurrentServer, onTogglePresentation } as const;
}
