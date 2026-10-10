import * as React from 'react';
import { useRouter } from 'expo-router';
import type { NativeAccountAdmissionV1 } from '@happier-dev/protocol';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { EmailPasswordEntryAction } from '@/auth/capabilities/authMethodCapabilities';
import { resolveEmailPasswordProvisionDefault, resolveEmailPasswordProvisionModes } from '@/auth/capabilities/authMethodCapabilities';
import { loginEmailPassword, type EmailPasswordLoginTarget } from '@/auth/password/loginEmailPassword';
import {
    provisionEmailPasswordAccount,
} from '@/auth/password/provisionEmailPasswordAccount';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
import {
    WelcomeActionAdmissionContext,
    type WelcomeActionAdmission,
} from '@/components/onboarding/preAuth/WelcomeActionList';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { Typography } from '@/constants/Typography';
import { Text, TextInput } from '@/components/ui/text/Text';
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
    /** A validated bounded admission bearer, when creation came from an invitation. */
    admission?: NativeAccountAdmissionV1;
    invitationEmailVerificationRequired?: boolean;
    initialEmail?: string;
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
    const router = useRouter();
    const { theme } = useUnistyles();
    const [draft, setDraft] = React.useState<EmailPasswordDraft>(() => createEmailPasswordDraft(props.initialEmail ?? ''));
    const [view, setView] = React.useState<PanelView>(() => ({ kind: props.action }));
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
        setView({ kind: props.action });
        // Another Home (or a changed Home policy) starts from its own recommendation.
        setAccountMode(defaultAccountMode);
    }, [defaultAccountMode, props.action, props.initialEmail, targetScope]);
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
    ) => (
        <FieldItem label={t('settingsAccount.nativePassword.email')} labelStyle={styles.fieldLabel}>
            <TextInput
                ref={emailRef as never}
                testID="email-password-email"
                accessibilityLabel={t('settingsAccount.nativePassword.email')}
                aria-invalid={problem?.field === 'email'}
                // The refusal is the field's own, exactly as PasswordField
                // already associates its error, so assistive technology reads it
                // with the input rather than as a detached line.
                aria-describedby={emailInvalid ? emailErrorId : undefined}
                style={[styles.input, {
                    color: theme.colors.text.primary,
                    backgroundColor: theme.colors.surface.base,
                    borderColor: problem?.field === 'email' ? theme.colors.status.error : theme.colors.border.default,
                }]}
                value={draft.email}
                onChangeText={(email) => setDraft((current) => ({ ...current, email }))}
                placeholder={t('settingsAccount.nativePassword.emailPlaceholder')}
                placeholderTextColor={theme.colors.text.secondary}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                keyboardType="email-address"
                inputMode="email"
                importantForAutofill="yes"
                autoComplete={autoComplete}
                textContentType="username"
                editable={!busy}
                returnKeyType={onSubmitEditing ? 'go' : 'next'}
                onSubmitEditing={onSubmitEditing ?? (() => passwordRef.current?.focus())}
            />
            {emailInvalid ? (
                <Text
                    testID={emailErrorId}
                    nativeID={emailErrorId}
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                    style={[styles.formError, { color: theme.colors.status.error }]}
                >
                    {problemMessage}
                </Text>
            ) : null}
        </FieldItem>
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

    const backAction = props.onBack ? (
        <WelcomeActionCard
            testID="email-password-back"
            presentation="link"
            title={t('common.back')}
            iconName="arrow-left"
            escape
            onPress={props.onBack}
        />
    ) : null;

    if (view.kind === 'verification_sent' || view.kind === 'reset_requested') {
        const sent = view;
        return (
            <WelcomeActionAdmissionContext.Provider value={actionAdmission}>
            <View style={styles.root}>
                <Text style={styles.title}>{t('settingsAccount.nativePassword.checkYourEmail')}</Text>
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
                    title={t('settingsAccount.nativePassword.resend')}
                    iconName="paper-plane"
                    onPress={() => (sent.kind === 'verification_sent' ? submitProvision() : submitResetRequest())}
                />
                <WelcomeActionCard
                    testID="email-password-change-email"
                    title={t('settingsAccount.nativePassword.useDifferentEmail')}
                    iconName="pencil"
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
                <Text style={styles.title}>{t('settingsAccount.nativePassword.connectTitle')}</Text>
                <Text testID="email-password-connect-detail" style={styles.hint}>
                    {t('settingsAccount.nativePassword.connectFromSecurity')}
                </Text>
                <WelcomeActionCard
                    testID="email-password-connect-sign-in"
                    title={t('settingsAccount.nativePassword.signInFirst')}
                    iconName="sign-in"
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
                <Text style={styles.title}>{t('settingsAccount.nativePassword.forgotTitle')}</Text>
                {props.passwordReset === 'email' ? (
                    <>
                        <Text style={styles.hint}>{t('settingsAccount.nativePassword.forgotExplanation')}</Text>
                        {emailField('email', submitResetRequest)}
                        {formProblem}
                        {progressNotice}
                        <WelcomeActionCard
                            testID="email-password-request-reset"
                            title={t('settingsAccount.nativePassword.emailResetInstructions')}
                            iconName="envelope"
                            onPress={submitResetRequest}
                        />
                    </>
                ) : null}
                <WelcomeActionCard
                    testID="email-password-use-recovery-key"
                    title={t('settingsAccount.nativePassword.useRecoveryKey')}
                    iconName="key"
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
                    onPress={() => setView({ kind: props.action })}
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
            <Text style={styles.title}>
                {provisioning ? t('settingsAccount.nativePassword.createTitle') : t('settingsAccount.nativePassword.title')}
            </Text>
            {props.homeLabel ? (
                <Text testID="email-password-home-label" style={styles.hint}>{props.homeLabel}</Text>
            ) : null}
            {emailField(
                provisioning ? 'email' : 'username',
                collectsCredentials ? undefined : submitProvision,
            )}
            {collectsCredentials ? (
            <PasswordField
                testID="email-password-password"
                inputRef={passwordRef}
                label={t('settingsAccount.nativePassword.password')}
                labelStyle={styles.fieldLabel}
                value={draft.password}
                onChangeText={(password) => setDraft((current) => ({ ...current, password }))}
                autoComplete={provisioning ? 'new-password' : 'current-password'}
                supportingText={provisioning ? t('settingsAccount.nativePassword.passwordRequirements') : undefined}
                error={problem?.field === 'password' ? problemMessage : null}
                editable={!busy}
                returnKeyType={provisioning ? 'next' : 'go'}
                onSubmitEditing={provisioning ? () => confirmRef.current?.focus() : submitLogin}
            />
            ) : (
                <Text testID="email-password-verify-first" style={styles.hint}>
                    {t('settingsAccount.nativePassword.verifyReturnToCreate')}
                </Text>
            )}
            {provisioning && collectsCredentials ? (
                <PasswordField
                    testID="email-password-confirm"
                    inputRef={confirmRef}
                    label={t('settingsAccount.nativePassword.confirmPassword')}
                    labelStyle={styles.fieldLabel}
                    value={draft.confirmPassword}
                    onChangeText={(confirmPassword) => setDraft((current) => ({ ...current, confirmPassword }))}
                    autoComplete="new-password"
                    error={problem?.field === 'confirmPassword' ? problemMessage : null}
                    editable={!busy}
                    returnKeyType="go"
                    onSubmitEditing={submitProvision}
                />
            ) : null}
            {provisioning && collectsCredentials && permittedModes.length > 1 ? (
                <FieldItem
                    label={t('settingsAccount.nativePassword.accountProtection')}
                    labelStyle={styles.fieldLabel}
                    supportingText={accountMode === 'e2ee'
                        ? tLoose('settingsAccount.nativePassword.protectionE2eeDetail')
                        : t('settingsAccount.nativePassword.protectionPlainDetail')}
                >
                    <View
                        style={styles.choices}
                        accessibilityRole="radiogroup"
                        role="radiogroup"
                        accessibilityLabel={t('settingsAccount.nativePassword.accountProtection')}
                    >
                        {permittedModes.map((candidate) => (
                            <WelcomeActionCard
                                key={candidate}
                                testID={`email-password-protection-${candidate}`}
                                title={candidate === 'e2ee'
                                    ? tLoose('settingsAccount.nativePassword.protectionE2ee')
                                    : t('settingsAccount.nativePassword.protectionPlain')}
                                subtitle={candidate === 'e2ee'
                                    ? tLoose('settingsAccount.nativePassword.protectionE2eeDetail')
                                    : t('settingsAccount.nativePassword.protectionPlainDetail')}
                                // A protection is a choice, not a command: it is
                                // announced as the selected option instead of as
                                // one more button that happens to look primary.
                                selectionRole="radio"
                                selected={accountMode === candidate}
                                primary={accountMode === candidate}
                                iconName={candidate === 'e2ee' ? 'lock' : 'cloud'}
                                onPress={() => setAccountMode(candidate)}
                            />
                        ))}
                    </View>
                </FieldItem>
            ) : provisioning && collectsCredentials ? (
                <Text testID="email-password-protection-fixed" style={styles.hint}>
                    {permittedModes[0] === 'e2ee'
                        ? tLoose('settingsAccount.nativePassword.protectionE2eeDetail')
                        : t('settingsAccount.nativePassword.protectionPlainDetail')}
                </Text>
            ) : null}
            {formProblem}
            {progressNotice}
            <WelcomeActionCard
                testID={provisioning ? 'email-password-create' : 'email-password-submit'}
                title={provisioning
                    ? collectsCredentials
                        ? t('settingsAccount.nativePassword.createAccount')
                        : t('settingsAccount.nativePassword.sendVerification')
                    : t('settingsAccount.nativePassword.signIn')}
                iconName="sign-in"
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
            {backAction}
        </View>
        </WelcomeActionAdmissionContext.Provider>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: { width: '100%', gap: 12 },
    fieldLabel: { ...Typography.default('medium'), fontSize: 13, lineHeight: 18, letterSpacing: 0, marginBottom: 8 },
    title: { fontSize: 20, fontWeight: '600', color: theme.colors.text.primary },
    hint: { fontSize: 13, color: theme.colors.text.secondary },
    formError: { fontSize: 13 },
    choices: { gap: 8 },
    input: {
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        minHeight: 44,
    },
}));
