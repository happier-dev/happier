import * as React from 'react';
import { AuthProvider, InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { createCurrentUiContextVoiceToolPort, CurrentUiContextActionHost } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { AppShellPluginUiProjectionProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { RenderWithAppProvidersOptions } from '@/dev/testkit/render/renderWithAppProviders';
import { ModalProvider } from '@/modal/ModalProvider';

type MountedCurrentUiContextOptions = Pick<RenderWithAppProvidersOptions, 'createNodeMock'> & Readonly<{
    /** Match AppShell's host order so the current-context reader observes the foreground modal. */
    withModalProvider?: boolean;
    /** Exercise contributed Actions through AppShell's actual discovery and admission owner. */
    withAppShellActions?: boolean;
    /** Account lifecycle journeys use the App's credential mutation owner. */
    withAccountLifecycle?: boolean;
}>;

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
export async function createMountedCurrentUiContextWrapper(options?: Pick<MountedCurrentUiContextOptions, 'withModalProvider' | 'withAppShellActions' | 'withAccountLifecycle'>) {
    const authority = captureActiveServerAccountScopeLifetime();
    if (!authority) throw new Error('Mounted command fixture requires a restored Account');
    const server = getServerProfileById(authority.scope.serverId);
    if (!server) throw new Error('Mounted command fixture requires its exact Home');
    const credentials = await TokenStorage.getCredentialsForServerUrl(server.serverUrl);
    if (!credentials) throw new Error('Mounted command fixture requires actual Account credentials');
    const Wrapper = (props: React.PropsWithChildren) => {
        const content = <CurrentUiContextProvider>
            <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                {options?.withAppShellActions ? <AppShellPluginUiProjectionProvider>
                    <CurrentUiContextActionHost />{props.children}
                </AppShellPluginUiProjectionProvider> : <><ActionPort />{props.children}</>}
            </PluginSurfaceFocusEligibilityProvider>
        </CurrentUiContextProvider>;
        const app = <MainAppTabStateProvider><AppPaneProvider>
                {options?.withModalProvider ? <ModalProvider>{content}</ModalProvider> : content}
            </AppPaneProvider></MainAppTabStateProvider>;
        return options?.withAccountLifecycle
            ? <AuthProvider initialCredentials={credentials}>{app}</AuthProvider>
            : <InjectedAuthProvider credentials={credentials}>{app}</InjectedAuthProvider>;
    };
    return Wrapper;
}

export async function renderMountedCurrentUiContext(children: React.ReactNode, options?: MountedCurrentUiContextOptions) {
    const { withModalProvider, withAppShellActions, withAccountLifecycle, ...renderOptions } = options ?? {};
    return renderScreen(<>{children}</>, { ...renderOptions, wrapper: await createMountedCurrentUiContextWrapper({ withModalProvider, withAppShellActions, withAccountLifecycle }) });
}
