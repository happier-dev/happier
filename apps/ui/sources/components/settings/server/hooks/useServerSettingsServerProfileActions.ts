import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { resolveServerProfileScopeId, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { buildSettingHref } from '@/components/settings/catalog/settingDeclarations';
import { homeAdministrationServerSettingsPath } from '@/components/settings/home/governance/homeAdministrationRoutes';
import { HOME_SERVER_SETTINGS } from '@/components/settings/home/governance/homeServerSettings';
import { removeServerProfileUiAction } from '@/components/serverProfiles/removeServerProfileUiAction';
import { presentFirstKeyCredentialLifecycle } from '@/components/account/presentFirstKeyCredentialLifecycle';
import { retargetPendingTerminalConnectToServerUrl } from '@/sync/domains/pending/retargetPendingTerminalConnectToServerUrl';

import { readServerAuthStatus, type ServerAuthStatus } from './useServerAuthStatusByServerId';
import type { ActiveServerSwitchResult } from '@/sync/domains/server/activeServerSwitch';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { offerThisComputerConnectionToHome } from '@/components/serverProfiles/offerThisComputerConnectionToHome';

export function useServerSettingsServerProfileActions(params: Readonly<{
    authStatusByServerId: Readonly<Record<string, ServerAuthStatus>>;
    selectionScope: 'device' | 'tab';
    onSwitchServerById: (serverId: string, scope?: 'device' | 'tab') => Promise<ActiveServerSwitchResult>;
    onAfterSignedOutSwitch: () => void;

    setRevision: React.Dispatch<React.SetStateAction<number>>;
}>) {
    const router = useRouter();
    const onSwitchServer = React.useCallback(async (profile: ServerProfile, scope: 'device' | 'tab' = params.selectionScope) => {
        const scopeId = resolveServerProfileScopeId(profile);
        const knownAuthStatus = params.authStatusByServerId[scopeId]
            ?? params.authStatusByServerId[profile.id]
            ?? 'unknown';
        // Still resolving (or never projected): read it through the canonical
        // resolver, which keeps an unreadable store `unknown`, never `signedOut`.
        const authStatus = knownAuthStatus === 'unknown' ? await readServerAuthStatus(scopeId) : knownAuthStatus;
        const switched =
            await params.onSwitchServerById(scopeId, scope);
        if (switched === 'blocked') return;
        retargetPendingTerminalConnectToServerUrl(profile.serverUrl);
        if (authStatus === 'signedOut') {
            params.onAfterSignedOutSwitch();
        } else {
            await offerThisComputerConnectionToHome(profile);
        }
        params.setRevision((r) => r + 1);
    }, [params]);

    const onRenameServer = React.useCallback(async (profile: ServerProfile) => {
        router.push(buildSettingHref(
            homeAdministrationServerSettingsPath(resolveServerProfileScopeId(profile)),
            HOME_SERVER_SETTINGS.settings.HAPPIER_HOME_DISPLAY_NAME,
        ) as Href);
    }, [router]);

    const onRemoveServer = React.useCallback(async (profile: ServerProfile) => {
        const confirmed = await Modal.confirm(
            t('server.removeServer'),
            t('server.removeServerConfirm', { name: resolveHomeDisplayLabel(profile, profile.id) }),
            { confirmText: t('common.remove'), destructive: true }
        );
        if (!confirmed) return;
        // The removal owner stops this computer serving the Home first (R15 c).
        try {
            await presentFirstKeyCredentialLifecycle({
                run: async () =>
                    await removeServerProfileUiAction({
                        profileId: profile.id,
                        serverUrl: profile.serverUrl,
                    }),
                onCompleted: () => {
                    params.setRevision((r) => r + 1);
                },
            });
        } catch (err) {
            Modal.alert(t('common.error'), String((err as any)?.message ?? err));
        }
    }, [params]);

    return {
        onSwitchServer,
        onRenameServer,
        onRemoveServer,
    } as const;
}
