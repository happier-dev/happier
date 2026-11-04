import * as React from 'react';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getCurrentAuth } from '@/auth/context/currentAuth';
import { ExactHomeDestinationNotice } from '@/components/account/auth/ExactHomeDestinationNotice';
import { useExactHomeDestination } from '@/components/account/auth/useExactHomeDestination';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { HomeTargetInput } from '@happier-dev/cli-common/homeTarget';
import type {
    AuthEntryActionV1,
    AuthEntryProjectionV1,
    TeamInvitationAcceptResultV1,
    TeamEntryUnavailableReasonV1,
    TeamInvitationPostAuthContinuationV1,
} from '@happier-dev/protocol';

import { fetchAuthEntry } from '@/auth/entry/authEntryClient';
import { resolveHomeAuthenticationTarget } from '@/auth/flows/resolveHomeAuthenticationTarget';
import {
    useAccountServiceEntryOptions,
    type AccountServiceEntryTargetContext,
} from '@/components/account/auth/useAccountServiceEntryOptions';
import { describeHomeAuthenticationAction } from '@/components/account/auth/homeAuthenticationActionPresentation';
import { buildAuthenticatedAccountEntryHref } from '@/components/navigation/accountEntry/authenticatedAccountEntryRoute';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { asIconName } from '@/components/ui/icons/asIconName';
import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
import {
    WelcomeActionList,
    type WelcomeActionAdmission,
} from '@/components/onboarding/preAuth/WelcomeActionList';
import { projectTeamAuthAction } from '@/components/teams/entry/teamAuthAction';
import { teamSignInReturnPath } from '@/components/teams/entry/teamSignInHome';
import {
    presentTeamEntryUnavailableReason,
    presentTeamsDisabledOnHome,
} from '@/components/teams/entry/teamAuthenticationFailure';
import { resolveTeamJoinPresentation } from '@/components/teams/join/teamJoinOutcome';
import { TeamInvitationPreviewDetails } from '@/components/teams/join/TeamInvitationPreviewDetails';
import { TeamJoinedCard } from '@/components/teams/join/TeamJoinedCard';
import { useTeamInvitationPreview, type TeamInvitationPreviewState } from '@/hooks/teams/useTeamInvitationPreview';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { resolveFeatureAvailabilityArm } from '@/hooks/server/resolveFeatureAvailabilityArm';
import { UnauthenticatedRouteShell } from '@/components/onboarding/unauthShell';
import { TEAM_ENTRY_LOGO_SIZE, TeamEntryIdentity, type TeamEntryLogo } from '@/components/teams/entry/TeamEntryIdentity';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { formatAccountDisplayName, resolveViewerAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import type { HomeDomainFailure } from '@/sync/ops/teams/teamActionClient';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import {
    acceptTeamInvitation,
} from '@/sync/ops/teams/teamInvitationOperations';

type TeamAuthenticationAction = Extract<AuthEntryActionV1, { kind: 'authenticate' }>;
type TeamAdmissionProjection = Extract<AuthEntryProjectionV1, { state: 'admission_required' }>;
type InvitationAdmissionProjection = Extract<TeamAdmissionProjection, { scope: { kind: 'invitation' } }>;
/** The Home's answer for a caller it already recognizes as an effective member. */
type TeamContinueProjection = Extract<AuthEntryProjectionV1, { state: 'already_member' }>;
type TeamEntryProjection = TeamAdmissionProjection | TeamContinueProjection;
/** The Home's `unavailable` answer for a Team or invitation destination, with its reason. */
type TeamEntryUnavailableProjection = Extract<
    AuthEntryProjectionV1,
    { state: 'unavailable'; scope: { kind: 'team' | 'invitation' } }
>;

function isTeamEntryUnavailable(
    projection: AuthEntryProjectionV1,
): projection is TeamEntryUnavailableProjection {
    return projection.state === 'unavailable' && projection.scope.kind !== 'home';
}

type InvitationAdmissionSuccess = Extract<
    TeamInvitationAcceptResultV1,
    { outcome: 'joined' | 'already_member' }
>;
type InvitationAdmissionTerminal = Exclude<TeamInvitationAcceptResultV1, InvitationAdmissionSuccess>;

export type TeamAuthEntrySelection = Readonly<{
    action: TeamAuthenticationAction;
    teamId: string;
    teamName: string;
    /** The Team's logo, so the chosen sign-in step keeps the same identity header. */
    teamLogo?: TeamEntryLogo;
    /** Preserve the caller-supplied authority carrier instead of rebuilding it from the focused Home. */
    target: HomeTargetInput;
    /** Derived only from the Home's bounded invitation preview, never from the bearer shape. */
    invitationEmailVerificationRequired?: boolean;
}>;

type LoadState =
    | Readonly<{ kind: 'loading'; requestKey: symbol }>
    | Readonly<{ kind: 'ready'; requestKey: symbol; projection: TeamEntryProjection; refreshing: boolean }>
    | Readonly<{ kind: 'unavailable'; requestKey: symbol; reason: TeamEntryUnavailableReasonV1 }>
    | Readonly<{ kind: 'incompatible'; requestKey: symbol }>
    | Readonly<{ kind: 'offline'; requestKey: symbol }>;

type AdmissionState =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'failed'; failure: HomeDomainFailure }>
    | Readonly<{ kind: 'incompatible' }>
    | Readonly<{ kind: 'terminal'; outcome: InvitationAdmissionTerminal['outcome'] }>
    /**
     * The deferred approval for this exact admission was refused, canceled or
     * failed. Nobody was admitted and the invitation itself is untouched, so
     * this is a retryable answer about the request rather than about the offer.
     */
    | Readonly<{ kind: 'approval_refused'; code: string }>
    /**
     * Admitted. The result is retained rather than consumed immediately because
     * opening the Team is an explicit transition the person makes: navigating
     * away on their behalf would replace the one moment that tells them what
     * just happened, and an already-member answer is not a request to leave the
     * page either.
     */
    | Readonly<{
        kind: 'complete';
        entryKey: symbol;
        accountScope: ServerAccountScope;
        result: InvitationAdmissionSuccess;
        requiresHomeArrival: boolean;
    }>;


/**
 * An invitation is usually opened by someone new to the Home, so the Home's
 * first sign-up journey leads its own methods, as it does on Welcome for a
 * first-time visitor. Team connections keep their place ahead of them.
 */
function leadWithHomeSignUp(actions: readonly AuthEntryActionV1[]): readonly AuthEntryActionV1[] {
    const isHome = (action: AuthEntryActionV1) => action.kind === 'authenticate' && action.origin === 'home';
    const firstHome = actions.findIndex(isHome);
    const firstSignUp = actions.findIndex((action) => isHome(action)
        && action.kind === 'authenticate' && action.action === 'provision');
    if (firstHome < 0 || firstSignUp <= firstHome) return actions;
    const ordered = [...actions];
    const [signUp] = ordered.splice(firstSignUp, 1);
    ordered.splice(firstHome, 0, signUp!);
    return ordered;
}
const NOOP = () => {};

function accountServiceAddressLabel(canonicalServerUrl: string): string {
    try {
        return new URL(canonicalServerUrl).host;
    } catch {
        return canonicalServerUrl;
    }
}

function isMatchingReadyState(
    state: LoadState,
    requestKey: symbol,
): state is Extract<LoadState, { kind: 'ready' }> {
    return state.kind === 'ready' && state.requestKey === requestKey;
}

function isInvitationAdmissionProjection(
    projection: TeamEntryProjection,
): projection is InvitationAdmissionProjection {
    return projection.state === 'admission_required' && projection.scope.kind === 'invitation';
}

type TeamAuthEntrySurfaceProps = Readonly<{
    target: HomeTargetInput;
    /** Credential resolution may temporarily withdraw scope without retiring this entry. */
    accountScopeResolving?: boolean;
    onSelectAction: (selection: TeamAuthEntrySelection) => Promise<void> | void;
    onBack?: () => void;
    /**
     * Re-opens authentication on this same Home before an addressed invitation
     * is accepted with the current Account. It is deliberately separate from
     * {@link onBack}: leaving the page and choosing another Account are different
     * intents, and a shell back control must not silently mean the second one.
     */
    onRecoverIdentity?: () => void;
    /** Returns a recovery attempt to the already-bound Account without accepting the invitation. */
    onUseCurrentAccount?: () => void;
    /**
     * Where the account-service handoff comes back to. Without an explicit path,
     * the resolved Team and Home identify the canonical Team sign-in destination.
     */
    accountServiceReturnTo?: string;
}> & (
    | Readonly<{
        teamId: string;
        accountScope?: never;
        onContinue?: never;
        invitation?: never;
        onAdmissionComplete?: never;
    }>
    /**
     * Team entry for somebody already signed in to that exact Home. The scope is
     * what lets the Home answer as this Account; a caller without one — or on a
     * different Home — gets the ordinary anonymous admission page.
     */
    | Readonly<{
        teamId: string;
        accountScope: ServerAccountScope;
        onContinue: () => Promise<void> | void;
        invitation?: never;
        onAdmissionComplete?: never;
    }>
    | Readonly<{
        teamId?: never;
        accountScope?: never;
        onContinue?: never;
        invitation:
            | Readonly<{ token: string; accountScope?: ServerAccountScope }>
            | Readonly<{ continuation: TeamInvitationPostAuthContinuationV1; accountScope?: ServerAccountScope }>;
        onAdmissionComplete: (result: InvitationAdmissionSuccess) => Promise<void> | void;
    }>
);

function admissionFailureTitle(failure: HomeDomainFailure): string {
    switch (failure.kind) {
        case 'outcome_unknown':
            return t('teams.join.acceptanceOutcomeUnknown');
        case 'unreachable':
        case 'unknown':
            return t('teams.join.offlineTitle');
        case 'unsupported':
        case 'invalid':
            return t('teams.join.updateRequiredTitle');
        case 'unauthorized':
            return t('teams.join.inactiveTitle');
        case 'forbidden':
            return t('teams.errors.forbidden');
        case 'conflict':
            return t('teams.errors.conflict');
    }
}

/**
 * What the shared approval owner decided, in the words this surface already
 * speaks. The codes come from the Action approval lifecycle, not from the Home's
 * invitation vocabulary, so they are presented as approval outcomes rather than
 * mistaken for something the invitation did.
 */
function approvalRefusalTitle(code: string): string {
    switch (code) {
        case 'approval_rejected':
            return t('approvals.status.rejected');
        case 'approval_canceled':
            return t('approvals.status.canceled');
        default:
            return t('approvals.status.failed');
    }
}

export const TeamAuthEntrySurface = React.memo(function TeamAuthEntrySurface(props: TeamAuthEntrySurfaceProps) {
    const router = useRouter();
    const destination = useExactHomeDestination({
        refreshAuth: React.useCallback(async () => {
            await getCurrentAuth()?.refreshFromActiveServer();
        }, []),
    });
    const resolvedTarget = React.useMemo(
        () => resolveHomeAuthenticationTarget(props.target),
        [props.target],
    );
    const invitation = props.invitation;
    const invitationToken = invitation && 'token' in invitation ? invitation.token : undefined;
    const invitationContinuation = invitation && 'continuation' in invitation
        ? invitation.continuation
        : undefined;
    const teamId = props.teamId ?? invitationContinuation?.teamId;
    // One Account scope for both variants: the invitation branch admits with it,
    // and the Team branch asks the Home as that Account. Both must belong to the
    // Home the caller named, which the effect below verifies before anything is sent.
    // It is rebuilt from its two identifying parts so a caller passing an inline
    // object cannot restart the request on every render.
    const scopeServerId = (invitation?.accountScope ?? props.accountScope)?.serverId;
    const scopeAccountId = (invitation?.accountScope ?? props.accountScope)?.accountId;
    const accountScope = React.useMemo<ServerAccountScope | undefined>(
        () => (scopeServerId && scopeAccountId
            ? { serverId: scopeServerId, accountId: scopeAccountId }
            : undefined),
        [scopeServerId, scopeAccountId],
    );
    const entryKey = React.useMemo(
        () => Symbol('team-auth-entry-destination'),
        [
            resolvedTarget?.serverIdentityId,
            resolvedTarget?.endpointUrl,
            teamId,
            invitationToken,
            invitationContinuation?.reference,
        ],
    );
    const requestKey = React.useMemo(
        () => Symbol('team-auth-entry-request'),
        [entryKey, accountScope],
    );
    const [retryRevision, setRetryRevision] = React.useState(0);
    const [loadState, setLoadState] = React.useState<LoadState>({ kind: 'loading', requestKey });
    // Diagnose a refusal only; a successful contextual projection remains the
    // sole owner of choices/admission and needs no competing capability probe.
    const teamsDecision = useFeatureDecision('teams', {
        scopeKind: 'spawn',
        serverId: loadState.requestKey === requestKey
            && (loadState.kind === 'unavailable' || loadState.kind === 'incompatible' || loadState.kind === 'offline')
            ? resolvedTarget?.serverId
            : null,
    });
    const [admissionState, setAdmissionState] = React.useState<AdmissionState>({ kind: 'idle' });
    const completedAdmission = admissionState.kind === 'complete' && admissionState.entryKey === entryKey
        ? admissionState
        : null;
    const [pendingActionId, setPendingActionId] = React.useState<string | null>(null);
    const activeActionIdRef = React.useRef<string | null>(null);
    const currentRequestKeyRef = React.useRef(requestKey);
    currentRequestKeyRef.current = requestKey;

    /**
     * Process-local custody for one deferred admission approval.
     *
     * Accepting an invitation is a dangerous, deferred, result-required intent,
     * so an explicit UI-approval requirement produces a durable approval request
     * instead of a join. This is the same shared owner the Team shell uses; the
     * bearer is what identifies this exact offer, and the key has the same
     * process-local residency as the bearer already held in props, so an
     * approval granted for another invitation, Account or Home cannot satisfy
     * it.
     */
    const invitationAuthority = invitationToken ?? invitationContinuation?.reference;
    const approvalScopeKey = invitationAuthority && accountScope
        ? `team-invitation-accept:${accountScope.serverId}:${accountScope.accountId}:${invitationAuthority}`
        : `team-auth-entry:${resolvedTarget?.serverId ?? ''}:${teamId ?? ''}`;
    const { approvalId, approvalPending, requestApproval } = useActionApprovalContinuation({
        scopeKey: approvalScopeKey,
        serverId: accountScope?.serverId ?? '',
        // The admission's own answer arrives on the continuation. This surface
        // owns no projection to re-read, so there is nothing to refresh.
        onExecuted: NOOP,
    });

    React.useEffect(() => {
        // Admission has already consumed this invitation. Credential rebinding
        // cannot undo that fact or replace the mounted card and its name draft.
        // A different invitation or Home still starts its own entry request.
        if (completedAdmission) return;
        setAdmissionState({ kind: 'idle' });
        if (props.accountScopeResolving) {
            setLoadState({ kind: 'loading', requestKey });
            return;
        }
        if (
            !resolvedTarget
            || (invitationToken === undefined && teamId === undefined)
            || (accountScope && !areServerProfileIdentifiersEquivalent(
                accountScope.serverId,
                resolvedTarget.serverId,
            ))
        ) {
            // No destination was resolvable at all, so there is nothing this
            // client may say about it beyond the Home's non-enumerating answer.
            setLoadState({ kind: 'unavailable', requestKey, reason: 'entry_not_available' });
            return;
        }

        const controller = new AbortController();
        setLoadState((current) => isMatchingReadyState(current, requestKey)
            ? { ...current, refreshing: true }
            : { kind: 'loading', requestKey });

        void (async () => {
            const transport = {
                endpointUrl: resolvedTarget.endpointUrl,
                serverId: resolvedTarget.serverId,
                signal: controller.signal,
            };
            // Each scope is requested through its own branch so the request stays
            // exactly one discriminated shape. The invitation bearer remains the
            // admission authority; an authenticated Account scope adds only the
            // bounded mailbox-relationship fact needed before confirmation.
            const result = invitationToken !== undefined
                ? await fetchAuthEntry({
                    ...transport,
                    scope: { kind: 'invitation', token: invitationToken },
                    ...(accountScope ? { accountScope } : {}),
                })
                : invitationContinuation !== undefined
                    ? await fetchAuthEntry({
                        ...transport,
                        scope: { kind: 'invitation', continuation: invitationContinuation },
                        ...(accountScope ? { accountScope } : {}),
                    })
                    : teamId !== undefined
                        ? await fetchAuthEntry({
                            ...transport,
                            scope: { kind: 'team', teamId },
                            ...(accountScope ? { accountScope } : {}),
                        })
                        : null;
            if (result === null) return;
            if (controller.signal.aborted) return;

            if (result.kind === 'ready') {
                const projection = result.projection;
                const hasMatchingScope = invitationToken !== undefined || invitationContinuation !== undefined
                    ? projection.scope.kind === 'invitation'
                    : projection.scope.kind === 'team';
                if (
                    hasMatchingScope
                    && (projection.state === 'admission_required' || projection.state === 'already_member')
                    && (teamId === undefined || projection.team.teamId === teamId)
                ) {
                    setLoadState({ kind: 'ready', requestKey, projection, refreshing: false });
                    return;
                }
                const terminal: LoadState = hasMatchingScope && isTeamEntryUnavailable(projection)
                    ? { kind: 'unavailable', requestKey, reason: projection.reason }
                    : { kind: 'incompatible', requestKey };
                setLoadState((current) => isMatchingReadyState(current, requestKey)
                    ? { ...current, refreshing: false }
                    : terminal);
                return;
            }

            const terminalKind: 'offline' | 'incompatible' = result.kind === 'unavailable'
                ? 'offline'
                : 'incompatible';
            setLoadState((current) => isMatchingReadyState(current, requestKey)
                ? { ...current, refreshing: false }
                : { kind: terminalKind, requestKey });
        })();

        return () => controller.abort();
    }, [
        accountScope,
        completedAdmission,
        invitationToken,
        invitationContinuation,
        props.accountScopeResolving,
        requestKey,
        resolvedTarget,
        retryRevision,
        teamId,
    ]);

    const runAction = React.useCallback(async (
        actionId: string,
        action: () => Promise<void> | void,
    ) => {
        if (activeActionIdRef.current !== null) return;
        activeActionIdRef.current = actionId;
        setPendingActionId(actionId);
        try {
            await action();
        } finally {
            if (activeActionIdRef.current === actionId) {
                activeActionIdRef.current = null;
                setPendingActionId(null);
            }
        }
    }, []);
    const effectivePendingActionId = loadState.kind === 'ready' && loadState.refreshing
        ? 'team-auth-entry-refreshing'
        : pendingActionId;
    const admission = React.useMemo<WelcomeActionAdmission>(() => ({
        pendingActionId: effectivePendingActionId,
        run: runAction,
    }), [effectivePendingActionId, runAction]);
    const retry = React.useCallback(() => {
        // Clear a completed admission attempt synchronously. The entry projection may
        // already be ready, so leaving this terminal state in place until the fetch
        // effect runs makes Retry appear to do nothing and lets callers observe stale UI.
        setAdmissionState({ kind: 'idle' });
        setLoadState({ kind: 'loading', requestKey });
        setRetryRevision((revision) => revision + 1);
    }, [requestKey]);

    /**
     * The bounded preview is the canonical owner of what accepting this exact
     * invitation does. Its public pre-authentication transport means the offer's
     * consequences are stated before anybody signs in, not only before the final
     * press — and it is what the explicit confirmation below is a confirmation
     * *of*, so the Join action stays withheld until this Home has described an
     * active offer rather than letting somebody accept an unread consequence.
     */
    const publicPreviewState = useTeamInvitationPreview({
        target: invitationToken ? props.target : undefined,
        token: invitationToken,
        revision: retryRevision,
    });
    // Opaque custody cannot be sent to the public bearer endpoint. Auth entry
    // resolves the same bounded offer for its exact Account without consuming it.
    const heldPreview = isMatchingReadyState(loadState, requestKey)
        && isInvitationAdmissionProjection(loadState.projection)
        ? loadState.projection.preview
        : undefined;
    const previewState: TeamInvitationPreviewState = invitationContinuation
        ? heldPreview
            ? { kind: 'ready', preview: heldPreview }
            : loadState.kind === 'ready'
                ? { kind: 'failed', retryable: true }
                : { kind: 'loading' }
        : publicPreviewState;
    const invitationIsJoinable = previewState.kind === 'ready' && previewState.preview.state === 'active';

    const acceptInvitation = React.useCallback(async (projection: TeamEntryProjection) => {
        if (!accountScope || (!invitationToken && !invitationContinuation) || approvalPending) return;
        setAdmissionState({ kind: 'idle' });
        const requestedKey = requestKey;
        /**
         * One settlement for the immediate answer and the approved one.
         *
         * An admission granted through approval is the same admission, so it
         * applies the Home's canonical result and the same exact-Team check
         * rather than degrading into "something changed, reload".
         */
        const settle = (value: TeamInvitationAcceptResultV1) => {
            if (currentRequestKeyRef.current !== requestedKey) return;
            if (value.outcome === 'joined' || value.outcome === 'already_member') {
                if (value.teamId !== projection.team.teamId) {
                    setAdmissionState({ kind: 'incompatible' });
                    return;
                }
                const requiresHomeArrival = value.outcome === 'joined'
                    && !areServerProfileIdentifiersEquivalent(accountScope.serverId, getActiveServerSnapshot().serverId);
                setAdmissionState({ kind: 'complete', entryKey, accountScope, result: value, requiresHomeArrival });
                // The admitted Account's profile belongs to its Home. Retain
                // this result and shell while reaching that existing owner;
                // a blocked arrival retries focus alone, never acceptance.
                if (requiresHomeArrival) {
                    void destination.continueToHome(accountScope.serverId);
                }
                return;
            }
            setAdmissionState({ kind: 'terminal', outcome: value.outcome });
        };

        let result: Awaited<ReturnType<typeof acceptTeamInvitation>>;
        try {
            result = await acceptTeamInvitation({
                scope: accountScope,
                admission: invitationContinuation
                    ? { continuation: invitationContinuation }
                    : { token: invitationToken! },
                onApprovalSucceeded: settle,
                onApprovalFailed: (code) => {
                    if (currentRequestKeyRef.current !== requestedKey) return;
                    setAdmissionState({ kind: 'approval_refused', code });
                },
            });
        } catch (cause) {
            if (currentRequestKeyRef.current !== requestedKey) return;
            if (isTeamActionApprovalPendingError(cause)) {
                // The admission was deferred, not lost. Registering this exact
                // request is what lets its approved answer come back here
                // instead of stranding the person on an offer that silently
                // never completed; settlement never redispatches, because the
                // Home admits them when the approval is granted.
                requestApproval(cause.registration);
                return;
            }
            setAdmissionState({
                kind: 'failed',
                failure: { kind: 'unknown', retryable: true, code: null },
            });
            return;
        }
        if (currentRequestKeyRef.current !== requestedKey) return;
        if (result.kind === 'failed') {
            setAdmissionState({ kind: 'failed', failure: result.failure });
            return;
        }
        settle(result.value);
    }, [accountScope, approvalPending, destination.continueToHome, entryKey, invitationContinuation, invitationToken, requestApproval, requestKey]);

    /**
     * Where this Home says Accounts sign in.
     *
     * A Home whose Accounts live at a separate account service publishes that
     * policy on its Team admission answer. Offering only the Home's own local
     * methods there strands exactly the people the Team is for, so this page
     * hands off to the one account-entry surface every other Home surface uses.
     * `mode: 'self'` and `'disabled'` resolve to no handoff — the Home's own
     * methods below already are it — and an unreachable or unsupported service
     * publishes no discovery either, so nothing is offered that cannot be
     * completed. The handoff is added beside the Home's methods, never instead
     * of them.
     */
    const projectedSignInService = loadState.kind === 'ready'
        && loadState.projection.state === 'admission_required'
        ? loadState.projection.signInService ?? null
        : null;
    const accountServiceContext = React.useMemo<AccountServiceEntryTargetContext>(() => {
        // `self` means this Home is already the account service the page is on,
        // so its own methods below are the handoff; `disabled` offers none.
        if (projectedSignInService?.mode !== 'external' || !resolvedTarget) return { kind: 'none' };
        return { kind: 'home', target: props.target, policy: projectedSignInService };
    }, [projectedSignInService, props.target, resolvedTarget]);
    const accountServiceEntry = useAccountServiceEntryOptions(accountServiceContext);
    const accountServiceDiscovery = accountServiceEntry.status === 'ready'
        ? accountServiceEntry.discovery
        : null;
    const accountServiceReturnTo = props.accountServiceReturnTo ?? (
        loadState.kind === 'ready' && resolvedTarget
            ? teamSignInReturnPath({
                teamId: loadState.projection.team.teamId,
                carrier: resolvedTarget.serverIdentityId,
            })
            : '/'
    );
    const accountServiceHref = React.useMemo(() => {
        // Only the Home's own external policy opens this door. With no policy the
        // hook still probes the device's selected service, which is this device's
        // choice and has nothing to say about signing in to this Team's Home.
        if (accountServiceContext.kind !== 'home' || !accountServiceDiscovery || !resolvedTarget) return null;
        try {
            return buildAuthenticatedAccountEntryHref({
                service: {
                    endpointUrl: accountServiceDiscovery.endpointUrl,
                    serverIdentityId: accountServiceDiscovery.serverIdentityId,
                },
                intent: {
                    kind: 'enter',
                    target: { kind: 'explicit', homeServerIdentityId: resolvedTarget.serverIdentityId },
                },
                returnTo: accountServiceReturnTo,
            });
        } catch {
            return null;
        }
    }, [accountServiceContext, accountServiceDiscovery, accountServiceReturnTo, resolvedTarget]);

    /**
     * A definite negative answer from the service the Home named. `loading` is
     * deliberately excluded: the actions below render immediately, so flashing a
     * failure while the probe is still open would be untrue.
     */
    const accountServiceUnreachable = accountServiceContext.kind === 'home'
        && (accountServiceEntry.status === 'unavailable' || accountServiceEntry.status === 'unsupported');

    let content: React.ReactNode;
    if (loadState.kind === 'ready') {
        const { projection } = loadState;
        const teamName = projection.team.name;
        const homeDisplayName = projection.home.displayName
            ?? resolveHomeDisplayLabel(getServerProfileById(resolvedTarget?.serverIdentityId ?? ''), '');
        const accountLabel = projection.account
            ? resolveViewerAccountDisplayName(formatAccountDisplayName(projection.account))
            : null;
        const signInServiceName = projectedSignInService?.mode === 'external'
            ? accountServiceDiscovery?.accountServiceDisplayName
                ?? accountServiceAddressLabel(projectedSignInService.endpoint)
            : null;
        const admissionTerminal = admissionState.kind === 'terminal' ? admissionState : null;
        const admissionTerminalPresentation = admissionTerminal
            ? resolveTeamJoinPresentation({ outcome: admissionTerminal.outcome })
            : null;
        const invitationProjection = isInvitationAdmissionProjection(projection)
            ? projection
            : null;
        const invitedMailboxVerificationRequired = invitationProjection
            ?.currentAccountRecipientStatus === 'verification_required';
        const invitedMailboxMask = previewState.kind === 'ready'
            ? previewState.preview.recipientEmailMask
            : null;
        const switchAccountOffered = projection.state === 'admission_required'
            && projection.actions.some((action) => action.kind === 'switch_account');
        const entryActions = invitationProjection
            ? leadWithHomeSignUp(projection.actions)
            : projection.actions;
        const firstRunnableAuthenticateIndex = entryActions.findIndex((action) => action.kind === 'authenticate');
        content = (
            <View testID="team-auth-entry-ready" style={styles.content}>
                <TeamEntryIdentity
                    testIDPrefix="team-auth-entry"
                    teamId={projection.team.teamId}
                    teamName={teamName}
                    logo={projection.team.logo ?? null}
                >
                    <Text style={styles.subtitle}>
                        {t('teams.entry.onHome', {
                            home: homeDisplayName,
                        })}
                    </Text>
                    {signInServiceName ? (
                        <Text
                            testID="team-auth-entry-sign-in-service-origin"
                            style={styles.guidance}
                        >
                            {t(accountServiceUnreachable
                                ? 'teams.entry.signInServiceUnavailableOrigin'
                                : 'teams.entry.signInServiceOrigin', { service: signInServiceName })}
                        </Text>
                    ) : null}
                    {accountLabel ? (
                        <Text
                            testID="team-auth-entry-account-label"
                            accessibilityRole="text"
                            style={styles.guidance}
                        >
                            {t('teams.entry.signedInTo', { home: homeDisplayName, account: accountLabel })}
                        </Text>
                    ) : null}
                </TeamEntryIdentity>
                {completedAdmission?.requiresHomeArrival && destination.state.kind !== 'idle' ? (
                    <ExactHomeDestinationNotice testID="team-auth-entry-destination-home" state={destination.state} />
                ) : completedAdmission ? (
                    <TeamJoinedCard
                        testID="team-auth-entry-admission-complete"
                        result={completedAdmission.result}
                        teamName={teamName}
                        accountScope={completedAdmission.accountScope}
                        onOpenTeam={() => props.onAdmissionComplete?.(completedAdmission.result)}
                    />
                ) : admissionTerminal && admissionTerminalPresentation ? (
                    <SurfaceStateCard
                        testID={`team-auth-entry-admission-${admissionTerminal.outcome}`}
                        kind="warning"
                        title={admissionTerminalPresentation.title}
                        reason={admissionTerminalPresentation.body ?? undefined}
                        action={admissionTerminalPresentation.identityAction === 'sign_in_with_invited' && props.onRecoverIdentity ? {
                            label: t('teams.join.signInWithInvited'),
                            onPress: props.onRecoverIdentity,
                        } : undefined}
                        accessibilitySemantics="status"
                    />
                ) : admissionState.kind === 'incompatible' ? (
                    <SurfaceStateCard
                        testID="team-auth-entry-admission-incompatible"
                        kind="warning"
                        title={t('teams.join.updateRequiredTitle')}
                        action={{ label: t('common.retry'), onPress: retry }}
                        accessibilitySemantics="status"
                    />
                ) : admissionState.kind === 'failed' ? (
                    <SurfaceStateCard
                        testID={`team-auth-entry-admission-failure-${admissionState.failure.kind}`}
                        kind="error"
                        title={admissionFailureTitle(admissionState.failure)}
                        reason={admissionState.failure.kind === 'unreachable'
                            || admissionState.failure.kind === 'unknown'
                            ? t('teams.join.offlineBody')
                            : undefined}
                        action={(admissionState.failure.retryable
                            || admissionState.failure.kind === 'outcome_unknown') ? {
                            label: t('teams.join.retry'),
                            onPress: () => runAction(
                                'team-auth-entry-admission-retry',
                                () => acceptInvitation(projection),
                            ),
                        } : undefined}
                        accessibilitySemantics="status"
                    />
                ) : admissionState.kind === 'approval_refused' ? (
                    <SurfaceStateCard
                        testID="team-auth-entry-admission-approval-refused"
                        kind="warning"
                        title={approvalRefusalTitle(admissionState.code)}
                        // Nobody was admitted and the invitation is untouched,
                        // so the same offer stays retryable from here.
                        action={{
                            label: t('teams.join.retry'),
                            onPress: () => runAction(
                                'team-auth-entry-admission-retry',
                                () => acceptInvitation(projection),
                            ),
                        }}
                        accessibilitySemantics="status"
                    />
                ) : approvalPending ? (
                    <SurfaceStateCard
                        testID="team-auth-entry-admission-approval"
                        kind="loading"
                        title={t('approvals.title')}
                        reason={t('approvals.status.open')}
                        action={approvalId && accountScope ? {
                            label: t('approvals.details'),
                            onPress: () => router.push(buildApprovalHref(approvalId, accountScope.serverId)),
                        } : undefined}
                        accessibilitySemantics="status"
                    />
                ) : (
                    <>
                        <Text
                            testID="team-auth-entry-status"
                            accessibilityRole="text"
                            accessibilityLiveRegion="polite"
                            aria-live="polite"
                            role="status"
                            style={styles.guidance}
                        >
                            {projection.state === 'already_member'
                                ? t('teams.join.alreadyMemberTitle')
                                : t('teams.entry.readyStatus')}
                        </Text>
                        {invitation ? (
                            <TeamInvitationPreviewDetails state={previewState} onRetry={retry} />
                        ) : null}
                        <WelcomeActionList admission={admission}>
                            {projection.state === 'already_member' ? (
                                <WelcomeActionCard
                                    testID="team-auth-entry-continue"
                                    primary
                                    title={invitation
                                        ? t('teams.join.openTeam', { team: teamName })
                                        : t('common.continue')}
                                    onPress={() => invitation
                                        ? props.onAdmissionComplete?.({ outcome: 'already_member', teamId: projection.team.teamId })
                                        : props.onContinue?.()}
                                />
                            ) : invitation && accountScope ? (
                                invitationIsJoinable ? (
                                    <>
                                        <WelcomeActionCard
                                            testID="team-auth-entry-join"
                                            primary
                                            title={invitedMailboxVerificationRequired
                                                ? t('teams.join.joinWithCurrentAccount')
                                                : t('teams.join.joinAction', { team: teamName })}
                                            subtitle={invitedMailboxVerificationRequired && invitedMailboxMask
                                                ? t('teams.join.addInvitedAddressNotice', { email: invitedMailboxMask })
                                                : undefined}
                                            onPress={() => acceptInvitation(projection)}
                                        />
                                        {switchAccountOffered && props.onRecoverIdentity ? (
                                            <WelcomeActionCard
                                                testID="team-auth-entry-use-another-account"
                                                primary={false}
                                                title={t('teams.join.useAnotherAccount')}
                                                subtitle={t('teams.join.useAnotherAccountHint')}
                                                onPress={props.onRecoverIdentity}
                                            />
                                        ) : null}
                                    </>
                                ) : null
                            ) : invitation && !invitationIsJoinable ? null : <>
                                {accountServiceHref && accountServiceDiscovery ? (
                                    <WelcomeActionCard
                                        testID="team-auth-entry-account-service"
                                        primary
                                        title={t('teams.entry.continueWith', {
                                            method: accountServiceDiscovery.accountServiceDisplayName
                                                ?? accountServiceAddressLabel(accountServiceDiscovery.endpointUrl),
                                        })}
                                        subtitle={t('settingsAccount.accountServiceSignInService')}
                                        onPress={() => { router.push(accountServiceHref); }}
                                    />
                                ) : accountServiceUnreachable ? (
                                    /*
                                     * The Home says sign-in happens at a service this device
                                     * cannot reach. Dropping the handoff silently would leave the
                                     * page claiming the Home's own methods are all there is, which
                                     * is not what the Home published. The account-entry surfaces
                                     * answer this exact state the same way — name it and offer the
                                     * same probe again — so this reuses their copy and the hook's
                                     * own `retry` rather than inventing a second recovery.
                                     */
                                    <WelcomeActionCard
                                        testID="team-auth-entry-account-service-unavailable"
                                        primary={false}
                                        iconName="cloud-slash"
                                        title={accountServiceEntry.status === 'unsupported'
                                            ? t('welcome.signInServiceUnsupportedTitle')
                                            : t('welcome.signInServiceUnavailableTitle')}
                                        subtitle={t('welcome.signInServiceUnavailableHomeBody')}
                                        onPress={accountServiceEntry.retry}
                                    />
                                ) : null}
                                {entryActions.map((action, index) => {
                                    if (action.kind === 'provider_unavailable') {
                                        /*
                                         * An accepted Team sign-in that cannot run right now is
                                         * named with the Home's safe reason (teams-lane-03/01
                                         * §10.2, TA-R17) instead of vanishing. Its one useful
                                         * action is to ask the Home again.
                                         */
                                        const reasonCopy = action.reason === 'provider_disabled'
                                            ? t('teams.entry.providerUnavailableDisabled')
                                            : action.reason === 'provider_setup_incomplete'
                                                ? t('teams.entry.providerUnavailableSetupIncomplete')
                                                : t('teams.entry.providerUnavailableUnavailable');
                                        return (
                                            <WelcomeActionCard
                                                key={`${action.origin}:${action.methodId}:unavailable`}
                                                testID={`team-auth-entry-unavailable:${action.methodId}`}
                                                primary={false}
                                                title={t('teams.entry.providerUnavailableTitle', { method: action.presentation.displayName })}
                                                subtitle={reasonCopy}
                                                iconName={asIconName(action.presentation.iconHint) ?? 'cloud-slash'}
                                                onPress={retry}
                                            />
                                        );
                                    }
                                    if (action.kind !== 'authenticate') return null;
                                    /*
                                     * The card says which journey it starts with the same glyph
                                     * Welcome and the shared auth host use, because one owner
                                     * answers that per execution and this page already converts a
                                     * Team action into exactly that execution before running it.
                                     */
                                    const execution = projectTeamAuthAction(action)?.execution ?? null;
                                    /*
                                     * When the Home published a bounded icon hint for this provider
                                     * it is the more specific answer, so it wins over the per-execution
                                     * glyph. A hint this app ships no glyph for narrows away and the
                                     * shared entry icon still renders.
                                     */
                                    const presentation = execution
                                        ? describeHomeAuthenticationAction({
                                            execution,
                                            providerName: action.presentation.displayName,
                                        })
                                        : null;
                                    const iconName = asIconName(action.presentation.iconHint)
                                        ?? presentation?.iconName;
                                    /*
                                     * A Home publishes sign-in and sign-up as separate actions of
                                     * one native method. The shared presentation owner names each
                                     * journey ("New here?", "Use a key", "Create account"), so the
                                     * page never shows one method twice under one label. External
                                     * providers keep the Team wording: the same provider card
                                     * both signs in and creates the Account.
                                     */
                                    const native = execution !== null && execution.kind !== 'oauth';
                                    const sameMethodCount = entryActions.filter((other) => (
                                        other.kind === 'authenticate' && other.methodId === action.methodId
                                    )).length;
                                    return (
                                        <WelcomeActionCard
                                            key={`${action.origin}:${action.methodId}:${action.action}:${action.mode}`}
                                            testID={sameMethodCount > 1
                                                ? `team-auth-entry-action:${action.methodId}:${action.action}`
                                                : `team-auth-entry-action:${action.methodId}`}
                                            primary={index === firstRunnableAuthenticateIndex && accountServiceHref === null}
                                            title={native && presentation
                                                ? presentation.title
                                                : t('teams.entry.continueWith', { method: action.presentation.displayName })}
                                            subtitle={native ? presentation?.description : undefined}
                                            {...(iconName ? { iconName } : {})}
                                            accentColor={action.presentation.connectButtonColor}
                                            onPress={() => props.onSelectAction({
                                                action,
                                                teamId: projection.team.teamId,
                                                teamName: projection.team.name,
                                                teamLogo: projection.team.logo ?? null,
                                                target: props.target,
                                                ...(invitation ? {
                                                    invitationEmailVerificationRequired:
                                                        invitationProjection?.invitationEmailVerificationRequired === true,
                                                } : {}),
                                            })}
                                        />
                                    );
                                })}
                                {switchAccountOffered && props.onRecoverIdentity ? (
                                    <WelcomeActionCard
                                        testID="team-auth-entry-use-another-account"
                                        primary={false}
                                        title={t('teams.join.useAnotherAccount')}
                                        subtitle={t('teams.join.useAnotherAccountHint')}
                                        onPress={props.onRecoverIdentity}
                                    />
                                ) : null}
                                {props.onUseCurrentAccount ? (
                                    <WelcomeActionCard
                                        testID="team-auth-entry-use-current-account"
                                        primary={false}
                                        title={t('teams.join.useCurrentAccount')}
                                        onPress={props.onUseCurrentAccount}
                                    />
                                ) : null}
                            </>}
                        </WelcomeActionList>
                    </>
                )}
            </View>
        );
    } else if (loadState.kind === 'loading') {
        content = (
            <View style={styles.content}>
                <View testID="team-auth-entry-lockup-placeholder" style={styles.lockup}>
                    <View
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                        style={styles.logoPlaceholder}
                    />
                    <View style={styles.namePlaceholder} />
                </View>
                <SurfaceStateCard
                    testID="team-auth-entry-loading"
                    kind="loading"
                    title={t('common.loading')}
                    accessibilitySemantics="status"
                />
            </View>
        );
    } else {
        const isIncompatible = loadState.kind === 'incompatible';
        const featureArm = resolveFeatureAvailabilityArm(teamsDecision);
        const updateRequired = isIncompatible && featureArm === 'unsupported';
        const isOffline = loadState.kind === 'offline'
            || (isIncompatible && featureArm === 'unknown');
        // A Home that named its reason gets §10 copy that says what to do next;
        // `entry_not_available` keeps the opaque card that reveals nothing —
        // unless this Home's own invitation preview already declared that Teams
        // are turned off here, which is a current Home stating an operator
        // choice, not a missing Team.
        const contextualReason = loadState.kind === 'unavailable'
            ? presentTeamEntryUnavailableReason(loadState.reason)
                ?? (previewState.kind === 'feature_unavailable' ? presentTeamsDisabledOnHome() : null)
            : null;
        const named = contextualReason ?? (featureArm === 'server_disabled' || featureArm === 'policy_disabled'
            ? presentTeamsDisabledOnHome()
            : null);
        const retryableTerminal = loadState.kind === 'offline'
            || loadState.kind === 'incompatible'
            || (loadState.kind === 'unavailable' && loadState.reason === 'directory_delayed');
        content = (
            <SurfaceStateCard
                testID={`team-auth-entry-${loadState.kind}`}
                kind={named?.kind ?? (isIncompatible ? 'warning' : isOffline ? 'error' : 'unavailable')}
                title={named?.title ?? (updateRequired
                    ? t('teams.join.updateRequiredTitle')
                    : isOffline
                        ? t('teams.join.offlineTitle')
                        : isIncompatible
                            ? t('teams.unavailable.title')
                            : t('teams.errors.notFound'))}
                reason={named?.body ?? (isOffline ? t('teams.join.offlineBody') : undefined)}
                {...(loadState.kind === 'unavailable' && named
                    ? { diagnosticCode: loadState.reason }
                    : {})}
                action={retryableTerminal ? { label: t('common.retry'), onPress: retry } : undefined}
                // Every §10 refusal ends with "or go back to your own work", and
                // a restricted Team reached from a public link is otherwise a
                // dead end with nothing but an endless Retry. This is the same
                // exit the OAuth Team failure card offers.
                secondaryAction={{
                    label: t('teams.entry.returnToHappier'),
                    onPress: () => router.replace('/'),
                }}
                accessibilitySemantics="status"
            />
        );
    }

    return (
        <UnauthenticatedRouteShell
            testID="team-auth-entry-shell"
            stepId={`team-auth-entry:${loadState.kind}`}
            onBack={props.onBack}
        >
            {content}
        </UnauthenticatedRouteShell>
    );
});

const styles = StyleSheet.create((theme) => ({
    content: {
        width: '100%',
        gap: 22,
    },
    lockup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        minWidth: 0,
    },
    logoPlaceholder: {
        width: TEAM_ENTRY_LOGO_SIZE,
        height: TEAM_ENTRY_LOGO_SIZE,
        backgroundColor: theme.colors.surface.elevated,
        borderRadius: 8,
    },
    namePlaceholder: {
        width: '58%',
        height: 18,
        backgroundColor: theme.colors.surface.elevated,
        borderRadius: 6,
    },
    subtitle: {
        ...Typography.default(),
        marginTop: theme.space.s6,
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    guidance: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
}));
