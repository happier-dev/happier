import * as React from 'react';
import { AccountCredentialJourney } from '@/components/account/auth/AccountCredentialJourney';
import { useRouter } from 'expo-router';
import type { NativeAccountAdmissionV1 } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { EmailPasswordEntryAction } from '@/auth/capabilities/authMethodCapabilities';
import { resolveEmailPasswordProvisionDefault, resolveEmailPasswordProvisionModes } from '@/auth/capabilities/authMethodCapabilities';
import { loginEmailPassword, type EmailPasswordLoginTarget } from '@/auth/password/loginEmailPassword';
import {
    provisionEmailPasswordAccount,
} from '@/auth/password/provisionEmailPasswordAccount';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
import {
    WelcomeActionAdmissionContext,
    type WelcomeActionAdmission,
} from '@/components/onboarding/preAuth/WelcomeActionList';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { ActiveRelaySummary } from '@/components/onboarding/ui/ActiveRelaySummary';
import { StepActions, UnauthenticatedStepHeading } from '@/components/onboarding/unauthShell/UnauthenticatedStep';
import {
    StepFieldGroup,
    StepFieldHelp,
    StepFieldLabel,
    StepForm,
    StepOrDivider,
    StepQuietAction,
    StepQuietActions,
    stepFieldLabelStyle,
} from '@/components/onboarding/unauthShell/StepFormParts';
import { StepMark } from '@/components/onboarding/unauthShell/StepMark';
import { StepPrimaryButton, useStepBackOverride } from '@/components/onboarding/unauthShell/stepBack';
import type { IconName } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import {
    rememberNativeEmailVerificationContinuation,
    requestNativeEmailVerification,
    requestNativePasswordReset,
} from '@/sync/api/auth/nativeAuthEmail';
import { t, tLoose } from '@/text';

import { PasswordField } from './PasswordField';
import type { EmailPasswordAuthenticationCompletion } from './completeEmailPasswordAuthentication';
import {
    createEmailPasswordDraft,
    describeEmailPasswordFailure,
    resolveEmailPasswordProblemMessage,
    validateEmailPasswordDraft,
    type EmailPasswordDraft,
    type EmailPasswordProblem,
} from './emailPasswordFormModel';

/** Press feedback is immediate; delayed progress copy waits out a short flicker window. */
const DELAYED_PROGRESS_MS = 400;

export type EmailPasswordAuthOutcome = Readonly<{
    credentials: AuthCredentials;
    accountId?: string;
    teamId?: string | null;
    recoverySecret?: Uint8Array | null;
}>;

export type EmailPasswordAuthPanelProps = Readonly<{
    returnTo?: string;
    target: EmailPasswordLoginTarget;
    /** Portable Home identity carried into the recovery-key password replacement entry. */
    recoveryTarget: string;
    /** The exact entry action this controller was dispatched for. */
    action: EmailPasswordEntryAction;
    /** Home Account-mode policy for this action: keyed = E2EE, keyless = Plain. */
    mode: 'keyed' | 'keyless' | 'either';
    /** The Home's recommended protection for a new Account, when it states one. */
    recommendedProvisionMode?: 'plain' | 'e2ee';
    homeLabel?: string;
    /**
     * `step`: the panel is a step of the signed-out Welcome, so its title is the step's heading. Elsewhere
     * (a Team or mail landing) it stands under its host's own heading.
     */
    presentation?: 'step' | 'inline';
    /** A validated bounded admission bearer, when creation came from an invitation. */
    admission?: NativeAccountAdmissionV1;
    invitationEmailVerificationRequired?: boolean;
    initialEmail?: string;
    initialView?: 'forgot';
    /**
     * Create the Account for account-service sign-in (the mail landing of an account-service
     * creation): the service answers with its Directory credential instead of a Home one.
     */
    credentialTarget?: 'account_directory';
    /**
     * `email` when the Home says it can mail a reset link now (its sign-in action's fact). Without
     * it the forgotten-password view offers only the recovery key, never a link that cannot arrive.
     */
    passwordReset?: 'email';
    signal?: AbortSignal;
    onAuthenticated: (outcome: EmailPasswordAuthOutcome) => void | EmailPasswordAuthenticationCompletion | Promise<void | EmailPasswordAuthenticationCompletion>;
    /** Leaves this controller for the surrounding auth-entry surface. */
    onBack?: () => void;
    /** Offered by a host that admitted a separate create-account action on this Home. */
    onOpenEmailProvision?: () => Promise<void> | void;
    /**
     * Draw the Back link. A surrounding step that already carries its own way back sets this false;
     * `onBack` still serves the flows that leave the surface (recovery key).
     */
    showBackAction?: boolean;
}>;

type PanelView =
    | Readonly<{ kind: 'login' }>
    | Readonly<{ kind: 'provision' }>
    | Readonly<{ kind: 'connect' }>
    | Readonly<{ kind: 'forgot' }>
    | Readonly<{ kind: 'verification_sent'; email: string }>
    | Readonly<{ kind: 'reset_requested'; email: string }>;

function useDelayedProgress(busy: boolean): boolean {
    const [visible, setVisible] = React.useState(false);
    React.useEffect(() => {
        if (!busy) {
            setVisible(false);
            return;
        }
        const timer = setTimeout(() => setVisible(true), DELAYED_PROGRESS_MS);
        return () => clearTimeout(timer);
    }, [busy]);
    return visible;
}

/**
 * The one native email/password controller. `login`, `provision` and `connect`
 * each land here with their own view; none of them borrows another's form, and
 * an action this Home does not admit shows a truthful unavailable state rather
 * than a silently different journey.
 */
export const EmailPasswordAuthPanel = React.memo(function EmailPasswordAuthPanel(props: EmailPasswordAuthPanelProps) {
    return <AccountCredentialJourney request={props.action === 'connect' || props.admission ? null
        : props.credentialTarget === 'account_directory'
            ? { kind: 'account_directory', request: { service: props.target, intent: { kind: 'refresh' }, returnTo: props.returnTo ?? '/settings/account' } }
            : { kind: 'home', profileRef: props.target.serverId, returnTo: props.returnTo ?? '/' }}>
        <EmailPasswordAuthPanelBody {...props} />
    </AccountCredentialJourney>;
});

const EmailPasswordAuthPanelBody = React.memo(function EmailPasswordAuthPanelBody(props: EmailPasswordAuthPanelProps) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const [draft, setDraft] = React.useState<EmailPasswordDraft>(() => createEmailPasswordDraft(props.initialEmail ?? ''));
    const entryView = props.initialView ?? props.action;
    const [view, setView] = React.useState<PanelView>(() => ({ kind: entryView }));
    const permittedModes = React.useMemo(() => resolveEmailPasswordProvisionModes(props.mode), [props.mode]);
    const defaultAccountMode = resolveEmailPasswordProvisionDefault(props.mode, props.recommendedProvisionMode);
    const [accountMode, setAccountMode] = React.useState<'plain' | 'e2ee'>(defaultAccountMode);
    const [problem, setProblem] = React.useState<EmailPasswordProblem | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [pendingActionId, setPendingActionId] = React.useState<string | null>(null);
    /** A settled resend, so the identical "check your email" view says so. */
    const [resent, setResent] = React.useState(false);
    const showProgress = useDelayedProgress(busy);
    const mountedRef = React.useRef(true);
    const targetScope = `${props.target.serverIdentityId}|${props.target.canonicalServerUrl}|${props.target.endpointUrl}`;
    const targetScopeRef = React.useRef(targetScope);
    if (targetScopeRef.current !== targetScope) targetScopeRef.current = targetScope;
    const emailRef = React.useRef<{ focus: () => void } | null>(null);
    const passwordRef = React.useRef<{ focus: () => void } | null>(null);
    const confirmRef = React.useRef<{ focus: () => void } | null>(null);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
    React.useEffect(() => {
        // A target replacement retires every in-flight result and clears
        // credentials typed for the prior Home. The next Home starts from its
        // own requested action rather than inheriting stale busy/error state.
        setBusy(false);
        setPendingActionId(null);
        setResent(false);
        setProblem(null);
        setDraft(createEmailPasswordDraft(props.initialEmail ?? ''));
        setView({ kind: entryView });
        // Another Home (or a changed Home policy) starts from its own recommendation.
        setAccountMode(defaultAccountMode);
    }, [defaultAccountMode, entryView, props.initialEmail, targetScope]);
    React.useEffect(() => {
        // A late permitted-mode narrowing must never leave a selection the Home
        // would refuse; it also must not silently reword the person's choice.
        if (!permittedModes.includes(accountMode)) setAccountMode(defaultAccountMode);
    }, [accountMode, defaultAccountMode, permittedModes]);

    /**
     * Whether this Home must see proven mailbox control before an Account can
     * exist. Both the form and the submit handler read this one fact, so the
     * step can never ask for a credential the journey then throws away.
     */
    const transferableInvitation = props.admission?.kind === 'team_invitation'
        && props.invitationEmailVerificationRequired === true
        && props.admission.emailVerificationToken === undefined
        ? props.admission
        : null;
    const mailboxProofFirst = props.admission === undefined || transferableInvitation !== null;

    const captureCurrentTarget = React.useCallback(() => {
        const expectedScope = targetScopeRef.current;
        return () => mountedRef.current
            && props.signal?.aborted !== true
            && targetScopeRef.current === expectedScope;
    }, [props.signal]);

    const focusProblem = React.useCallback((next: EmailPasswordProblem) => {
        setProblem(next);
        if (next.field === 'email') emailRef.current?.focus();
        else if (next.field === 'password') passwordRef.current?.focus();
        else if (next.field === 'confirmPassword') confirmRef.current?.focus();
    }, []);

    const problemMessage = React.useMemo(() => (
        problem ? resolveEmailPasswordProblemMessage(problem) : null
    ), [problem]);

    const run = React.useCallback(async (operation: () => Promise<void>) => {
        if (busy) return;
        const isCurrent = captureCurrentTarget();
        setProblem(null);
        setBusy(true);
        try {
            await operation();
        } catch (cause) {
            if (!isCurrent()) return;
            focusProblem(describeEmailPasswordFailure(cause, props.homeLabel ? { homeLabel: props.homeLabel } : {}));
        } finally {
            if (isCurrent()) setBusy(false);
        }
    }, [busy, captureCurrentTarget, focusProblem, props.homeLabel]);

    /**
     * Action admission belongs to this controller, not to whichever host mounted
     * it. `HomeAuthenticationFlow` wraps the panel in a `WelcomeActionList`
     * while the Welcome modal host renders it bare, and the module default
     * admits everything — so the same Argon2id wait used to be acknowledged on
     * one host and silent on the other. One owner, both hosts.
     */
    const actionAdmission = React.useMemo<WelcomeActionAdmission>(() => ({
        pendingActionId,
        run: async (actionId, action) => {
            if (pendingActionId !== null) return;
            setPendingActionId(actionId);
            try {
                await action();
            } finally {
                if (mountedRef.current) setPendingActionId(null);
            }
        },
    }), [pendingActionId]);

    const publicRequest = React.useCallback(() => createServerFetchAtEndpoint({
        ...props.target,
        credentials: null,
        ...(props.signal ? { signal: props.signal } : {}),
    }), [props.signal, props.target]);

    const submitLogin = React.useCallback(() => run(async () => {
        const isCurrent = captureCurrentTarget();
        const validated = validateEmailPasswordDraft({ purpose: 'login', draft });
        if (!validated.ok) {
            focusProblem(validated.problem);
            return;
        }
        const credentials = await loginEmailPassword({
            target: props.target,
            email: validated.email,
            password: validated.password,
            ...(props.signal ? { signal: props.signal } : {}),
            isCurrent,
        });
        if (!isCurrent()) return;
        // Only the password is cleared: a recoverable failure keeps the address.
        setDraft((current) => ({ ...current, password: '' }));
        await props.onAuthenticated({ credentials });
    }), [captureCurrentTarget, draft, focusProblem, props, run]);

    const submitProvision = React.useCallback(() => run(async () => {
        const isCurrent = captureCurrentTarget();
        const validated = validateEmailPasswordDraft({
            purpose: mailboxProofFirst ? 'verify_email' : 'provision',
            draft,
        });
        if (!validated.ok) {
            focusProblem(validated.problem);
            return;
        }
        if (mailboxProofFirst) {
            // Creation needs proven mailbox control. Ask the Home to send the
            // link and say so plainly instead of hiding the journey. Nothing
            // secret is collected on this step: the password would be discarded
            // here and asked for again on the verification landing.
            await requestNativeEmailVerification(publicRequest(), {
                email: validated.normalizedEmail,
                ...(transferableInvitation ? { admission: transferableInvitation } : {}),
            });
            if (!isCurrent()) return;
            setResent(view.kind === 'verification_sent');
            // Self-service creation proves the same mailbox as an invitation does, so the
            // verified address is retained either way; only the invitation bearer is optional.
            rememberNativeEmailVerificationContinuation({
                homeServerIdentityId: props.target.serverIdentityId,
                normalizedEmail: validated.normalizedEmail,
                ...(transferableInvitation ? { admission: transferableInvitation } : {}),
            });
            setView({ kind: 'verification_sent', email: validated.email });
            return;
        }
        const created = await provisionEmailPasswordAccount({
            target: props.target,
            email: validated.email,
            password: validated.password,
            accountMode,
            admission: props.admission,
            ...(props.credentialTarget ? { credentialTarget: props.credentialTarget } : {}),
            ...(props.signal ? { signal: props.signal } : {}),
            isCurrent,
        });
        if (!isCurrent()) {
            // The Account exists, but this controller no longer owns the journey that
            // would disclose its recovery key. Nothing may hold those bytes after the
            // result is retired; the Account stays recoverable through Settings.
            if (created.recoverySecret instanceof Uint8Array) {
                created.recoverySecret.fill(0);
            }
            return;
        }
        setDraft((current) => ({ ...current, password: '', confirmPassword: '' }));
        await props.onAuthenticated(created);
    }), [
        accountMode,
        captureCurrentTarget,
        draft,
        focusProblem,
        mailboxProofFirst,
        props,
        publicRequest,
        run,
        transferableInvitation,
        view.kind,
    ]);

    const submitResetRequest = React.useCallback(() => run(async () => {
        const isCurrent = captureCurrentTarget();
        // The address-only acceptance every other native writer on this surface
        // uses. A bare emptiness check would send a malformed address.
        const validated = validateEmailPasswordDraft({ purpose: 'verify_email', draft });
        if (!validated.ok) {
            focusProblem(validated.problem);
            return;
        }
        await requestNativePasswordReset(publicRequest(), validated.email);
        if (!isCurrent()) return;
        setResent(view.kind === 'reset_requested');
        setView({ kind: 'reset_requested', email: validated.email });
    }), [captureCurrentTarget, draft, focusProblem, publicRequest, run, view.kind]);

    const emailErrorId = 'email-password-email-error';
    const emailInvalid = problem?.field === 'email' && problemMessage !== null;
    // The address field owns its refusal in every view, exactly as `PasswordField`
    // does, so the announced error is always rendered and `aria-describedby`
    // always resolves. `onSubmitEditing` names the branch's real next step; a
    // view with no password field submits from here instead of focusing one.
    const emailField = (
        autoComplete: 'email' | 'username',
        onSubmitEditing?: () => void,
        help?: React.ReactNode,
    ) => (
        <StepFieldGroup>
            <StepFieldLabel nativeID={EMAIL_LABEL_ID}>{t('settingsAccount.nativePassword.email')}</StepFieldLabel>
            <FieldTextInput
                ref={emailRef as never}
                testID="email-password-email"
                accessibilityLabel={t('settingsAccount.nativePassword.email')}
                accessibilityLabelledBy={EMAIL_LABEL_ID}
                // The refusal is the field's own, exactly as PasswordField
                // already associates its error, so assistive technology reads it
                // with the input rather than as a detached line.
                accessibilityDescribedBy={emailInvalid ? emailErrorId : undefined}
                invalid={problem?.field === 'email'}
                value={draft.email}
                onChangeText={(email) => setDraft((current) => ({ ...current, email }))}
                placeholder={t('settingsAccount.nativePassword.emailPlaceholder')}
                autoCapitalize="none"
                keyboardType="email-address"
                inputMode="email"
                autoComplete={autoComplete}
                textContentType="username"
                editable={!busy}
                returnKeyType={onSubmitEditing ? 'go' : 'next'}
                onSubmitEditing={onSubmitEditing ?? (() => passwordRef.current?.focus())}
            />
            {emailInvalid ? (
                <StepFieldHelp testID={emailErrorId} nativeID={emailErrorId} tone="error">{problemMessage}</StepFieldHelp>
            ) : help}
        </StepFieldGroup>
    );

    // The Home this sign-in acts on, as the same chip Restore shows above its heading.
    const homeChip = (
        <ActiveRelaySummary
            idPrefix="email-password-home"
            relayUrl={props.target.canonicalServerUrl}
            status="active"
            presentation="line"
        />
    );
    const heading = (title: string) => props.presentation === 'step'
        ? <UnauthenticatedStepHeading title={title} context={homeChip} />
        : (
            <View style={styles.inlineHeading}>
                {homeChip}
                <Text accessibilityRole="header" style={styles.title}>{title}</Text>
            </View>
        );

    const formProblem = problem?.field === 'form' && problemMessage ? (
        <Text
            testID="email-password-form-error"
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={[styles.formError, { color: theme.colors.status.error }]}
        >
            {problemMessage}
        </Text>
    ) : null;

    const progressNotice = showProgress ? (
        <Text testID="email-password-progress" accessibilityLiveRegion="polite" style={styles.hint}>
            {t('settingsAccount.nativePassword.working')}
        </Text>
    ) : null;

    const backAction = props.onBack && props.showBackAction !== false ? (
        <WelcomeActionCard
            testID="email-password-back"
            presentation="link"
            title={t('common.back')}
            iconName="arrow-left"
            escape
            onPress={props.onBack}
        />
    ) : null;

    // The email, password and protection fields of sign-in and create, shared by both presentations.
    const credentialFields = (provisioning: boolean, collectsCredentials: boolean) => (
        <>
    {emailField(
        provisioning ? 'email' : 'username',
        collectsCredentials ? undefined : submitProvision,
        // Without a password here, the field's own line says what happens to the address.
        collectsCredentials ? undefined : (
            <StepFieldHelp testID="email-password-verify-first">
                {t('settingsAccount.nativePassword.verifyReturnToCreate')}
            </StepFieldHelp>
        ),
    )}
    {collectsCredentials ? (
    <ListPresentationProvider value="page">
    <PasswordField
        testID="email-password-password"
        inputRef={passwordRef}
        label={t('settingsAccount.nativePassword.password')}
        labelStyle={stepFieldLabelStyle()}
        value={draft.password}
        onChangeText={(password) => setDraft((current) => ({ ...current, password }))}
        autoComplete={provisioning ? 'new-password' : 'current-password'}
        supportingText={provisioning ? t('settingsAccount.nativePassword.passwordRequirements') : undefined}
        error={problem?.field === 'password' ? problemMessage : null}
        editable={!busy}
        returnKeyType={provisioning ? 'next' : 'go'}
        onSubmitEditing={provisioning ? () => confirmRef.current?.focus() : submitLogin}
    />
    </ListPresentationProvider>
    ) : null}
    {provisioning && collectsCredentials ? (
        <ListPresentationProvider value="page">
        <PasswordField
            testID="email-password-confirm"
            inputRef={confirmRef}
            label={t('settingsAccount.nativePassword.confirmPassword')}
            labelStyle={stepFieldLabelStyle()}
            value={draft.confirmPassword}
            onChangeText={(confirmPassword) => setDraft((current) => ({ ...current, confirmPassword }))}
            autoComplete="new-password"
            error={problem?.field === 'confirmPassword' ? problemMessage : null}
            editable={!busy}
            returnKeyType="go"
            onSubmitEditing={submitProvision}
        />
        </ListPresentationProvider>
    ) : null}
    {provisioning && collectsCredentials && permittedModes.length > 1 ? (
        <FieldItem
            label={t('settingsAccount.nativePassword.accountProtection')}
            labelStyle={stepFieldLabelStyle()}
        >
            {/* A protection is a choice, not a command: option F cards, each saying what it means. */}
            <SelectionTiles
                variant="card"
                accessibilityLabel={t('settingsAccount.nativePassword.accountProtection')}
                testIdPrefix="email-password-protection"
                options={permittedModes.map((candidate) => ({
                    id: candidate,
                    testID: `email-password-protection-${candidate}`,
                    title: candidate === 'e2ee'
                        ? tLoose('settingsAccount.nativePassword.protectionE2ee')
                        : t('settingsAccount.nativePassword.protectionPlain'),
                    subtitle: candidate === 'e2ee'
                        ? tLoose('settingsAccount.nativePassword.protectionE2eeDetail')
                        : t('settingsAccount.nativePassword.protectionPlainDetail'),
                    icon: candidate === 'e2ee' ? 'lock' as const : 'cloud' as const,
                }))}
                value={accountMode}
                onChange={(next) => { if (next) setAccountMode(next); }}
                maximumColumns={1}
            />
        </FieldItem>
    ) : provisioning && collectsCredentials ? (
        <Text testID="email-password-protection-fixed" style={styles.hint}>
            {permittedModes[0] === 'e2ee'
                ? tLoose('settingsAccount.nativePassword.protectionE2eeDetail')
                : t('settingsAccount.nativePassword.protectionPlainDetail')}
        </Text>
    ) : null}
        </>
    );
    // The signed-out Welcome's step (lab direction A): each view is one step with its mark, centred heading and the
    // step's own actions; Back from a sub-view returns to the form it came from through the shell's one Back.
    const stepPresentation = props.presentation === 'step';
    const subViewBack = view.kind === 'forgot'
        ? (props.initialView === 'forgot' ? undefined : () => setView({ kind: props.action }))
        : view.kind === 'reset_requested'
            ? () => setView({ kind: 'forgot' })
            : view.kind === 'verification_sent'
                ? () => setView({ kind: 'provision' })
                : undefined;
    useStepBackOverride(stepPresentation ? subViewBack : undefined);
    // Outside the signed-out shell (no shell Back to route through), the step draws its own Back.
    const stepBack = subViewBack ?? props.onBack;
    const openRecoveryKey = () => {
        // Leave the current auth surface so a modal cannot cover recovery.
        props.onBack?.();
        router.push({
            pathname: '/auth/password/recover',
            params: { target: props.recoveryTarget },
        });
    };
    const stepPrimary = (testID: string, title: string, onPress: () => Promise<void> | void, iconName?: IconName | null) => (
        <StepPrimaryButton
            testID={testID}
            title={title}
            iconName={iconName}
            loading={pendingActionId === testID}
            disabled={pendingActionId !== null && pendingActionId !== testID}
            onPress={() => { void actionAdmission.run(testID, onPress); }}
        />
    );

    if (stepPresentation) {
        const stepHeading = (title: string, extra?: Readonly<{ mark?: IconName; subtitle?: string }>) => (
            <UnauthenticatedStepHeading
                title={title}
                subtitle={extra?.subtitle}
                context={homeChip}
                mark={extra?.mark ? <StepMark iconName={extra.mark} /> : undefined}
            />
        );
        let content: React.ReactNode;
        if (view.kind === 'verification_sent' || view.kind === 'reset_requested') {
            const sent = view;
            content = <>
                {stepHeading(t('settingsAccount.nativePassword.checkYourEmail'), {
                    mark: 'envelope',
                    subtitle: sent.kind === 'verification_sent'
                        ? t('settingsAccount.nativePassword.verificationSent', { email: sent.email })
                        : t('settingsAccount.nativePassword.resetInstructionsSent', { email: sent.email }),
                })}
                {resent ? (
                    <SurfaceStateCard
                        testID="email-password-resent"
                        size="line"
                        lineLayout="notice"
                        kind="empty"
                        iconName="info"
                        title={t('settingsAccount.nativePassword.resentTitle')}
                        reason={t('settingsAccount.nativePassword.resent')}
                        accessibilitySemantics="status"
                    />
                ) : null}
                {formProblem}
                {progressNotice}
                <View style={styles.stepActions}>
                    <WelcomeActionCard
                        testID="email-password-resend"
                        presentation="pill"
                        title={t('settingsAccount.nativePassword.resend')}
                        onPress={() => (sent.kind === 'verification_sent' ? submitProvision() : submitResetRequest())}
                    />
                    <StepQuietAction
                        testID="email-password-change-email"
                        label={t('settingsAccount.nativePassword.useDifferentEmail')}
                        onPress={() => setView({ kind: sent.kind === 'verification_sent' ? 'provision' : 'forgot' })}
                    />
                </View>
            </>;
        } else if (view.kind === 'connect') {
            content = <>
                {stepHeading(t('settingsAccount.nativePassword.connectTitle'), {
                    subtitle: t('settingsAccount.nativePassword.connectFromSecurity'),
                })}
                <StepActions onBack={stepBack}>
                    {stepPrimary('email-password-connect-sign-in', t('settingsAccount.nativePassword.signInFirst'), () => setView({ kind: 'login' }))}
                </StepActions>
            </>;
        } else if (view.kind === 'forgot') {
            const emailReset = props.passwordReset === 'email';
            content = <>
                {stepHeading(t('settingsAccount.nativePassword.forgotTitle'), {
                    mark: 'lifebuoy',
                    subtitle: emailReset ? t('settingsAccount.nativePassword.forgotExplanation') : undefined,
                })}
                {emailReset ? <StepForm>{emailField('email', submitResetRequest)}</StepForm> : null}
                {formProblem}
                {progressNotice}
                <View style={styles.stepActions}>
                    <StepActions onBack={stepBack}>
                        {emailReset
                            ? stepPrimary('email-password-request-reset', t('settingsAccount.nativePassword.emailResetInstructions'), submitResetRequest)
                            : stepPrimary('email-password-use-recovery-key', t('settingsAccount.nativePassword.useRecoveryKey'), openRecoveryKey, 'key')}
                    </StepActions>
                    {emailReset ? (
                        <>
                            <StepOrDivider label={t('common.or')} />
                            <WelcomeActionCard
                                testID="email-password-use-recovery-key"
                                presentation="pill"
                                iconName="key"
                                title={t('settingsAccount.nativePassword.useRecoveryKey')}
                                escape
                                onPress={openRecoveryKey}
                            />
                        </>
                    ) : null}
                </View>
            </>;
        } else {
            const provisioningStep = view.kind === 'provision';
            const collectsStepCredentials = !provisioningStep || !mailboxProofFirst;
            content = <>
                {stepHeading(provisioningStep ? t('settingsAccount.nativePassword.createTitle') : t('settingsAccount.nativePassword.title'))}
                <StepForm>{credentialFields(provisioningStep, collectsStepCredentials)}</StepForm>
                {formProblem}
                {progressNotice}
                <View style={styles.stepActions}>
                    <StepActions onBack={stepBack}>
                        {stepPrimary(
                            provisioningStep ? 'email-password-create' : 'email-password-submit',
                            provisioningStep
                                ? collectsStepCredentials
                                    ? t('settingsAccount.nativePassword.createAccount')
                                    : t('settingsAccount.nativePassword.sendVerification')
                                : t('settingsAccount.nativePassword.signIn'),
                            provisioningStep ? submitProvision : submitLogin,
                        )}
                        {!provisioningStep ? (
                            <StepQuietActions actions={[
                                {
                                    testID: 'email-password-forgot',
                                    label: t('settingsAccount.nativePassword.forgotPassword'),
                                    onPress: () => setView({ kind: 'forgot' }),
                                },
                                ...(props.onOpenEmailProvision ? [{
                                    testID: 'email-password-open-provision',
                                    label: t('settingsAccount.nativePassword.signUpWithEmail'),
                                    onPress: () => { void props.onOpenEmailProvision?.(); },
                                }] : []),
                            ]} />
                        ) : null}
                    </StepActions>
                </View>
            </>;
        }
        return (
            <WelcomeActionAdmissionContext.Provider value={actionAdmission}>
                <View style={styles.stepRoot}>{content}</View>
            </WelcomeActionAdmissionContext.Provider>
        );
    }

    if (view.kind === 'verification_sent' || view.kind === 'reset_requested') {
        const sent = view;
        return (
            <WelcomeActionAdmissionContext.Provider value={actionAdmission}>
            <View style={styles.root}>
                {heading(t('settingsAccount.nativePassword.checkYourEmail'))}
                <Text testID="email-password-sent-detail" style={styles.hint}>
                    {sent.kind === 'verification_sent'
                        ? t('settingsAccount.nativePassword.verificationSent', { email: sent.email })
                        : t('settingsAccount.nativePassword.resetInstructionsSent', { email: sent.email })}
                </Text>
                {resent ? (
                    <Text
                        testID="email-password-resent"
                        accessibilityLiveRegion="polite"
                        role="status"
                        style={styles.hint}
                    >
                        {t('settingsAccount.nativePassword.resent')}
                    </Text>
                ) : null}
                {formProblem}
                {progressNotice}
                <WelcomeActionCard
                    testID="email-password-resend"
                    presentation="button"
                    title={t('settingsAccount.nativePassword.resend')}
                    onPress={() => (sent.kind === 'verification_sent' ? submitProvision() : submitResetRequest())}
                />
                <WelcomeActionCard
                    testID="email-password-change-email"
                    presentation="button"
                    title={t('settingsAccount.nativePassword.useDifferentEmail')}
                    onPress={() => setView({ kind: sent.kind === 'verification_sent' ? 'provision' : 'forgot' })}
                />
                {backAction}
            </View>
            </WelcomeActionAdmissionContext.Provider>
        );
    }

    if (view.kind === 'connect') {
        // `connect` enrols this method on an Account that already exists. It is
        // reachable from Account Security, so say that instead of showing a
        // login form that would create the wrong impression.
        return (
            <WelcomeActionAdmissionContext.Provider value={actionAdmission}>
            <View style={styles.root}>
                {heading(t('settingsAccount.nativePassword.connectTitle'))}
                <Text testID="email-password-connect-detail" style={styles.hint}>
                    {t('settingsAccount.nativePassword.connectFromSecurity')}
                </Text>
                <WelcomeActionCard
                    testID="email-password-connect-sign-in"
                    presentation="button"
                    title={t('settingsAccount.nativePassword.signInFirst')}
                    onPress={() => setView({ kind: 'login' })}
                />
                {backAction}
            </View>
            </WelcomeActionAdmissionContext.Provider>
        );
    }

    if (view.kind === 'forgot') {
        return (
            <WelcomeActionAdmissionContext.Provider value={actionAdmission}>
            <View style={styles.root}>
                {heading(t('settingsAccount.nativePassword.forgotTitle'))}
                {props.passwordReset === 'email' ? (
                    <>
                        <Text style={styles.hint}>{t('settingsAccount.nativePassword.forgotExplanation')}</Text>
                        {emailField('email', submitResetRequest)}
                        {formProblem}
                        {progressNotice}
                        <WelcomeActionCard
                            testID="email-password-request-reset"
                    presentation="button"
                            title={t('settingsAccount.nativePassword.emailResetInstructions')}
                            onPress={submitResetRequest}
                        />
                    </>
                ) : null}
                <WelcomeActionCard
                    testID="email-password-use-recovery-key"
                    presentation="button"
                    title={t('settingsAccount.nativePassword.useRecoveryKey')}
                    onPress={() => {
                        // Leave the current auth surface so a modal cannot cover recovery.
                        props.onBack?.();
                        router.push({
                            pathname: '/auth/password/recover',
                            params: { target: props.recoveryTarget },
                        });
                    }}
                />
                <WelcomeActionCard
                    testID="email-password-forgot-back"
                    presentation="link"
                    title={t('common.back')}
                    iconName="arrow-left"
                    escape
                    onPress={props.initialView === 'forgot' ? props.onBack : () => setView({ kind: props.action })}
                />
            </View>
            </WelcomeActionAdmissionContext.Provider>
        );
    }

    const provisioning = view.kind === 'provision';
    // On a Home that proves the mailbox first, the Account is created on the
    // verification landing. Asking for a password here would collect a secret
    // this step discards and then ask for it a second time.
    const collectsCredentials = !provisioning || !mailboxProofFirst;

    return (
        <WelcomeActionAdmissionContext.Provider value={actionAdmission}>
        <View style={styles.root}>
            {heading(provisioning ? t('settingsAccount.nativePassword.createTitle') : t('settingsAccount.nativePassword.title'))}
            {credentialFields(provisioning, collectsCredentials)}
            {formProblem}
            {progressNotice}
            <WelcomeActionCard
                testID={provisioning ? 'email-password-create' : 'email-password-submit'}
                presentation="button"
                title={provisioning
                    ? collectsCredentials
                        ? t('settingsAccount.nativePassword.createAccount')
                        : t('settingsAccount.nativePassword.sendVerification')
                    : t('settingsAccount.nativePassword.signIn')}
                primary
                onPress={provisioning ? submitProvision : submitLogin}
            />
            {!provisioning ? (
                <WelcomeActionCard
                    testID="email-password-forgot"
                    presentation="link"
                    title={t('settingsAccount.nativePassword.forgotPassword')}
                    iconName="lifebuoy"
                    onPress={() => setView({ kind: 'forgot' })}
                />
            ) : null}
            {!provisioning && props.onOpenEmailProvision ? (
                <WelcomeActionCard
                    testID="email-password-open-provision"
                    presentation="link"
                    title={t('settingsAccount.nativePassword.signUpWithEmail')}
                    onPress={props.onOpenEmailProvision}
                />
            ) : null}
            {backAction}
        </View>
        </WelcomeActionAdmissionContext.Provider>
    );
});

const EMAIL_LABEL_ID = 'email-password-email-label';

const styles = StyleSheet.create((theme) => ({
    // Groups stand a section apart; a field's own label, box and line sit close (StepFieldGroup).
    root: { width: '100%', gap: theme.space.s16 },
    // Direction A rhythm: heading, fields and actions a section apart; fields a group apart.
    stepRoot: { width: '100%', gap: theme.space.s24 },
    stepActions: { width: '100%', alignItems: 'center', gap: theme.space.s16 },
    inlineHeading: { gap: theme.space.s4 },
    title: { ...Typography.variant('title'), color: theme.colors.text.primary },
    hint: { ...Typography.variant('body'), color: theme.colors.text.secondary },
    formError: { ...Typography.variant('body') },
}));
