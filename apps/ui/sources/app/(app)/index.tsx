import { useAuth } from '@/auth/context/AuthContext';
import { View } from 'react-native';
import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { MainView } from '@/components/navigation/shell/MainView';
import { clearPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { PreAuthOnboardingWizardEntry } from '@/components/onboarding/preAuth/PreAuthOnboardingWizardEntry';
import { usePendingSetupIntent } from '@/components/onboarding/state/usePendingSetupIntent';
import { useOnboardingJourneySessionActive } from '@/components/onboarding/tour/state/journeySession';
import { readJourneyReplayBeatId } from '@/components/onboarding/tour/state/journeyReplayIntent';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { isAuthenticatedRootDeepLinkRedirectAllowed } from '@/auth/routing/authenticatedRootDeepLinkRedirectAllowed';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { resolveNewSessionAuthContinuation } from '@/components/sessions/new/navigation/newSessionAuthContinuation';
import { useVoiceSurfaceE2eFixtureComposition } from '@/dev/testkit/harness/useVoiceSurfaceE2eFixtureComposition';
import { isPersonalHomeBootstrapRuntimeHost } from '@/components/personalHome/bootstrap/personalHomeBootstrapHost';
import { PersonalHomeBootstrapContent } from '@/components/personalHome/bootstrap/PersonalHomeBootstrapGate';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { shouldKeepDesktopPersonalHomeShell } from '@/components/personalHome/bootstrap/personalHomeIndexRoutePolicy';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useAskHappierStarter } from '@/components/sessions/bots/useAskHappierOffer';

const stylesheet = StyleSheet.create({
    root: {
        flex: 1,
        position: 'relative',
    },
});

export function Home() {
    const auth = useAuth();
    const activeServerSnapshot = useActiveServerSnapshot();
    const onboardingJourneyActive = useOnboardingJourneySessionActive();
    const onboardingTourDecision = useFeatureDecision('app.ui.onboardingTour', { scopeKind: 'runtime' });
    const voiceE2eFixture = useVoiceSurfaceE2eFixtureComposition();
    // Explicit replay and a live journey own the viewport; a persisted machine-add
    // continuation routes to its draft instead of relaunching the setup journey.
    const hasExplicitJourneyReplayIntent =
        onboardingTourDecision?.state === 'enabled'
        && readJourneyReplayBeatId() != null;
    const keepDesktopPersonalHomeShell = shouldKeepDesktopPersonalHomeShell({
        isAuthenticated: auth.isAuthenticated,
        isPersonalHomeBootstrapHost: isPersonalHomeBootstrapRuntimeHost(),
    });
    if (
        (!auth.isAuthenticated && !keepDesktopPersonalHomeShell)
        || onboardingJourneyActive
        || hasExplicitJourneyReplayIntent
    ) {
        // The provider-level Personal Home gate is the sole Desktop bootstrap-readiness owner.
        // Once it releases this route, adoption/auth recovery stays in the real shell rather
        // than re-entering the retired pre-auth setup journey.
        return (
            <PreAuthOnboardingWizardEntry />
        );
    }
    return (
        <Authenticated
            activeServerId={activeServerSnapshot.serverId}
            shouldSuppressSetupContinuation={voiceE2eFixture.shouldSuppressOnboarding}
        />
    );
}

function Authenticated(props: Readonly<{
    activeServerId: string;
    shouldSuppressSetupContinuation: boolean;
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
    const startAskHappier = useAskHappierStarter();

    const sessionId = typeof params.id === 'string' ? params.id : Array.isArray(params.id) ? (params.id[0] ?? null) : null;
    const messageId = typeof params.messageId === 'string' ? params.messageId : Array.isArray(params.messageId) ? (params.messageId[0] ?? null) : null;
    const jumpChildId = typeof params.jumpChildId === 'string' ? params.jumpChildId : Array.isArray(params.jumpChildId) ? (params.jumpChildId[0] ?? null) : null;
    const shouldSuppressSetupContinuation = props.shouldSuppressSetupContinuation;
    const sessionRouteServerScope = createSessionRouteServerScope(params);
    const newSessionAuthContinuation = React.useMemo(() => {
        return resolveNewSessionAuthContinuation({
            activeServerId: props.activeServerId,
            routeParams: params,
        });
    }, [params, props.activeServerId]);
    const pendingSetupIntent = usePendingSetupIntent();
    const consumedIntentRef = React.useRef<typeof pendingSetupIntent>(null);
    const pendingTerminalConnect = getPendingTerminalConnect();
    React.useEffect(() => {
        if (!shouldSuppressSetupContinuation || !pendingSetupIntent || pendingSetupIntent.branch === 'askHappier' || pendingSetupIntent.phase === 'dismissed') return;
        setPendingSetupIntent({ ...pendingSetupIntent, phase: 'dismissed' });
    }, [pendingSetupIntent, shouldSuppressSetupContinuation]);

    React.useEffect(() => {
        if (!newSessionAuthContinuation) return;
        router.replace(newSessionAuthContinuation);
    }, [newSessionAuthContinuation, router]);

    React.useEffect(() => {
        const sid = normalizeSessionId(sessionId);
        if (!sid) return;
        if (!isAuthenticatedRootDeepLinkRedirectAllowed()) return;

        const mid = String(messageId ?? '').trim();
        if (mid) {
            const child = String(jumpChildId ?? '').trim();
            router.replace(sessionRouteServerScope.buildHref(sid, {
                suffix: `/message/${encodeURIComponent(mid)}`,
                query: child ? { jumpChildId: child } : undefined,
            }));
            return;
        }

        const child = String(jumpChildId ?? '').trim();
        router.replace(sessionRouteServerScope.buildHref(sid, {
            query: child ? { jumpChildId: child } : undefined,
        }));
    }, [jumpChildId, messageId, router, sessionId, sessionRouteServerScope]);

    React.useEffect(() => {
        if (normalizeSessionId(sessionId) || newSessionAuthContinuation) return;
        if (!isAuthenticatedRootDeepLinkRedirectAllowed()) return;
        if ((shouldSuppressSetupContinuation && pendingSetupIntent?.branch !== 'askHappier') || pendingTerminalConnect) return;
        if (!pendingSetupIntent || consumedIntentRef.current === pendingSetupIntent) return;
        if (pendingSetupIntent.phase !== 'awaiting_auth' && pendingSetupIntent.phase !== 'post_auth') return;

        if (pendingSetupIntent.branch === 'askHappier') {
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
        router.replace(buildMachineAddHref({
            path: pendingSetupIntent.branch === 'remoteMachine' ? 'ssh' : 'thisComputer',
        }));
    }, [activeServerAccountScope, newSessionAuthContinuation, pendingSetupIntent, pendingTerminalConnect, router, sessionId, shouldSuppressSetupContinuation, startAskHappier]);

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
