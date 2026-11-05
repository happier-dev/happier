import * as React from 'react';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import { TeamAuthEntrySurface } from '@/components/teams/entry/TeamAuthEntrySurface';
import type { TeamAuthEntrySelection } from '@/components/teams/entry/TeamAuthEntrySurface';
import { firstRouteParam } from '@/components/settings/teams/teamRouteParams';
import { teamSessionsPath } from '@/components/settings/teams/teamsRoutes';
import { HomeAuthenticationFlow } from '@/components/account/auth/HomeAuthenticationFlow';
import { TeamAuthenticationStep } from '@/components/teams/entry/TeamAuthenticationStep';
import { projectTeamAuthSelection } from '@/components/teams/entry/teamAuthAction';
import { teamSignInReturnPath, useTeamSignInHome, type TeamSignInHome } from '@/components/teams/entry/teamSignInHome';
import { AccountCredentialJourney } from '@/components/account/auth/AccountCredentialJourney';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { HomeCredentialUnreadableCard } from '@/components/sessions/access/UnboundSessionHomeScopeCard';
import { t } from '@/text';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import type { TeamInvitationPostAuthContinuationV1 } from '@happier-dev/protocol/teams';
import { TeamJoinScreen } from '@/components/teams/join/TeamJoinScreen';
import { UnauthenticatedRouteShell } from '@/components/onboarding/unauthShell';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

function TeamSignInStateShell(props: Readonly<{
    children: React.ReactNode;
    stepId: string;
    onBack: () => void;
}>) {
    return <UnauthenticatedRouteShell testID="team-sign-in-shell" stepId={props.stepId} onBack={props.onBack}>{props.children}</UnauthenticatedRouteShell>;
}

/**
 * Public Team authentication entry; the Home remains explicitly addressed.
 *
 * Every hook runs before the first branch so the state/loading/ready sequence
 * this page moves through cannot reorder them, and no branch renders `null`:
 * a link that cannot be routed still explains itself and offers a way forward.
 */
export default function TeamSignInRoute() {
    const params = useLocalSearchParams<{
        teamId?: string | string[];
        serverId?: string | string[];
        target?: string | string[];
        postAuthInvitation?: string | string[];
    }>();
    const teamId = firstRouteParam(params.teamId);
    const serverId = firstRouteParam(params.serverId);
    const carrier = firstRouteParam(params.target);
    const expectsPostAuthInvitation = firstRouteParam(params.postAuthInvitation) === '1';
    const home = useTeamSignInHome({ carrier, serverId });
    // Expo Router updates a mounted dynamic route's params in place, so a second Team
    // link arrives without a remount. Every state below is bound to ONE Team + Home
    // authority — the claimed post-auth continuation most of all — so the body is keyed
    // by that authority instead of being reset field by field.
    return (
        <AccountCredentialJourney request={home.kind === 'resolved' && home.savedProfileId && !expectsPostAuthInvitation
            ? { kind: 'team', teamId, profileRef: home.savedProfileId }
            : null}>
        <TeamSignInRouteBody
            key={`${teamId}\u0000${carrier || serverId}`}
            teamId={teamId}
            serverId={serverId}
            carrier={carrier}
            expectsPostAuthInvitation={expectsPostAuthInvitation}
            home={home}
        />
        </AccountCredentialJourney>
    );
}

function TeamSignInRouteBody({ teamId, serverId, carrier, expectsPostAuthInvitation, home }: Readonly<{
    teamId: string;
    serverId: string;
    carrier: string;
    expectsPostAuthInvitation: boolean;
    home: TeamSignInHome;
}>) {
    const router = useRouter();
    const navigation = useNavigation();
    const goBackHome = React.useCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: '/' });
    }, [navigation, router]);
    // One owner for which Home this link addresses: it acquires a descriptor
    // carrier in place through the same Homes acquisition flow the join screen
    // consumes, and re-resolves when somebody adopts the Home from the recovery
    // action below, so neither case leaves this page stranded.
    const savedProfileId = home.kind === 'resolved' ? home.savedProfileId : null;
    const scopeResolution = useServerCredentialAccountScopeResolution(savedProfileId);
    const [selection, setSelection] = React.useState<TeamAuthEntrySelection | null>(null);
    /**
     * Choosing another Account re-opens this same Home's authentication without
     * signing anything out or moving the focused Home. It is the same
     * pre-admission recovery the join screen offers, so the Team page keeps its
     * one remedy for "signed in as the wrong Account" rather than inventing a
     * second one.
     */
    const [recoveringIdentity, setRecoveringIdentity] = React.useState(false);
    const selected = selection ? projectTeamAuthSelection(selection) : null;
    const [postAuthState, setPostAuthState] = React.useState<
        | Readonly<{ kind: 'loading' }>
        | Readonly<{ kind: 'ready'; continuation: TeamInvitationPostAuthContinuationV1 }>
        | Readonly<{ kind: 'unavailable' }>
    >({ kind: 'loading' });
    const postAuthClaimRef = React.useRef<Promise<typeof postAuthState> | null>(null);

    React.useEffect(() => {
        if (postAuthState.kind !== 'loading' || !expectsPostAuthInvitation || !teamId || home.kind !== 'resolved'
            || scopeResolution.kind !== 'bound') return;
        let active = true;
        postAuthClaimRef.current ??= (async () => {
            const state = await TokenStorage.readPendingExternalAuthContinuationState();
            const pending = state.value;
            const continuation = pending?.postAuthInvitation;
            const matches = !state.serverMismatch && continuation
                && pending?.serverUrl
                && continuation.teamId === teamId
                && pending?.teamContinuation?.teamId === teamId
                && pending.teamContinuation.homeServerIdentityId === carrier;
            if (!matches) {
                return { kind: 'unavailable' } as const;
            }
            const cleared = await TokenStorage.clearPendingExternalAuth({
                serverUrl: pending.serverUrl,
                serverId: pending.serverId,
                removeExact: pending,
            });
            return cleared
                ? { kind: 'ready', continuation } as const
                : { kind: 'unavailable' } as const;
        })();
        void postAuthClaimRef.current.then((next) => {
            if (active) setPostAuthState(next);
        });
        return () => { active = false; };
    }, [expectsPostAuthInvitation, home, postAuthState.kind, scopeResolution, teamId]);

    // Two unusable-target states with two different remedies, matching the join
    // surface: a carrier this build cannot route is terminal for this device,
    // while a Home it simply has not adopted is the ordinary first-device case.
    if (!teamId || home.kind === 'unresolved' || home.kind === 'ambiguous') {
        return (
            <TeamSignInStateShell stepId="unknown-target" onBack={goBackHome}>
                <SurfaceStateCard
                    testID={home.kind === 'ambiguous'
                        ? 'team-sign-in-ambiguous-home'
                        : 'team-sign-in-unknown-target'}
                    kind="unavailable"
                    title={t('teams.entry.unknownTargetTitle')}
                    reason={t('teams.entry.unknownTargetBody')}
                    action={{ label: t('common.back'), onPress: goBackHome }}
                    accessibilitySemantics="status"
                />
            </TeamSignInStateShell>
        );
    }
    // Nothing is asked of any endpoint until the acquisition owner has proven
    // the descriptor's stable identity, so this is the same wait the join
    // screen shows rather than a Team request in flight.
    if (home.kind === 'acquiring') {
        return (
            <TeamSignInStateShell stepId="acquiring-home" onBack={goBackHome}>
                <SurfaceStateCard
                    testID="team-sign-in-acquiring-home"
                    kind="loading"
                    title={t('common.loading')}
                    accessibilitySemantics="status"
                />
            </TeamSignInStateShell>
        );
    }
    if (home.kind === 'acquisition_failed') {
        return (
            <TeamSignInStateShell stepId="unreachable-home" onBack={goBackHome}>
                <SurfaceStateCard
                    testID="team-sign-in-unreachable-home"
                    kind="unavailable"
                    title={t('teams.join.unknownHomeTitle')}
                    reason={t('server.notificationAddServerHint')}
                    action={{ label: t('common.retry'), onPress: home.retry }}
                    secondaryAction={{ label: t('server.addServerTitle'), onPress: () => router.push('/server') }}
                    accessibilitySemantics="status"
                />
            </TeamSignInStateShell>
        );
    }
    if (home.kind === 'unknown_home') {
        return (
            <TeamSignInStateShell stepId="unknown-home" onBack={goBackHome}>
                <SurfaceStateCard
                    testID="team-sign-in-add-home"
                    kind="unavailable"
                    title={t('teams.join.unknownHomeTitle')}
                    reason={t('server.notificationAddServerHint')}
                    action={{ label: t('server.addServerTitle'), onPress: () => router.push('/server') }}
                    accessibilitySemantics="status"
                />
            </TeamSignInStateShell>
        );
    }
    // Only a Home with a local credential has a scope to wait for. A Home this
    // device addresses but has not signed in to is simply an anonymous visit.
    if (savedProfileId !== null && scopeResolution.kind === 'resolving') {
        return (
            <TeamSignInStateShell stepId="resolving-account" onBack={goBackHome}>
                <SurfaceStateCard
                    testID="team-sign-in-resolving"
                    kind="loading"
                    title={t('common.loading')}
                    accessibilitySemantics="status"
                />
            </TeamSignInStateShell>
        );
    }

    // This device could not read its saved credential for the Home. Whether an
    // Account is saved here is unknown, so offering sign-in could replace a
    // credential that still exists: the same remedy as Team join (re-read or
    // go back), and post-auth invitation custody stays unclaimed.
    if (savedProfileId !== null && scopeResolution.kind === 'unavailable') {
        return (
            <TeamSignInStateShell stepId="credential-unavailable" onBack={goBackHome}>
                <HomeCredentialUnreadableCard
                    serverId={savedProfileId}
                    testID="team-sign-in-home-unavailable"
                    secondaryAction={{ label: t('common.back'), onPress: goBackHome }}
                />
            </TeamSignInStateShell>
        );
    }

    // A post-auth marker does not prove a usable Account credential. Only the
    // bound state may claim the opaque continuation; a signed-out credential
    // state keeps custody intact and uses the ordinary exact-Home
    // authentication surface below.
    if (expectsPostAuthInvitation && scopeResolution.kind === 'bound') {
        if (postAuthState.kind === 'loading') return (
            <TeamSignInStateShell stepId="post-auth-loading" onBack={goBackHome}>
                <SurfaceStateCard testID="team-sign-in-post-auth-loading" kind="loading" title={t('common.loading')} accessibilitySemantics="status" />
            </TeamSignInStateShell>
        );
        if (postAuthState.kind === 'unavailable') return (
            <TeamSignInStateShell stepId="post-auth-unavailable" onBack={goBackHome}>
                <SurfaceStateCard
                    testID="team-sign-in-post-auth-unavailable"
                    kind="unavailable"
                    title={t('teams.join.inactiveTitle')}
                    reason={t('teams.join.askForNew')}
                    action={{ label: t('common.back'), onPress: goBackHome }}
                    accessibilitySemantics="status"
                />
            </TeamSignInStateShell>
        );
        return (
            <TeamJoinScreen
                postAuthContinuation={postAuthState.continuation}
                homeTarget={carrier ?? serverId}
            />
        );
    }

    const returnTo = teamSignInReturnPath({
        teamId,
        carrier,
        serverId,
        postAuthInvitation: expectsPostAuthInvitation,
    });
    if (selection && selected) {
        // A Home-origin mTLS action still needs the exact Team-bound native
        // continuation. Unlike ordinary Home mTLS, the native callback must
        // return to this Team without inferring it from the focused Home or
        // manufacturing membership authority.
        const requiresTeamContinuation = selection.action.origin === 'team'
            || selected.execution.kind === 'mtls';
        return (
            <TeamAuthenticationStep selection={selection} onBack={() => setSelection(null)}>
                <HomeAuthenticationFlow
                    target={home.target}
                    actions={[selected]}
                    openChosenAction
                    returnTo={returnTo}
                    teamAdmission={requiresTeamContinuation ? {
                        teamId: selection.teamId,
                        accountSelection: recoveringIdentity ? 'another' : 'current',
                    } : undefined}
                    onAuthenticated={() => router.replace(returnTo)}
                    onBack={() => setSelection(null)}
                />
            </TeamAuthenticationStep>
        );
    }
    if (scopeResolution.kind === 'bound' && !recoveringIdentity) return (
        <TeamAuthEntrySurface
            teamId={teamId}
            target={home.target}
            onBack={goBackHome}
            accountScope={scopeResolution.scope}
            accountServiceReturnTo={returnTo}
            onContinue={() => router.replace(teamSessionsPath({
                serverId: scopeResolution.scope.serverId,
                teamId,
            }))}
            onRecoverIdentity={() => setRecoveringIdentity(true)}
            onSelectAction={(next) => setSelection(next)}
        />
    );
    return (
        <TeamAuthEntrySurface
            teamId={teamId}
            target={home.target}
            onBack={goBackHome}
            accountServiceReturnTo={returnTo}
            onUseCurrentAccount={recoveringIdentity ? () => setRecoveringIdentity(false) : undefined}
            onSelectAction={(next) => setSelection(next)}
        />
    );
}
