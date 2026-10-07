import { canonicalizeKeyChallengeV2AudienceOrigin } from '@happier-dev/protocol/auth/keyChallenge';
import { normalizeVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useAuth } from '@/auth/context/AuthContext';
import { authGetTokenAtEndpoint } from '@/auth/flows/getToken';
import { resolveHomeAuthenticationTarget, type ResolvedHomeAuthenticationTarget } from '@/auth/flows/resolveHomeAuthenticationTarget';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { presentFirstKeyCredentialLifecycle } from '@/components/account/presentFirstKeyCredentialLifecycle';
import { SecretKeyEntryForm, type SecretKeyEntrySubmitResult } from '@/components/account/restore/SecretKeyEntryForm';
import { usePortableHomeLinkTarget } from '@/components/teams/join/teamJoinTarget';
import { Text } from '@/components/ui/text/Text';
import { WizardModalShell } from '@/components/onboarding';
import { encodeBase64 } from '@/encryption/base64';
import {
    fetchAccountSecurity,
    prepareE2eeAccountPasswordChange,
    submitE2eeAccountPasswordChange,
} from '@/sync/api/auth/accountSecurity';
import { useExactHomeDestination } from '@/components/account/auth/useExactHomeDestination';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { t } from '@/text';
import { trackAccountRestored } from '@/track';
import { HappyError } from '@/utils/errors/errors';
import { parseToken } from '@/utils/auth/parseToken';

import { PasswordField } from './PasswordField';
import {
    createEmailPasswordDraft,
    describeEmailPasswordFailure,
    resolveEmailPasswordProblemMessage,
    validateEmailPasswordDraft,
    type EmailPasswordDraft,
    type EmailPasswordProblem,
} from './emailPasswordFormModel';

type RecoveryTargetState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable'; retry?: () => void }>
    | Readonly<{ kind: 'ready'; target: ResolvedHomeAuthenticationTarget }>;

const RECOVERY_TARGET_LOADING: RecoveryTargetState = Object.freeze({ kind: 'loading' as const });
const RECOVERY_TARGET_UNAVAILABLE: RecoveryTargetState = Object.freeze({ kind: 'unavailable' as const });

type RecoveryContext = Readonly<{
    accountId: string;
    credentials: AuthCredentials;
    normalizedNativeEmail: string | null;
    credentialRevision: number;
    expectedAudience: Readonly<{ origin: string; serverIdentityId: string }>;
    secret: Uint8Array;
}>;

function clearRecoveryContext(ref: React.MutableRefObject<RecoveryContext | null>): void {
    ref.current?.secret.fill(0);
    ref.current = null;
}

/**
 * Public, bearer-free E2EE password recovery. The recovery key first proves the
 * exact Account on the exact Home; only then can the existing password-mutation
 * owner replace the wrapper around that same secret.
 */
export const E2eePasswordRecoveryScreen = React.memo(function E2eePasswordRecoveryScreen(
    props: Readonly<{ homeTarget: string | null }>,
) {
    const auth = useAuth();
    const router = useRouter();
    // Acquiring the Home a recovery link names — observing it and proving its
    // stable identity before this device records it — belongs to the portable
    // Home link owner. This screen consumes the result and owns nothing about it.
    const portableTarget = usePortableHomeLinkTarget(props.homeTarget);
    const targetState = React.useMemo<RecoveryTargetState>(() => {
        if (portableTarget.kind === 'acquiring') return RECOVERY_TARGET_LOADING;
        if (portableTarget.kind === 'acquisition_failed') {
            return { kind: 'unavailable', retry: portableTarget.retry };
        }
        if (portableTarget.kind !== 'resolved') return RECOVERY_TARGET_UNAVAILABLE;
        const target = resolveHomeAuthenticationTarget(portableTarget.target);
        return target ? { kind: 'ready', target } : RECOVERY_TARGET_UNAVAILABLE;
    }, [portableTarget]);
    const destination = useExactHomeDestination({
        refreshAuth: auth.refreshFromActiveServer,
        onFocused: React.useCallback(() => router.replace('/'), [router]),
    });
    const [phase, setPhase] = React.useState<'key' | 'password'>('key');
    const [draft, setDraft] = React.useState<EmailPasswordDraft>(() => createEmailPasswordDraft());
    const [problem, setProblem] = React.useState<EmailPasswordProblem | null>(null);
    const [busy, setBusy] = React.useState(false);
    const mountedRef = React.useRef(true);
    const targetAbortRef = React.useRef(new AbortController());
    const contextRef = React.useRef<RecoveryContext | null>(null);
    const passwordRef = React.useRef<{ focus: () => void } | null>(null);
    const confirmRef = React.useRef<{ focus: () => void } | null>(null);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            targetAbortRef.current.abort();
            clearRecoveryContext(contextRef);
        };
    }, []);

    // A different Home retires everything proven against the previous one. The
    // in-flight proof is aborted and its secret is zeroed before any new target
    // can be reached.
    React.useEffect(() => {
        targetAbortRef.current.abort();
        targetAbortRef.current = new AbortController();
        clearRecoveryContext(contextRef);
        setPhase('key');
        setDraft(createEmailPasswordDraft());
        setProblem(null);
        setBusy(false);
        return () => {
            targetAbortRef.current.abort();
            clearRecoveryContext(contextRef);
        };
    }, [targetState]);

    const handleKey = React.useCallback(async (input: Readonly<{
        secret: Uint8Array;
    }>): Promise<SecretKeyEntrySubmitResult> => {
        if (targetState.kind !== 'ready') return { kind: 'failed' };
        const { target } = targetState;
        const signal = targetAbortRef.current.signal;
        const isCurrent = () => mountedRef.current && !signal.aborted;
        try {
            const credentials = await authGetTokenAtEndpoint({
                ...target,
                secret: input.secret,
                requireKeyChallengeV2: true,
                requireExistingAccount: true,
                signal,
                isCurrent,
            });
            const accountId = parseToken(credentials.token);
            if (!isCurrent()) return { kind: 'cancelled' };
            const request = createServerFetchAtEndpoint({ ...target, credentials, signal });
            const security = await fetchAccountSecurity(request);
            if (security.encryptionMode !== 'e2ee' || security.password.status !== 'enrolled') {
                throw new HappyError('Recovery key cannot replace this password', false, {
                    kind: 'auth', code: 'credential_inconsistent',
                });
            }
            const audienceOrigin = canonicalizeKeyChallengeV2AudienceOrigin(target.canonicalServerUrl);
            if (!audienceOrigin) {
                throw new HappyError('Recovery target is unavailable', false, {
                    kind: 'auth', code: 'challenge_unavailable',
                });
            }
            clearRecoveryContext(contextRef);
            contextRef.current = {
                accountId,
                credentials,
                normalizedNativeEmail: normalizeVerifiedEmail(security.nativeEmail ?? '')?.normalizedEmail ?? null,
                credentialRevision: security.password.revision,
                expectedAudience: {
                    origin: audienceOrigin,
                    serverIdentityId: target.serverIdentityId,
                },
                secret: input.secret.slice(),
            };
            if (!isCurrent()) {
                clearRecoveryContext(contextRef);
                return { kind: 'cancelled' };
            }
            setPhase('password');
            setProblem(null);
            return { kind: 'completed' };
        } catch (error) {
            return isCurrent()
                ? { kind: 'failed', error, home: target.canonicalServerUrl }
                : { kind: 'cancelled' };
        }
    }, [targetState]);

    const submitPassword = React.useCallback(async () => {
        if (busy || targetState.kind !== 'ready') return;
        const context = contextRef.current;
        if (!context) {
            setPhase('key');
            return;
        }
        const validated = validateEmailPasswordDraft({ purpose: 'recover', draft });
        if (!validated.ok) {
            setProblem(validated.problem);
            if (validated.problem.field === 'password') passwordRef.current?.focus();
            if (validated.problem.field === 'confirmPassword') confirmRef.current?.focus();
            return;
        }
        setProblem(null);
        setBusy(true);
        const signal = targetAbortRef.current.signal;
        try {
            const { target } = targetState;
            const request = createServerFetchAtEndpoint({ ...target, credentials: context.credentials, signal });
            const prepared = await prepareE2eeAccountPasswordChange(request, {
                accountId: context.accountId,
                action: 'recover',
                expectedCredentialRevision: context.credentialRevision,
                normalizedNativeEmail: context.normalizedNativeEmail,
                newPassword: validated.password,
                secret: context.secret,
                expectedAudience: context.expectedAudience,
                signal,
            });
            if (!mountedRef.current || signal.aborted || contextRef.current !== context) return;
            await submitE2eeAccountPasswordChange(request, prepared);
            if (!mountedRef.current || signal.aborted || contextRef.current !== context) return;
            let completed = false;
            await presentFirstKeyCredentialLifecycle({
                run: async () => await auth.loginWithCredentials({
                    token: context.credentials.token,
                    secret: encodeBase64(context.secret, 'base64url'),
                }, {
                    target: { serverUrl: target.canonicalServerUrl, serverId: target.serverId },
                }),
                onCompleted: () => { completed = true; },
            });
            if (!completed || !mountedRef.current || signal.aborted) return;
            clearRecoveryContext(contextRef);
            trackAccountRestored();
            // The recovered credential belongs to this exact Home, which need not
            // be the focused one. Sending the person to the previous Home's
            // content would read as recovery having quietly done nothing.
            await destination.continueToHome(target.serverId);
        } catch (error) {
            if (!mountedRef.current || signal.aborted) return;
            setProblem(describeEmailPasswordFailure(error));
        } finally {
            if (mountedRef.current && !signal.aborted) setBusy(false);
        }
    }, [auth, busy, destination, draft, targetState]);

    const problemMessage = problem ? resolveEmailPasswordProblemMessage(problem) : null;

    // The password is already replaced and the credential persisted. Only
    // reaching that Home is left, so a device that cannot get there keeps the
    // visible retry rather than being dropped back onto the previous Home.
    if (destination.state.kind !== 'idle') {
        const destinationState = destination.state;
        return <WizardModalShell
            testID="e2ee-password-recovery"
            stepIndex={1}
            stepCount={2}
            showSkip={false}
            title={t('settingsAccount.nativePassword.resetTitle')}
            onBack={() => router.back()}
            {...(destinationState.kind === 'blocked'
                ? { onPrimary: destinationState.retry, primaryLabel: t('common.retry') }
                : {})}
        >
            <Text
                testID="e2ee-password-recovery-destination-home"
                accessibilityRole={destinationState.kind === 'blocked' ? 'alert' : undefined}
                accessibilityLiveRegion="polite"
            >
                {destinationState.kind === 'focusing'
                    ? t('settingsAccount.nativePassword.working')
                    : t('settingsAccount.nativePassword.serverUnavailable')}
            </Text>
        </WizardModalShell>;
    }

    if (targetState.kind !== 'ready') {
        const retryTarget = targetState.kind === 'unavailable' ? targetState.retry : undefined;
        return <WizardModalShell
            testID="e2ee-password-recovery"
            stepIndex={0}
            stepCount={2}
            showSkip={false}
            onBack={() => router.back()}
            title={t('settingsAccount.nativePassword.forgotTitle')}
            {...(retryTarget ? { onPrimary: retryTarget, primaryLabel: t('common.retry') } : {})}
        >
            <Text testID="e2ee-password-recovery-target-state" accessibilityRole={targetState.kind === 'unavailable' ? 'alert' : undefined}>
                {targetState.kind === 'loading'
                    ? t('settingsAccount.nativePassword.working')
                    : t('settingsAccount.nativePassword.serverUnavailable')}
            </Text>
        </WizardModalShell>;
    }

    if (phase === 'key') {
        return <WizardModalShell
            testID="e2ee-password-recovery"
            stepIndex={0}
            stepCount={2}
            showSkip={false}
            onBack={() => router.back()}
            title={t('settingsAccount.nativePassword.useRecoveryKey')}
            subtitle={targetState.target.canonicalServerUrl}
        >
            <SecretKeyEntryForm
                description={t('connect.restoreWithSecretKeyDescription')}
                submitTitle={t('settingsAccount.nativePassword.continue')}
                onSubmit={handleKey}
            />
        </WizardModalShell>;
    }

    return <WizardModalShell
        testID="e2ee-password-recovery"
        stepIndex={1}
        stepCount={2}
        showSkip={false}
        title={t('settingsAccount.nativePassword.resetTitle')}
        subtitle={t('settingsAccount.nativePassword.resetChooseNew')}
        onBack={() => {
            clearRecoveryContext(contextRef);
            setDraft(createEmailPasswordDraft());
            setProblem(null);
            setPhase('key');
        }}
        onPrimary={() => { void submitPassword(); }}
        primaryLabel={t('settingsAccount.nativePassword.setNewPassword')}
        primaryDisabled={busy}
    >
        <View style={styles.fields}>
            <PasswordField
                testID="e2ee-password-recovery-password"
                label={t('settingsAccount.nativePassword.newPassword')}
                value={draft.password}
                onChangeText={(password) => setDraft((current) => ({ ...current, password }))}
                autoComplete="new-password"
                inputRef={passwordRef}
                supportingText={t('settingsAccount.nativePassword.passwordRequirements')}
                error={problem?.field === 'password' ? problemMessage : null}
                editable={!busy}
                returnKeyType="next"
                onSubmitEditing={() => confirmRef.current?.focus()}
            />
            <PasswordField
                testID="e2ee-password-recovery-confirm"
                label={t('settingsAccount.nativePassword.confirmPassword')}
                value={draft.confirmPassword}
                onChangeText={(confirmPassword) => setDraft((current) => ({ ...current, confirmPassword }))}
                autoComplete="new-password"
                inputRef={confirmRef}
                error={problem?.field === 'confirmPassword' ? problemMessage : null}
                editable={!busy}
                returnKeyType="done"
                onSubmitEditing={() => { void submitPassword(); }}
            />
            {problem?.field === 'form' && problemMessage ? (
                <Text testID="e2ee-password-recovery-error" accessibilityRole="alert" style={styles.error}>
                    {problemMessage}
                </Text>
            ) : null}
            {busy ? <Text accessibilityLiveRegion="polite">{t('settingsAccount.nativePassword.working')}</Text> : null}
        </View>
    </WizardModalShell>;
});

const styles = StyleSheet.create((theme) => ({
    fields: { gap: 16 },
    error: { color: theme.colors.status.error },
}));
