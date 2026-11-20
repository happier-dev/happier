import { useAuth } from '@/auth/context/AuthContext';
import { Platform, View } from 'react-native';
import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { MainView } from '@/components/navigation/shell/MainView';
import { clearPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { PreAuthOnboardingWizardEntry } from '@/components/onboarding/preAuth/PreAuthOnboardingWizardEntry';
import { usePendingSetupIntent } from '@/components/onboarding/state/usePendingSetupIntent';
import { isAuthenticatedRootDeepLinkRedirectAllowed } from '@/auth/routing/authenticatedRootDeepLinkRedirectAllowed';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { consumeLegacySessionDeepLinkFromWebLocation, resolveLegacySessionDeepLinkRoute } from '@/sync/domains/server/url/consumeLegacySessionDeepLinkFromWebLocation';
import { resolveNewSessionAuthContinuation } from '@/components/sessions/new/navigation/newSessionAuthContinuation';
import { PersonalHomeBootstrapContent, usePersonalHomeBootstrapActive } from '@/components/personalHome/bootstrap/PersonalHomeBootstrapGate';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { shouldKeepDesktopPersonalHomeShell } from '@/components/personalHome/bootstrap/personalHomeIndexRoutePolicy';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useAskHappierStarter } from '@/components/sessions/bots/useAskHappierOffer';
import { resolvePostAuthLanding } from '@/components/onboarding/state/resolvePostAuthLanding';

const stylesheet = StyleSheet.create({
    root: {
        flex: 1,
        position: 'relative',
    },
});

export function Home() {
    const auth = useAuth();
    const router = useRouter();
    const params = useLocalSearchParams<{ id?: string; newSessionAuthContinuation?: string }>();
    const activeServerSnapshot = useActiveServerSnapshot();
    const personalHomeBootstrapActive = usePersonalHomeBootstrapActive();
    const pendingSetupIntent = usePendingSetupIntent();
    const keepDesktopPersonalHomeShell = shouldKeepDesktopPersonalHomeShell({
        isAuthenticated: auth.isAuthenticated,
        isPersonalHomeBootstrapActive: personalHomeBootstrapActive,
    });
    const [showAuthenticated, setShowAuthenticated] = React.useState(auth.isAuthenticated || keepDesktopPersonalHomeShell);
    React.useLayoutEffect(() => {
        if (!auth.isAuthenticated || keepDesktopPersonalHomeShell) {
            setShowAuthenticated(keepDesktopPersonalHomeShell);
            return;
        }
        if (showAuthenticated) return;
        if (params.id || params.newSessionAuthContinuation || pendingSetupIntent || getPendingTerminalConnect() || !isAuthenticatedRootDeepLinkRedirectAllowed()) {
            setShowAuthenticated(true);
            return;
        }
        resolvePostAuthLanding({ replace: router.replace, revealHome: () => setShowAuthenticated(true) });
    }, [auth.isAuthenticated, keepDesktopPersonalHomeShell, params.id, params.newSessionAuthContinuation, pendingSetupIntent, router, showAuthenticated]);

    if (!keepDesktopPersonalHomeShell && (!auth.isAuthenticated || !showAuthenticated)) {
        // Only the active provider owns bootstrap/adoption recovery in the shell. An explicit
        // existing Home bypasses that provider and needs real pre-auth, not Account-only loading.
        return <PreAuthOnboardingWizardEntry />;
    }
    return <Authenticated activeServerId={activeServerSnapshot.serverId} pendingSetupIntent={pendingSetupIntent} />;
}

function Authenticated(props: Readonly<{
    activeServerId: string;
    pendingSetupIntent: ReturnType<typeof usePendingSetupIntent>;
}>) {
    const params = useLocalSearchParams<{
        id?: string | string[];
        messageId?: string | string[];
        jumpChildId?: string | string[];
        serverId?: string | string[];
        newSessionAuthContinuation?: string | string[];
        spawnServerId?: string | string[];
        draftId?: string | string[];
    }>();
    const router = useRouter();
    const activeServerAccountScope = useActiveServerAccountScope();
    const { start: startAskHappier, ready: askHappierReady } = useAskHappierStarter();

    const sessionId = typeof params.id === 'string' ? params.id : Array.isArray(params.id) ? (params.id[0] ?? null) : null;
    const messageId = typeof params.messageId === 'string' ? params.messageId : Array.isArray(params.messageId) ? (params.messageId[0] ?? null) : null;
    const jumpChildId = typeof params.jumpChildId === 'string' ? params.jumpChildId : Array.isArray(params.jumpChildId) ? (params.jumpChildId[0] ?? null) : null;
    const legacySessionRoute = resolveLegacySessionDeepLinkRoute({ sessionId, serverId: params.serverId, messageId, jumpChildId });
    const newSessionAuthContinuation = React.useMemo(() => {
        return resolveNewSessionAuthContinuation({
            activeServerId: props.activeServerId,
            routeParams: params,
        });
    }, [params, props.activeServerId]);
    const { pendingSetupIntent } = props;
    const consumedIntentRef = React.useRef<typeof pendingSetupIntent>(null);
    const pendingTerminalConnect = getPendingTerminalConnect();

    const routeContinuation = isAuthenticatedRootDeepLinkRedirectAllowed() ? newSessionAuthContinuation ?? legacySessionRoute : null;
    const legacyWebLocationConsumed = React.useRef(false);
    React.useEffect(() => {
        if (!isAuthenticatedRootDeepLinkRedirectAllowed()) return;
        if (newSessionAuthContinuation) {
            resolvePostAuthLanding({ replace: router.replace, continuation: newSessionAuthContinuation });
            return;
        }
        if (Platform.OS === 'web' && !legacyWebLocationConsumed.current) {
            legacyWebLocationConsumed.current = consumeLegacySessionDeepLinkFromWebLocation({
                isAuthenticated: true,
                replaceRelativeUrl: (relativeUrl) => {
                    try {
                        window.history.replaceState(null, '', relativeUrl);
                    } catch {
                        // Navigation can still replace the legacy link.
                    }
                },
                navigateToRoute: (continuation) => resolvePostAuthLanding({ replace: router.replace, continuation }),
            });
            if (legacyWebLocationConsumed.current) return;
        }
        if (routeContinuation) resolvePostAuthLanding({ replace: router.replace, continuation: routeContinuation });
    }, [newSessionAuthContinuation, routeContinuation, router]);

    React.useEffect(() => {
        if (normalizeSessionId(sessionId) || newSessionAuthContinuation) return;
        if (!isAuthenticatedRootDeepLinkRedirectAllowed()) return;
        if (pendingTerminalConnect) return;
        if (!pendingSetupIntent || consumedIntentRef.current === pendingSetupIntent) return;
        if (pendingSetupIntent.phase !== 'awaiting_auth' && pendingSetupIntent.phase !== 'post_auth') return;

        if (pendingSetupIntent.branch === 'askHappier') {
            // The authenticated Account can exist before this mounted Action
            // binding resolves. Keep its intent until the same owner can run it.
            if (!askHappierReady) return;
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime) return;
            consumedIntentRef.current = pendingSetupIntent;
            clearPendingSetupIntent();
            fireAndForget((async () => {
                await startAskHappier({ lifetime, context: pendingSetupIntent.context,
                    currentUiContext: pendingSetupIntent.currentUiContext });
            })(), { tag: 'Home.askHappierAuthContinuation' });
            return;
        }
        consumedIntentRef.current = pendingSetupIntent;
        clearPendingSetupIntent();
        resolvePostAuthLanding({
            replace: router.replace,
            continuation: buildMachineAddHref({ path: pendingSetupIntent.branch === 'remoteMachine' ? 'ssh' : 'thisComputer' }),
        });
    }, [activeServerAccountScope, askHappierReady, newSessionAuthContinuation, pendingSetupIntent, pendingTerminalConnect, router, sessionId, startAskHappier]);

    if (routeContinuation || pendingTerminalConnect) return null;
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
