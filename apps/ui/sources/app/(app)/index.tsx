import { useAuth } from '@/auth/context/AuthContext';
import { Platform, View } from 'react-native';
import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter, useLocalSearchParams, useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { MainView } from '@/components/navigation/shell/MainView';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { WorkspacePhoneHomeArrivalContext, WorkspaceShellWillHostRoutesContext } from '@/components/appShell/workspace/WorkspaceRouteHostingContext';
import { clearPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { PreAuthOnboardingWizardEntry } from '@/components/onboarding/preAuth/PreAuthOnboardingWizardEntry';
import { usePendingSetupIntent } from '@/components/onboarding/state/usePendingSetupIntent';
import { isAuthenticatedRootDeepLinkRedirectAllowed } from '@/auth/routing/authenticatedRootDeepLinkRedirectAllowed';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { readLegacySessionDeepLinkFromWebLocation, resolveLegacySessionDeepLinkRoute } from '@/sync/domains/server/url/consumeLegacySessionDeepLinkFromWebLocation';
import { resolveNewSessionAuthContinuation } from '@/components/sessions/new/navigation/newSessionAuthContinuation';
import { PersonalHomeBootstrapContent, usePersonalHomeBootstrapActive } from '@/components/personalHome/bootstrap/PersonalHomeBootstrapGate';
import { useFirstRunPersonalHome } from '@/components/personalHome/bootstrap/personalHomeBootstrapRequest';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { shouldKeepDesktopPersonalHomeShell } from '@/components/personalHome/bootstrap/personalHomeIndexRoutePolicy';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useAskHappierStarter } from '@/components/sessions/bots/useAskHappierOffer';
import { terminalConnectResumeHref } from '@/auth/terminal/terminalConnectContinuation';
import { resolvePostAuthLanding } from '@/components/onboarding/state/resolvePostAuthLanding';

const stylesheet = StyleSheet.create({
    root: {
        flex: 1,
        position: 'relative',
    },
});

function firstParam(value?: string | string[]): string | null {
    return (Array.isArray(value) ? value[0] : value) ?? null;
}

export function Home() {
    const { isAuthenticated } = useAuth();
    const router = useRouter();
    const focused = useIsFocused();
    const destinationInstance = useDestinationInstanceKey();
    const workspaceWillHostHome = React.useContext(WorkspaceShellWillHostRoutesContext);
    const phoneHomeArrival = React.useContext(WorkspacePhoneHomeArrivalContext);
    const params = useLocalSearchParams<{
        id?: string | string[];
        messageId?: string | string[];
        jumpChildId?: string | string[];
        serverId?: string | string[];
        newSessionAuthContinuation?: string | string[];
        spawnServerId?: string | string[];
        draftId?: string | string[];
    }>();
    const { serverId } = useActiveServerSnapshot();
    const scope = useActiveServerAccountScope(serverId);
    const pendingSetup = usePendingSetupIntent();
    const firstRun = useFirstRunPersonalHome();
    const { start: startAskHappier, ready: askHappierReady } = useAskHappierStarter();
    const keepBootstrapShell = shouldKeepDesktopPersonalHomeShell({
        isAuthenticated,
        isPersonalHomeBootstrapActive: usePersonalHomeBootstrapActive(),
    });
    const [homeVisible, setHomeVisible] = React.useState(false);
    const interactive = React.useRef(!isAuthenticated && !keepBootstrapShell);
    const applying = React.useRef(false);

    // Only the focused root completes inline auth. A separate auth route owns its
    // explicit continuation and arrives here already authenticated if it chose Home.
    React.useLayoutEffect(() => {
        if (firstRun) {
            interactive.current = true;
            return;
        }
        if (!isAuthenticated) {
            applying.current = false;
            interactive.current = focused && !keepBootstrapShell;
            setHomeVisible(false);
            return;
        }
        if (!focused) {
            interactive.current = false;
            applying.current = false;
            return;
        }
        if (Platform.OS === 'web' && !isAuthenticatedRootDeepLinkRedirectAllowed()) {
            interactive.current = false;
            setHomeVisible(true);
            return;
        }
        if (applying.current) return;
        const admittedHome = phoneHomeArrival?.take();
        if (admittedHome) {
            applying.current = true;
            router.replace(admittedHome);
            return;
        }

        const apply = (continuation?: Parameters<typeof resolvePostAuthLanding>[0]['continuation'], afterReveal?: () => void) => {
            applying.current = true;
            resolvePostAuthLanding({
                replace: router.replace, continuation,
                revealHome: (href) => {
                    interactive.current = false;
                    if (href === '/home') {
                        if (!phoneHomeArrival?.defer(href)) router.replace(href);
                    } else {
                        applying.current = false;
                        setHomeVisible(true);
                    }
                    afterReveal?.();
                },
            });
        };
        if (getPendingTerminalConnect()) {
            // Custody is only claimed by its Home Account. Leave the entry in place
            // while that binding hydrates, without showing Home or a lower-priority route.
            if (scope) apply(terminalConnectResumeHref());
            return;
        }

        const continuation = resolveNewSessionAuthContinuation({ activeServerId: serverId, routeParams: params })
            ?? (Platform.OS === 'web' ? readLegacySessionDeepLinkFromWebLocation() : null)
            ?? resolveLegacySessionDeepLinkRoute({
                sessionId: firstParam(params.id), serverId: params.serverId,
                messageId: firstParam(params.messageId), jumpChildId: firstParam(params.jumpChildId),
            });
        if (continuation) {
            apply(continuation);
            return;
        }

        if (pendingSetup && (pendingSetup.phase === 'awaiting_auth' || pendingSetup.phase === 'post_auth')) {
            if (pendingSetup.branch === 'askHappier') {
                // The credentials can arrive before the Action binding.
                const lifetime = captureActiveServerAccountScopeLifetime();
                if (!askHappierReady || !lifetime) return;
                clearPendingSetupIntent();
                apply(undefined, () => fireAndForget(startAskHappier({
                    lifetime, context: pendingSetup.context, currentUiContext: pendingSetup.currentUiContext,
                }), { tag: 'Home.askHappierAuthContinuation' }));
                return;
            }
            clearPendingSetupIntent();
            apply(buildMachineAddHref({ path: pendingSetup.branch === 'remoteMachine' ? 'ssh' : 'thisComputer' }));
            return;
        }

        if (!homeVisible) {
            if (interactive.current) apply();
            else setHomeVisible(true);
        }
    }, [askHappierReady, firstRun, focused, homeVisible, isAuthenticated, keepBootstrapShell, params, pendingSetup,
        phoneHomeArrival, router, scope, serverId, startAskHappier]);

    if (firstRun) {
        return <PersonalHomeBootstrapContent><PreAuthOnboardingWizardEntry /></PersonalHomeBootstrapContent>;
    }
    if (!keepBootstrapShell && (!isAuthenticated || !homeVisible)) {
        return !isAuthenticated || interactive.current ? <PreAuthOnboardingWizardEntry /> : null;
    }
    // Expo keeps the public step long enough to capture it. The retained workspace owns the next Home.
    if (!keepBootstrapShell && workspaceWillHostHome && destinationInstance === null) return null;
    return (
        <View style={stylesheet.root}>
            <PersonalHomeBootstrapContent>
                <MainView variant="phone" />
            </PersonalHomeBootstrapContent>
        </View>
    );
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { Home as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={Home} />; }
