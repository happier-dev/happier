import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { renameServerProfile, resolveServerProfileScopeId, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { promptSignedOutServerSwitchConfirmation } from '@/components/settings/server/modals/ServerSwitchAuthPrompt';
import { removeServerProfileUiAction } from '@/components/serverProfiles/removeServerProfileUiAction';
import { retargetPendingTerminalConnectToServerUrl } from '@/sync/domains/pending/retargetPendingTerminalConnectToServerUrl';

import type { ServerAuthStatus } from './useServerAuthStatusByServerId';

export function useServerSettingsServerProfileActions(params: Readonly<{
    authStatusByServerId: Readonly<Record<string, ServerAuthStatus>>;
    onSwitchServerById: (serverId: string) => Promise<void>;
    onAfterSignedOutSwitch: () => void;

    setRevision: React.Dispatch<React.SetStateAction<number>>;
}>) {
    const onSwitchServer = React.useCallback(async (profile: ServerProfile) => {
        const scopeId = resolveServerProfileScopeId(profile);
        let authStatus = params.authStatusByServerId[scopeId]
            ?? params.authStatusByServerId[profile.id]
            ?? 'unknown';
        if (authStatus === 'unknown') {
            try {
                const creds = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id });
                authStatus = creds ? 'signedIn' : 'signedOut';
            } catch {
                authStatus = 'unknown';
            }
        }
        if (authStatus === 'signedOut') {
            const shouldContinue = await promptSignedOutServerSwitchConfirmation();
            if (!shouldContinue) return;
        }

        retargetPendingTerminalConnectToServerUrl(profile.serverUrl);

        await params.onSwitchServerById(scopeId);
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
        try {
            await removeServerProfileUiAction({ profileId: profile.id, serverUrl: profile.serverUrl });
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
