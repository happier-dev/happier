import * as React from 'react';
import { useRouter } from 'expo-router';
import type { HomeTargetInput } from '@happier-dev/cli-common/homeTarget';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { useAuth } from '@/auth/context/AuthContext';
import { HomeAuthenticationFlow } from '@/components/account/auth/HomeAuthenticationFlow';
import { resolveHomeAuthenticationTarget, type ResolvedHomeAuthenticationTarget } from '@/auth/flows/resolveHomeAuthenticationTarget';
import { fetchAuthEntry, fetchHomeAuthEntry } from '@/auth/entry/authEntryClient';
import {
    projectAuthEntryMethodCapabilities,
    type HomeAuthenticationAction,
} from '@/auth/capabilities/authMethodCapabilities';
import { usePortableHomeLinkTarget } from '@/components/teams/join/teamJoinTarget';
import { useExactHomeDestination } from '@/components/account/auth/useExactHomeDestination';
import { ExactHomeDestinationNotice } from '@/components/account/auth/ExactHomeDestinationNotice';
import { openAccountSecurityForHome } from '@/components/settings/account/openAccountSecurityForHome';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { changeAccountSignInEmail } from '@/sync/api/auth/accountSecurity';
import {
    previewNativeEmailVerification,
    previewNativePasswordReset,
    submitNativePasswordReset,
    clearNativeEmailVerificationContinuation,
    readNativeEmailVerificationContinuation,
} from '@/sync/api/auth/nativeAuthEmail';
import { createServerFetchAtEndpoint, type ServerFetch } from '@/sync/http/client';
import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
import { WelcomeActionList } from '@/components/onboarding/preAuth/WelcomeActionList';
import { AuthRouteStepFrame, type AuthRouteStepAction } from '@/components/onboarding/ui/AuthRouteStepFrame';
import { HomeContextLine } from '@/components/onboarding/ui/ActiveRelaySummary';
import { StepForm, stepFieldLabelStyle } from '@/components/onboarding/unauthShell/StepFormParts';
import { StepMark } from '@/components/onboarding/unauthShell/StepMark';
import type { IconName } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Typography } from '@/constants/Typography';
import { runStepMove } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { resolvePostAuthLanding } from '@/components/onboarding/state/resolvePostAuthLanding';
import { teamDetailPath } from '@/components/settings/teams/teamsRoutes';

import { PasswordField } from './PasswordField';
import { EmailPasswordAuthPanel } from './EmailPasswordAuthPanel';
import { EmailPasswordSetupSteps } from './EmailPasswordSetupSteps';
import { completeEmailPasswordAuthentication } from './completeEmailPasswordAuthentication';
import { commitAccountServiceCreation } from '@/auth/accountDirectory/commitAccountServiceCreation';
import {
    createEmailPasswordDraft,
    describeEmailPasswordFailure,
    resolveEmailPasswordProblemMessage,
    validateEmailPasswordDraft,
    type EmailPasswordDraft,
    type EmailPasswordProblem,
} from './emailPasswordFormModel';

type LandingState<TPreview> =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{ kind: 'invalid' }>
    | Readonly<{ kind: 'ready'; preview: TPreview }>;

type NativeAuthLandingTargetState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable'; retry?: () => void }>
    | Readonly<{
        kind: 'ready';
        target: HomeTargetInput;
        authenticationTarget: ResolvedHomeAuthenticationTarget;
        endpointUrl: string;
        serverId: string;
        homeServerIdentityId: string;
        homeLabel: string;
        publicRequest: ServerFetch;
        authenticatedRequest: ServerFetch;
        createAuthenticatedRequest: (credentials: AuthCredentials) => ServerFetch;
    }>;

type NativeAuthLandingActions = Readonly<{
    login: readonly HomeAuthenticationAction[];
    provision: HomeAuthenticationAction | null;
}>;

const LANDING_TARGET_LOADING: NativeAuthLandingTargetState = Object.freeze({ kind: 'loading' as const });
const LANDING_TARGET_UNAVAILABLE: NativeAuthLandingTargetState = Object.freeze({ kind: 'unavailable' as const });

/**
 * The exact Home named by a mail link, acquiring it first on a fresh device.
 *
 * Acquisition — observing the Home and proving its stable identity before this
 * device records it — belongs to the portable Home link owner, so this landing
 * has no second adoption path of its own. It never substitutes the focused Home.
 */
function useNativeAuthLandingTarget(carrier: string | null): NativeAuthLandingTargetState {
    const resolution = usePortableHomeLinkTarget(carrier);

    return React.useMemo<NativeAuthLandingTargetState>(() => {
        if (resolution.kind === 'acquiring') return LANDING_TARGET_LOADING;
        if (resolution.kind === 'acquisition_failed') {
            return { kind: 'unavailable', retry: resolution.retry };
        }
        if (resolution.kind !== 'resolved') return LANDING_TARGET_UNAVAILABLE;
        const target = resolveHomeAuthenticationTarget(resolution.target);
        if (!target) return LANDING_TARGET_UNAVAILABLE;
        return {
            kind: 'ready',
            target: resolution.target,
            authenticationTarget: target,
            endpointUrl: target.endpointUrl,
            serverId: target.serverId,
            homeServerIdentityId: target.serverIdentityId,
            homeLabel: resolveHomeDisplayLabel(getServerProfileById(target.serverIdentityId), target.serverIdentityId),
            publicRequest: createServerFetchAtEndpoint({ ...target, credentials: null }),
            authenticatedRequest: createServerFetchAtEndpoint(target),
            createAuthenticatedRequest: (credentials) => createServerFetchAtEndpoint({ ...target, credentials }),
        };
    }, [resolution]);
}

function buildEmailVerificationReturnTo(token: string, homeTarget: string): string {
    return `/auth/email/verify/${encodeURIComponent(token)}?target=${encodeURIComponent(homeTarget)}`;
}

/**
 * A mail landing is opened once, on an unpredictable connection, and its
 * actions consume one-time bearers. Reuse the canonical action-admission owner
 * so a slow confirmation is visibly working and cannot be submitted twice.
 */
/**
 * Re-running the read this landing already owns. Only the read failed — the
 * Home is resolved and recorded — so the retry re-enters the same effect
 * instead of adding a second acquisition or bearer path.
 */
function useLandingReadRetry(): Readonly<{ attempt: number; retry: () => void }> {
    const [attempt, setAttempt] = React.useState(0);
    const retry = React.useCallback(() => setAttempt((current) => current + 1), []);
    return React.useMemo(() => ({ attempt, retry }), [attempt, retry]);
}

function LandingRetryAction(props: Readonly<{ testID: string; onPress: () => void }>) {
    return (
        <WelcomeActionCard
            testID={props.testID}
            title={t('common.retry')}
            iconName="arrow-clockwise"
            primary
            onPress={props.onPress}
        />
    );
}

function moveLandingStep(kind: 'step' | 'back', commit: () => void) {
    runStepMove({ kind, layer: 'workflow', commit });
}

function LandingShell(props: Readonly<{
    title: string;
    homeLabel?: string;
    children: React.ReactNode;
    testID: string;
    stepId?: string;
    /** The step's purpose under its title (lab direction A). */
    subtitle?: string;
    subtitleTestID?: string;
    /** The round mark naming what the step is about (a dead link, a done change). */
    mark?: IconName;
    /** The step's one action and its quiet second way, drawn by the step frame. */
    primary?: AuthRouteStepAction;
    secondary?: AuthRouteStepAction;
}>) {
    const [pendingActionId, setPendingActionId] = React.useState<string | null>(null);
    const activeActionRef = React.useRef<string | null>(null);
    const mountedRef = React.useRef(true);
    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
    const admission = React.useMemo(() => ({
        pendingActionId,
        run: async (actionId: string, action: () => Promise<void> | void) => {
            if (activeActionRef.current !== null) return;
            activeActionRef.current = actionId;
            setPendingActionId(actionId);
            try {
                await action();
            } finally {
                if (activeActionRef.current === actionId) {
                    activeActionRef.current = null;
                    if (mountedRef.current) setPendingActionId(null);
                }
            }
        },
    }), [pendingActionId]);
    // A mailed link opens one more step of sign-in: signed out it sits in the welcome split's
    // pane like every other standalone auth route, signed in it takes the same focused card.
    return (
        <AuthRouteStepFrame testID={props.testID} stepId={props.stepId} title={props.title}
            subtitle={props.subtitle}
            subtitleTestID={props.subtitleTestID}
            mark={props.mark ? <StepMark iconName={props.mark} /> : undefined}
            primary={props.primary}
            secondary={props.secondary}
            // The link's Home, so a reset link for another Home reads as such (security S6).
            context={props.homeLabel ? <HomeContextLine testID={`${props.testID}-home`} label={props.homeLabel} /> : undefined}>
            <WelcomeActionList admission={admission}>
                <View style={styles.card}>{props.children}</View>
            </WelcomeActionList>
        </AuthRouteStepFrame>
    );
}

/**
 * Read-only landing for a native email verification bearer.
 *
 * The link is opened from a mail client, so this screen must work with no
 * credentials and no referrer. Opening it never consumes the bearer: the
 * preview is read-only and the consuming operation carries the bearer into its
 * own transaction.
 */
export const NativeAuthEmailVerifyScreen = React.memo(function NativeAuthEmailVerifyScreen(
    props: Readonly<{
        token: string | null;
        homeTarget: string | null;
        /**
         * `account_service` when the mailbox is being proven to create an account-service
         * sign-in (the link's `purpose`). Non-authoritative: creation re-checks everything on the
         * server; it only decides which credential the new Account receives on this device.
         */
        purpose?: 'account_service' | null;
    }>,
) {
    const auth = useAuth();
    const router = useRouter();
    const landingTarget = useNativeAuthLandingTarget(props.homeTarget);
    const targetAccountScope = useServerCredentialAccountScopeResolution(
        landingTarget.kind === 'ready' ? landingTarget.serverId : null,
    );
    const { theme } = useUnistyles();
    const [state, setState] = React.useState<LandingState<{
        maskedDestination: string | null;
        continuation: 'account_admission' | 'password_enrollment' | 'sign_in_email_change' | 'none' | null;
    }>>({ kind: 'loading' });
    const [problem, setProblem] = React.useState<EmailPasswordProblem | null>(null);
    const [admissionOpen, setAdmissionOpen] = React.useState(false);
    const [authenticationOpen, setAuthenticationOpen] = React.useState(false);
    const [authActions, setAuthActions] = React.useState<NativeAuthLandingActions | null | undefined>(undefined);
    const previewRead = useLandingReadRetry();
    const authenticationRead = useLandingReadRetry();
    const destination = useExactHomeDestination({
        refreshAuth: auth.refreshFromActiveServer,
        onFocused: React.useCallback(() => resolvePostAuthLanding({ replace: router.replace }), [router]),
    });
    const readyPreview = state.kind === 'ready' ? state.preview : null;
    const verificationContinuation = state.kind === 'ready'
        && state.preview.continuation === 'account_admission'
        && landingTarget.kind === 'ready'
        ? readNativeEmailVerificationContinuation({
            homeServerIdentityId: landingTarget.homeServerIdentityId,
            maskedDestination: state.preview.maskedDestination,
        })
        : null;

    React.useEffect(() => {
        let active = true;
        const token = props.token;
        if (!token) {
            setState({ kind: 'invalid' });
            return;
        }
        if (landingTarget.kind === 'loading') return;
        if (landingTarget.kind === 'unavailable') {
            setState({ kind: 'unavailable' });
            return;
        }
        setState({ kind: 'loading' });
        void (async () => {
            try {
                const preview = await previewNativeEmailVerification(landingTarget.publicRequest, token);
                if (!active) return;
                setState(preview.valid
                    ? { kind: 'ready', preview: { maskedDestination: preview.maskedDestination, continuation: preview.continuation } }
                    : { kind: 'invalid' });
            } catch (cause) {
                if (!active) return;
                setProblem(describeEmailPasswordFailure(cause, { homeLabel: landingTarget.homeLabel }));
                setState({ kind: 'unavailable' });
            }
        })();
        return () => { active = false; };
    }, [landingTarget, previewRead.attempt, props.token]);

    React.useEffect(() => {
        let active = true;
        const abortController = new AbortController();
        setAuthActions(undefined);
        if (landingTarget.kind !== 'ready' || readyPreview === null) {
            setAuthActions(undefined);
            return () => {
                active = false;
                abortController.abort();
            };
        }
        void (async () => {
            const transport = {
                endpointUrl: landingTarget.endpointUrl,
                serverId: landingTarget.serverId,
                signal: abortController.signal,
            };
            // A transferable-invitation verification operation is valid on an
            // invitation-only Home even when ordinary public provisioning is
            // closed. Ask the existing invitation entry owner for the exact
            // admission actions instead of reinterpreting Home policy here.
            const entry = verificationContinuation?.admission
                ? await fetchAuthEntry({
                    ...transport,
                    scope: { kind: 'invitation', token: verificationContinuation.admission.token },
                })
                : readyPreview.continuation === 'account_admission' && props.token
                ? await fetchAuthEntry({
                    ...transport,
                    scope: { kind: 'native_email_verification', token: props.token },
                })
                : await fetchHomeAuthEntry(transport);
            if (!active) return;
            if (entry.kind !== 'ready'
                || (entry.projection.state !== 'ready' && entry.projection.state !== 'admission_required')) {
                setAuthActions(null);
                return;
            }
            const actions = projectAuthEntryMethodCapabilities(entry.projection).authenticationActions;
            setAuthActions({
                login: actions.filter((candidate) => candidate.action.id === 'login'),
                provision: actions.find((candidate) => (
                    candidate.method.id === 'email_password'
                    && candidate.action.id === 'provision'
                    && candidate.execution.kind === 'email_password'
                )) ?? null,
            });
        })().catch(() => { if (active) setAuthActions(null); });
        return () => {
            active = false;
            abortController.abort();
        };
    }, [authenticationRead.attempt, verificationContinuation?.admission?.token, landingTarget, props.token, readyPreview?.continuation]);

    React.useEffect(() => {
        setProblem(null);
        setAdmissionOpen(false);
        setAuthenticationOpen(false);
    }, [props.homeTarget, props.token]);

    const problemMessage = problem ? resolveEmailPasswordProblemMessage(problem) : null;
    // Account Security is reached through its own canonical exact-Home opener,
    // but a failed activation is the shared destination state below rather than
    // a discarded boolean. Otherwise a change that already committed on Home B
    // would leave its Confirm affordance mounted, and the only thing left to
    // press would re-submit an already consumed one-time bearer.
    const continueToExactHomeAccountSecurity = React.useCallback(async (verificationToken?: string) => {
        if (landingTarget.kind !== 'ready') return;
        const serverId = landingTarget.serverId;
        await destination.continueThrough(async () => await openAccountSecurityForHome({
            serverId,
            router,
            refreshAuth: auth.refreshFromActiveServer,
            ...(verificationToken ? { verificationToken } : {}),
        }));
    }, [auth.refreshFromActiveServer, destination.continueThrough, landingTarget, router]);
    if (state.kind === 'ready'
        && state.preview.continuation === 'account_admission'
        && admissionOpen
        && props.token
        && landingTarget.kind === 'ready'
        && authActions?.provision
        && authActions.provision.execution.kind === 'email_password'
        && props.purpose === 'account_service'
        && !verificationContinuation?.admission) {
        const provision = authActions.provision.execution;
        const resolved = resolveHomeAuthenticationTarget(landingTarget.target);
        // ③ Password: the Account is created on this service and this device signs in to it as
        // an account service (its Directory credential), not as a Home.
        return resolved ? (
            // The panel titles itself ("Create your account"); the page keeps the landing's own title so
            // the two headings never repeat.
            <LandingShell testID="native-auth-verify-account-service" stepId="account-service" title={t('settingsAccount.nativePassword.verifyTitle')}>
                <EmailPasswordSetupSteps step="password" inset={false} />
                <EmailPasswordAuthPanel
                    target={resolved}
                    recoveryTarget={props.homeTarget ?? ''}
                    action="provision"
                    mode={provision.mode}
                    {...(provision.recommendedProvisionMode ? { recommendedProvisionMode: provision.recommendedProvisionMode } : {})}
                    admission={{ kind: 'native_email_verification', token: props.token }}
                    {...(verificationContinuation ? { initialEmail: verificationContinuation.normalizedEmail } : {})}
                    credentialTarget="account_directory"
                    onAuthenticated={async (outcome) => {
                        if (verificationContinuation) clearNativeEmailVerificationContinuation(verificationContinuation);
                        await completeEmailPasswordAuthentication({
                            outcome,
                            target: { serverUrl: resolved.canonicalServerUrl, serverId: landingTarget.serverId },
                            // The key belongs to the account-service Account, not to any Home on this server.
                            reminderTarget: { kind: 'account_service', serverIdentityId: resolved.serverIdentityId },
                            loginWithCredentials: async (credentials) => (
                                await commitAccountServiceCreation({
                                    endpointUrl: resolved.endpointUrl,
                                    serverIdentityId: resolved.serverIdentityId,
                                    token: credentials.token,
                                })
                                    ? { kind: 'completed' as const }
                                    : { kind: 'recovery_failed' as const }
                            ),
                            onCompleted: () => {
                                setAdmissionOpen(false);
                                router.replace('/settings/account');
                            },
                        });
                    }}
                    onBack={() => moveLandingStep('back', () => setAdmissionOpen(false))}
                />
            </LandingShell>
        ) : null;
    }
    if (state.kind === 'ready'
        && state.preview.continuation === 'account_admission'
        && admissionOpen
        && props.token
        && landingTarget.kind === 'ready'
        && authActions?.provision) {
        return (
            <LandingShell testID="native-auth-verify" stepId="home-admission" homeLabel={landingTarget.homeLabel}
                title={t('settingsAccount.nativePassword.verifyTitle')}>
                <HomeAuthenticationFlow
                    target={landingTarget.target}
                    actions={[authActions.provision]}
                    returnTo="/"
                    nativeAdmission={verificationContinuation?.admission
                        ? { ...verificationContinuation.admission, emailVerificationToken: props.token }
                        : { kind: 'native_email_verification', token: props.token }}
                    // The mailbox this landing just proved. Without it the panel asks for the
                    // address again on the very screen that verified it.
                    {...(verificationContinuation ? { initialEmail: verificationContinuation.normalizedEmail } : {})}
                    homeLabel={landingTarget.homeLabel}
                    keyChallengeV2Available={false}
                    onAuthenticated={async ({ teamId }) => {
                        if (verificationContinuation) {
                            clearNativeEmailVerificationContinuation(verificationContinuation);
                        }
                        // The Account was created on this exact Home while another
                        // may be focused. Landing on the previous Home would read as
                        // the creation having silently failed — and that is just as
                        // true of the Team the same operation atomically admitted, so
                        // both destinations wait for the one focus.
                        setAdmissionOpen(false);
                        await destination.continueToHome(
                            landingTarget.serverId,
                            teamId
                                ? () => router.replace(teamDetailPath({
                                    serverId: resolveServerProfileScopeIdForIdentifier(landingTarget.serverId),
                                    teamId,
                                }))
                                : undefined,
                        );
                    }}
                    onBack={() => moveLandingStep('back', () => setAdmissionOpen(false))}
                />
            </LandingShell>
        );
    }


    if (state.kind === 'ready'
        && (state.preview.continuation === 'sign_in_email_change'
            || state.preview.continuation === 'password_enrollment')
        && authenticationOpen
        && props.token
        && props.homeTarget
        && landingTarget.kind === 'ready'
        && authActions
        && authActions.login.length > 0) {
        return (
            <LandingShell testID="native-auth-verify" stepId="verify-authentication" homeLabel={landingTarget.homeLabel}
                title={t('settingsAccount.nativePassword.verifyTitle')}>
                <HomeAuthenticationFlow
                    target={landingTarget.target}
                    actions={authActions.login}
                    returnTo={buildEmailVerificationReturnTo(props.token, props.homeTarget)}
                    homeLabel={landingTarget.homeLabel}
                    onAuthenticated={async ({ credentials }) => {
                        try {
                            if (state.preview.continuation === 'sign_in_email_change') {
                                await changeAccountSignInEmail(
                                    landingTarget.createAuthenticatedRequest(credentials),
                                    { verificationToken: props.token! },
                                );
                            }
                            // Whatever this bearer authorized has now committed, so the
                            // authentication step is retired before the destination is
                            // attempted. Leaving it mounted would hide a blocked exact-Home
                            // activation behind a sign-in form that proves nothing further.
                            setAuthenticationOpen(false);
                            await continueToExactHomeAccountSecurity(
                                state.preview.continuation === 'password_enrollment'
                                    ? props.token ?? undefined
                                    : undefined,
                            );
                        } catch (cause) {
                            setProblem(describeEmailPasswordFailure(cause));
                            setAuthenticationOpen(false);
                        }
                    }}
                    onBack={() => moveLandingStep('back', () => setAuthenticationOpen(false))}
                />
            </LandingShell>
        );
    }

    // The bearer has already been consumed by the operation that succeeded. What
    // is left is reaching that Home, and a device that cannot get there stays
    // here with a retry rather than being dropped onto the Home it came from.
    if (destination.state.kind !== 'idle') {
        const destinationState = destination.state;
        return <LandingShell homeLabel={landingTarget.kind === 'ready' ? landingTarget.homeLabel : undefined} testID="native-auth-verify" title={t('settingsAccount.nativePassword.verifyTitle')}>
            <ExactHomeDestinationNotice
                testID="native-auth-verify-destination-home"
                state={destinationState}
            />
            <WelcomeActionCard
                testID="native-auth-verify-return"
                title={t('settingsAccount.nativePassword.returnToSignIn')}
                iconName="arrow-left"
                escape
                onPress={() => router.replace('/')}
            />
        </LandingShell>;
    }

    if (state.kind === 'loading') {
        return <LandingShell homeLabel={landingTarget.kind === 'ready' ? landingTarget.homeLabel : undefined} testID="native-auth-verify" title={t('settingsAccount.nativePassword.verifyTitle')}>
            <Text style={styles.body}>{t('settingsAccount.nativePassword.working')}</Text>
        </LandingShell>;
    }

    if (state.kind === 'invalid' || state.kind === 'unavailable') {
        return <LandingShell homeLabel={landingTarget.kind === 'ready' ? landingTarget.homeLabel : undefined} testID="native-auth-verify" title={t('settingsAccount.nativePassword.verifyTitle')}>
            <Text testID="native-auth-verify-invalid" accessibilityRole="alert" style={[styles.body, { color: theme.colors.status.error }]}>
                {state.kind === 'invalid' ? t('settingsAccount.nativePassword.linkExpired') : problemMessage ?? t('settingsAccount.nativePassword.serverUnavailable')}
            </Text>
            {landingTarget.kind === 'unavailable' && landingTarget.retry ? (
                <LandingRetryAction testID="native-auth-verify-retry-home" onPress={landingTarget.retry} />
            ) : state.kind === 'unavailable' && landingTarget.kind === 'ready' ? (
                // The Home is already acquired; only the preview read failed,
                // so this is not a dead end.
                <LandingRetryAction testID="native-auth-verify-retry" onPress={previewRead.retry} />
            ) : null}
            <WelcomeActionCard
                testID="native-auth-verify-return"
                title={t('settingsAccount.nativePassword.returnToSignIn')}
                iconName="arrow-left"
                onPress={() => router.replace('/')}
            />
        </LandingShell>;
    }

    const preview = state.preview;
    return <LandingShell homeLabel={landingTarget.kind === 'ready' ? landingTarget.homeLabel : undefined} testID="native-auth-verify" title={t('settingsAccount.nativePassword.verifyTitle')}>
        <Text testID="native-auth-verify-destination" style={styles.body}>
            {preview.maskedDestination
                ? t('settingsAccount.nativePassword.verifyDestination', { email: preview.maskedDestination })
                : t('settingsAccount.nativePassword.verifyGeneric')}
        </Text>
        {problemMessage ? (
            <Text accessibilityRole="alert" style={[styles.body, { color: theme.colors.status.error }]}>{problemMessage}</Text>
        ) : null}
        {preview.continuation === 'sign_in_email_change' ? (
            targetAccountScope.kind === 'bound' ? (
                <WelcomeActionCard
                    testID="native-auth-verify-confirm-change"
                    title={t('settingsAccount.nativePassword.confirmEmailChange')}
                    iconName="check"
                    primary
                    onPress={async () => {
                        setProblem(null);
                        try {
                            if (landingTarget.kind !== 'ready') return;
                            await changeAccountSignInEmail(landingTarget.authenticatedRequest, { verificationToken: props.token! });
                            await continueToExactHomeAccountSecurity();
                        } catch (cause) {
                            setProblem(describeEmailPasswordFailure(cause));
                        }
                    }}
                />
            ) : (
                <>
                    <Text testID="native-auth-verify-sign-in-required" style={styles.body}>
                        {t('settingsAccount.nativePassword.signInToConfirm')}
                    </Text>
                    {targetAccountScope.kind === 'signed_out'
                    && landingTarget.kind === 'ready'
                    && authActions
                    && authActions.login.length > 0 ? (
                        <WelcomeActionCard
                            testID="native-auth-verify-sign-in"
                            title={t('settingsAccount.nativePassword.signInFirst')}
                            iconName="sign-in"
                            primary
                            onPress={() => moveLandingStep('step', () => setAuthenticationOpen(true))}
                        />
                    ) : null}
                </>
            )
        ) : preview.continuation === 'password_enrollment' ? (
            targetAccountScope.kind === 'bound' ? (
                <WelcomeActionCard
                    testID="native-auth-verify-password-enrollment"
                    title={t('settingsAccount.nativePassword.continue')}
                    iconName="arrow-right"
                    primary
                    onPress={() => continueToExactHomeAccountSecurity(props.token ?? undefined)}
                />
            ) : (
                <>
                    <Text testID="native-auth-verify-sign-in-required" style={styles.body}>
                        {t('settingsAccount.nativePassword.signInToConfirm')}
                    </Text>
                    {targetAccountScope.kind === 'signed_out'
                    && landingTarget.kind === 'ready'
                    && authActions
                    && authActions.login.length > 0 ? (
                        <WelcomeActionCard
                            testID="native-auth-verify-sign-in"
                            title={t('settingsAccount.nativePassword.signInFirst')}
                            iconName="sign-in"
                            primary
                            onPress={() => moveLandingStep('step', () => setAuthenticationOpen(true))}
                        />
                    ) : null}
                </>
            )
        ) : preview.continuation === 'account_admission' && landingTarget.kind === 'ready' && authActions?.provision ? (
            <WelcomeActionCard
                testID="native-auth-verify-create-account"
                title={t('settingsAccount.nativePassword.continue')}
                iconName="arrow-right"
                primary
                onPress={() => moveLandingStep('step', () => setAdmissionOpen(true))}
            />
        ) : (
            // Account admission consumes this bearer inside its own creation
            // transaction. If the Home no longer offers native provisioning,
            // keep the bearer inert and report that the entry is unavailable.
            <Text testID="native-auth-verify-admission" style={styles.body}>
                {preview.continuation === 'account_admission' && authActions === undefined
                    ? t('settingsAccount.nativePassword.working')
                    : preview.continuation === 'account_admission'
                    ? t('settingsAccount.nativePassword.serverUnavailable')
                    : t('settingsAccount.nativePassword.verifyReturnToCreate')}
            </Text>
        )}
        {authActions === null && landingTarget.kind === 'ready' ? (
            <LandingRetryAction testID="native-auth-verify-retry-auth" onPress={authenticationRead.retry} />
        ) : null}
        <WelcomeActionCard
            testID="native-auth-verify-return"
            title={t('settingsAccount.nativePassword.returnToSignIn')}
            iconName="arrow-left"
            escape
            onPress={() => router.replace('/')}
        />
    </LandingShell>;
});

/** Read-only landing plus explicit new-password submission for a Plain reset. */
export const NativeAuthPasswordResetScreen = React.memo(function NativeAuthPasswordResetScreen(
    props: Readonly<{ token: string | null; homeTarget: string | null }>,
) {
    const auth = useAuth();
    const router = useRouter();
    const landingTarget = useNativeAuthLandingTarget(props.homeTarget);
    const { theme } = useUnistyles();
    const [state, setState] = React.useState<LandingState<null> | Readonly<{ kind: 'done' }>>({ kind: 'loading' });
    const [draft, setDraft] = React.useState<EmailPasswordDraft>(() => createEmailPasswordDraft());
    const [problem, setProblem] = React.useState<EmailPasswordProblem | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [retryForgotOpen, setRetryForgotOpen] = React.useState(false);
    const [authenticationOpen, setAuthenticationOpen] = React.useState(false);
    const [loginActions, setLoginActions] = React.useState<readonly HomeAuthenticationAction[] | null | undefined>(undefined);
    const previewRead = useLandingReadRetry();
    const authenticationRead = useLandingReadRetry();
    const destination = useExactHomeDestination({
        refreshAuth: auth.refreshFromActiveServer,
        onFocused: React.useCallback(() => resolvePostAuthLanding({ replace: router.replace }), [router]),
    });
    const passwordRef = React.useRef<{ focus: () => void } | null>(null);
    const confirmRef = React.useRef<{ focus: () => void } | null>(null);
    const routeKey = `${props.homeTarget ?? ''}\u0000${props.token ?? ''}`;
    const currentRouteKeyRef = React.useRef(routeKey);
    currentRouteKeyRef.current = routeKey;

    React.useEffect(() => {
        let active = true;
        const token = props.token;
        if (!token) {
            setState({ kind: 'invalid' });
            return;
        }
        if (landingTarget.kind === 'loading') return;
        if (landingTarget.kind === 'unavailable') {
            setState({ kind: 'unavailable' });
            return;
        }
        setState({ kind: 'loading' });
        void (async () => {
            try {
                const preview = await previewNativePasswordReset(landingTarget.publicRequest, token);
                if (!active) return;
                setState(preview.valid ? { kind: 'ready', preview: null } : { kind: 'invalid' });
            } catch (cause) {
                if (!active) return;
                setProblem(describeEmailPasswordFailure(cause, { homeLabel: landingTarget.homeLabel }));
                setState({ kind: 'unavailable' });
            }
        })();
        return () => { active = false; };
    }, [landingTarget, previewRead.attempt, props.token]);

    React.useEffect(() => {
        let active = true;
        const abortController = new AbortController();
        setLoginActions(undefined);
        if (landingTarget.kind !== 'ready') {
            setLoginActions(undefined);
            return () => {
                active = false;
                abortController.abort();
            };
        }
        void fetchHomeAuthEntry({
            endpointUrl: landingTarget.endpointUrl,
            serverId: landingTarget.serverId,
            signal: abortController.signal,
        }).then((entry) => {
            if (!active) return;
            if (entry.kind !== 'ready' || entry.projection.state !== 'ready') {
                setLoginActions(null);
                return;
            }
            setLoginActions(projectAuthEntryMethodCapabilities(entry.projection).authenticationActions.filter(
                (candidate) => candidate.action.id === 'login',
            ));
        }).catch(() => { if (active) setLoginActions(null); });
        return () => {
            active = false;
            abortController.abort();
        };
    }, [authenticationRead.attempt, landingTarget]);

    React.useEffect(() => {
        setDraft(createEmailPasswordDraft());
        setProblem(null);
        setBusy(false);
        setAuthenticationOpen(false);
        setRetryForgotOpen(false);
    }, [routeKey]);

    const problemMessage = problem ? resolveEmailPasswordProblemMessage(problem) : null;

    const submit = React.useCallback(async () => {
        if (busy || !props.token) return;
        const submissionRouteKey = routeKey;
        const validated = validateEmailPasswordDraft({ purpose: 'recover', draft });
        if (!validated.ok) {
            setProblem(validated.problem);
            if (validated.problem.field === 'confirmPassword') confirmRef.current?.focus();
            else passwordRef.current?.focus();
            return;
        }
        setProblem(null);
        setBusy(true);
        try {
            if (landingTarget.kind !== 'ready') return;
            await submitNativePasswordReset(landingTarget.publicRequest, { token: props.token, password: validated.password });
            if (currentRouteKeyRef.current !== submissionRouteKey) return;
            setDraft(createEmailPasswordDraft());
            setState({ kind: 'done' });
        } catch (cause) {
            if (currentRouteKeyRef.current !== submissionRouteKey) return;
            setProblem(describeEmailPasswordFailure(
                cause,
                landingTarget.kind === 'ready' ? { homeLabel: landingTarget.homeLabel } : {},
            ));
        } finally {
            if (currentRouteKeyRef.current === submissionRouteKey) setBusy(false);
        }
    }, [busy, draft, landingTarget, props.token, routeKey]);

    if (state.kind === 'loading') {
        return <LandingShell homeLabel={landingTarget.kind === 'ready' ? landingTarget.homeLabel : undefined} testID="native-auth-reset" title={t('settingsAccount.nativePassword.resetTitle')}>
            <Text style={styles.body}>{t('settingsAccount.nativePassword.working')}</Text>
        </LandingShell>;
    }

    const emailLogin = loginActions?.find(({ execution }) => execution.kind === 'email_password')?.execution;
    if (state.kind === 'invalid' && retryForgotOpen && landingTarget.kind === 'ready' && emailLogin?.kind === 'email_password') {
        return <LandingShell testID="native-auth-reset" stepId="reset-request" title="">
            <EmailPasswordAuthPanel
                presentation="step"
                target={landingTarget.authenticationTarget}
                recoveryTarget={landingTarget.homeServerIdentityId}
                homeLabel={landingTarget.homeLabel}
                action="login"
                mode={emailLogin.mode}
                passwordReset={emailLogin.passwordReset}
                initialView="forgot"
                onAuthenticated={() => {}}
                onBack={() => moveLandingStep('back', () => setRetryForgotOpen(false))}
            />
        </LandingShell>;
    }

    if (state.kind === 'invalid' || state.kind === 'unavailable') {
        const retry = landingTarget.kind === 'unavailable' && landingTarget.retry
            ? { testID: 'native-auth-reset-retry-home', onPress: landingTarget.retry }
            : state.kind === 'unavailable' && landingTarget.kind === 'ready'
                ? { testID: 'native-auth-reset-retry', onPress: previewRead.retry }
                : null;
        const returnToSignIn = { testID: 'native-auth-reset-return', label: t('settingsAccount.nativePassword.returnToSignIn'), onPress: () => router.replace('/') };
        const emailReset = emailLogin?.kind === 'email_password' && emailLogin.passwordReset === 'email';
        // A dead link says so in its title and offers the next step (lab direction A "Reset link · expired or used").
        if (state.kind === 'invalid') {
            return <LandingShell homeLabel={landingTarget.kind === 'ready' ? landingTarget.homeLabel : undefined} testID="native-auth-reset"
                mark="link"
                title={t('settingsAccount.nativePassword.resetLinkInvalidTitle')}
                subtitle={t('settingsAccount.nativePassword.linkExpired')}
                subtitleTestID="native-auth-reset-invalid"
                primary={emailLogin?.kind === 'email_password' ? {
                    testID: 'native-auth-reset-request-new-link',
                    label: t(emailReset ? 'settingsAccount.nativePassword.requestNewLink' : 'settingsAccount.nativePassword.useRecoveryKey'),
                    iconName: emailReset ? undefined : 'key',
                    onPress: () => moveLandingStep('step', () => setRetryForgotOpen(true)),
                } : returnToSignIn}
                secondary={emailLogin?.kind === 'email_password' ? returnToSignIn : undefined}>
                {retry ? <LandingRetryAction testID={retry.testID} onPress={retry.onPress} /> : null}
            </LandingShell>;
        }
        return <LandingShell homeLabel={landingTarget.kind === 'ready' ? landingTarget.homeLabel : undefined} testID="native-auth-reset"
            mark="link"
            title={t('settingsAccount.nativePassword.resetLinkUnavailableTitle')}
            secondary={returnToSignIn}>
            <SurfaceStateCard
                testID="native-auth-reset-invalid"
                size="line"
                lineLayout="notice"
                kind="warning"
                title={problemMessage ?? t('settingsAccount.nativePassword.serverUnavailable')}
                accessibilitySemantics="alert"
                actionGlyph={retry ? 'retry' : undefined}
                action={retry ? { testID: retry.testID, label: t('common.retry'), onPress: retry.onPress } : undefined}
            />
        </LandingShell>;
    }

    if (state.kind === 'done') {
        // The password is already changed. Only reaching that Home is left, so a
        // device that cannot get there keeps the visible retry instead of being
        // dropped onto whichever Home it came from.
        if (destination.state.kind !== 'idle') {
            const destinationState = destination.state;
            return <LandingShell homeLabel={landingTarget.kind === 'ready' ? landingTarget.homeLabel : undefined} testID="native-auth-reset" title={t('settingsAccount.nativePassword.resetCompleteTitle')}>
                <Text testID="native-auth-reset-done" style={styles.body}>{t('settingsAccount.nativePassword.resetComplete')}</Text>
                <ExactHomeDestinationNotice
                    testID="native-auth-reset-destination-home"
                    state={destinationState}
                />
                <WelcomeActionCard
                    testID="native-auth-reset-return"
                    title={t('settingsAccount.nativePassword.returnToSignIn')}
                    iconName="arrow-left"
                    escape
                    onPress={() => router.replace('/')}
                />
            </LandingShell>;
        }
        if (authenticationOpen && landingTarget.kind === 'ready' && loginActions && loginActions.length > 0) {
            return <LandingShell testID="native-auth-reset" stepId="reset-authentication" homeLabel={landingTarget.homeLabel}
                title={t('settingsAccount.nativePassword.resetCompleteTitle')}>
                <HomeAuthenticationFlow
                    target={landingTarget.target}
                    actions={loginActions}
                    returnTo="/"
                    homeLabel={landingTarget.homeLabel}
                    onAuthenticated={async () => {
                        // The new password signs in to the Home the reset link named,
                        // which need not be the focused one. Only move on once this
                        // device is actually on it.
                        setAuthenticationOpen(false);
                        await destination.continueToHome(landingTarget.serverId);
                    }}
                    onBack={() => moveLandingStep('back', () => setAuthenticationOpen(false))}
                />
            </LandingShell>;
        }
        const canSignIn = landingTarget.kind === 'ready' && loginActions && loginActions.length > 0;
        return <LandingShell homeLabel={landingTarget.kind === 'ready' ? landingTarget.homeLabel : undefined} testID="native-auth-reset"
            mark="check"
            title={t('settingsAccount.nativePassword.resetCompleteTitle')}
            subtitle={t('settingsAccount.nativePassword.resetComplete')}
            subtitleTestID="native-auth-reset-done"
            primary={canSignIn ? {
                testID: 'native-auth-reset-sign-in',
                label: t('settingsAccount.nativePassword.returnToSignIn'),
                onPress: () => moveLandingStep('step', () => setAuthenticationOpen(true)),
            } : undefined}>
            {canSignIn ? null : (
                <SurfaceStateCard
                    testID="native-auth-reset-auth-state"
                    size="line"
                    lineLayout="notice"
                    kind={loginActions === undefined ? 'loading' : 'warning'}
                    title={loginActions === undefined
                        ? t('settingsAccount.nativePassword.working')
                        : t('settingsAccount.nativePassword.serverUnavailable')}
                    accessibilitySemantics={loginActions === undefined ? 'status' : 'alert'}
                    actionGlyph={loginActions === null && landingTarget.kind === 'ready' ? 'retry' : undefined}
                    action={loginActions === null && landingTarget.kind === 'ready'
                        ? { testID: 'native-auth-reset-retry-auth', label: t('common.retry'), onPress: authenticationRead.retry }
                        : undefined}
                />
            )}
        </LandingShell>;
    }

    return <LandingShell homeLabel={landingTarget.kind === 'ready' ? landingTarget.homeLabel : undefined} testID="native-auth-reset"
        title={t('settingsAccount.nativePassword.resetTitle')}
        subtitle={t('settingsAccount.nativePassword.resetChooseNew')}
        primary={{ testID: 'native-auth-reset-submit', label: t('settingsAccount.nativePassword.setNewPassword'), onPress: () => { void submit(); }, disabled: busy }}>
        <StepForm>
            <PasswordField
                testID="native-auth-reset-password"
                inputRef={passwordRef}
                label={t('settingsAccount.nativePassword.newPassword')}
                labelStyle={stepFieldLabelStyle()}
                value={draft.password}
                onChangeText={(password) => setDraft((current) => ({ ...current, password }))}
                autoComplete="new-password"
                supportingText={t('settingsAccount.nativePassword.passwordRequirements')}
                error={problem?.field === 'password' ? problemMessage : null}
                editable={!busy}
                returnKeyType="next"
                onSubmitEditing={() => confirmRef.current?.focus()}
            />
            <PasswordField
                testID="native-auth-reset-confirm"
                inputRef={confirmRef}
                label={t('settingsAccount.nativePassword.confirmPassword')}
                labelStyle={stepFieldLabelStyle()}
                value={draft.confirmPassword}
                onChangeText={(confirmPassword) => setDraft((current) => ({ ...current, confirmPassword }))}
                autoComplete="new-password"
                error={problem?.field === 'confirmPassword' ? problemMessage : null}
                editable={!busy}
                returnKeyType="go"
                onSubmitEditing={submit}
            />
            {problem?.field === 'form' && problemMessage ? (
                <Text testID="native-auth-reset-error" accessibilityRole="alert" accessibilityLiveRegion="polite"
                    style={[styles.body, { color: theme.colors.status.error }]}>{problemMessage}</Text>
            ) : null}
        </StepForm>
        {/* The consequence stands right above the button it belongs to (lab direction A). */}
        <Text style={styles.consequence}>{t('settingsAccount.nativePassword.resetSignsOutOtherDevices')}</Text>
    </LandingShell>;
});

const styles = StyleSheet.create((theme) => ({
    card: { gap: 14, width: '100%' },
    body: { fontSize: 14, color: theme.colors.text.secondary },
    consequence: { ...Typography.variant('meta'), color: theme.colors.text.secondary, textAlign: 'center' },
}));
