import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { removeServerProfile, renameServerProfile, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { promptSignedOutServerSwitchConfirmation } from '@/components/settings/server/modals/ServerSwitchAuthPrompt';

import type { ServerAuthStatus } from './useServerAuthStatusByServerId';

export function useServerSettingsServerProfileActions(params: Readonly<{
    authStatusByServerId: Readonly<Record<string, ServerAuthStatus>>;
    onSwitchServerById: (serverId: string) => Promise<void>;
    onAfterSignedOutSwitch: () => void;

    setRevision: React.Dispatch<React.SetStateAction<number>>;

    setServerSelectionActiveTargetKind: (value: 'server' | 'group' | null) => void;
    setServerSelectionActiveTargetId: (value: string | null) => void;
}>) {
    const onSwitchServer = React.useCallback(async (profile: ServerProfile) => {
        let authStatus = params.authStatusByServerId[profile.id] ?? 'unknown';
        if (authStatus === 'unknown') {
            try {
                const creds = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl);
                authStatus = creds ? 'signedIn' : 'signedOut';
            } catch {
                authStatus = 'unknown';
            }
        }
        if (authStatus === 'signedOut') {
            const shouldContinue = await promptSignedOutServerSwitchConfirmation();
            if (!shouldContinue) return;
        }

        params.setServerSelectionActiveTargetKind('server');
        params.setServerSelectionActiveTargetId(profile.id);

        await params.onSwitchServerById(profile.id);
        if (authStatus === 'signedOut') {
            params.onAfterSignedOutSwitch();
        }
        params.setRevision((r) => r + 1);
    }, [params]);

    const onRenameServer = React.useCallback(async (profile: ServerProfile) => {
        const next = await Modal.prompt(
            t('server.renameServer'),
            t('server.renameServerPrompt'),
            { defaultValue: profile.name, placeholder: t('server.serverNamePlaceholder') }
        );
        if (!next) return;
        try {
            renameServerProfile(profile.id, next);
            params.setRevision((r) => r + 1);
        } catch (err) {
            Modal.alert(t('common.error'), String((err as any)?.message ?? err));
        }
    }, [params]);

    const onRemoveServer = React.useCallback(async (profile: ServerProfile) => {
        const confirmed = await Modal.confirm(
            t('server.removeServer'),
            t('server.removeServerConfirm', { name: profile.name }),
            { confirmText: t('common.remove'), destructive: true }
        );
        if (!confirmed) return;

        // Removing a server should clear its local credentials; otherwise re-adding the same URL can
        // resurrect an old token unexpectedly (confusing and potentially unsafe).
        // Do this before removing the profile so TokenStorage can still resolve the serverId scope.
        try {
            await TokenStorage.removeCredentialsForServerUrl(profile.serverUrl);
        } catch {
            // Best-effort only.
        }
        try {
            removeServerProfile(profile.id);
        } catch (err) {
            Modal.alert(t('common.error'), String((err as any)?.message ?? err));
            return;
        }

        params.setRevision((r) => r + 1);
    }, [params]);

    return {
        onSwitchServer,
        onRenameServer,
        onRemoveServer,
    } as const;
}
