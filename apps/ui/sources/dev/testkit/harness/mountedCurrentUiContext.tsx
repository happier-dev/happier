import * as React from 'react';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { RenderWithAppProvidersOptions } from '@/dev/testkit/render/renderWithAppProviders';

function ActionPort() {
    const reader = useOptionalCurrentUiContextReader();
    React.useEffect(() => {
        if (!reader) return;
        return registerCurrentUiContextActionPort((surface, hostAction) => createCurrentUiContextVoiceToolPort({ reader,
            invocationSurface: surface, hostAction, readProjection: () => null, readNavigationBinding: () => null }));
    }, [reader]);
    return null;
}

/** Real mounted command publication and Action port. Install Home/Socket boundaries before importing. */
export async function renderMountedCurrentUiContext(children: React.ReactNode, options?: Pick<RenderWithAppProvidersOptions, 'createNodeMock'>) {
    const authority = captureActiveServerAccountScopeLifetime();
    if (!authority) throw new Error('Mounted command fixture requires a restored Account');
    const server = getServerProfileById(authority.scope.serverId);
    if (!server) throw new Error('Mounted command fixture requires its exact Home');
    const credentials = await TokenStorage.getCredentialsForServerUrl(server.serverUrl);
    if (!credentials) throw new Error('Mounted command fixture requires actual Account credentials');
    return renderScreen(<InjectedAuthProvider credentials={credentials}>
        <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
            <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                <ActionPort />{children}
            </PluginSurfaceFocusEligibilityProvider>
        </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
    </InjectedAuthProvider>, options);
}
