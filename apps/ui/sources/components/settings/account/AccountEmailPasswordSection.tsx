import React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAuth } from '@/auth/context/AuthContext';
import { resolveHomeKeyChallengeExpectedAudience } from '@/auth/flows/resolveHomeAuthenticationTarget';
import { isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { PasswordField } from '@/components/account/auth/emailPassword/PasswordField';
import { EmailPasswordSetupSteps, type EmailPasswordSetupStep } from '@/components/account/auth/emailPassword/EmailPasswordSetupSteps';
import {
    createEmailPasswordDraft,
    describeEmailPasswordFailure,
    requiresAccountSecurityReconciliation,
    resolveEmailPasswordProblemMessage,
    validateEmailPasswordDraft,
    type EmailPasswordDraft,
    type EmailPasswordProblem,
} from '@/components/account/auth/emailPassword/emailPasswordFormModel';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { ACCOUNT_SECURITY_SETTINGS } from './accountSecuritySettings';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { Text } from '@/components/ui/text/Text';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import type { WelcomeActionAdmission } from '@/components/onboarding/preAuth/WelcomeActionList';
import { Modal } from '@/modal';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { maskEmailForNativeAuthPreview } from '@happier-dev/protocol/auth/nativeAuthOneTimeOperation';
import { normalizeVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import type { AccountSecurityGetResponseV1 } from '@happier-dev/protocol/auth/accountSecurity';
import { serverFetch } from '@/sync/http/client';
import { captureActiveServerAccountScopeCurrentness, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useProfile } from '@/sync/domains/state/storage';
import {
    prepareE2eeAccountPasswordChange,
    prepareE2eeAccountPasswordEnroll,
    prepareE2eeAccountPasswordRemove,
} from '@/sync/api/auth/accountSecurity';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import {
    clearAccountPasswordEnrollmentExternalAuthCustody,
    openAccountPasswordEnrollmentExternalAuthSession,
    readAccountPasswordEnrollmentExternalAuthProof,
    startAccountPasswordEnrollmentExternalAuth,
} from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';

import {
    AccountSecurityActionApprovalPendingError,
    createAccountSecurityActionClient,
    type AccountSecurityActionClient,
} from './accountSecurityActionClient';
import {
    accountSecurityProjectionScopeKey,
    getLastKnownAccountSecurityProjection,
    readAccountSecurityProjection,
} from './accountSecurityProjectionStore';
import { presentAccountRecoveryKeyEntry } from './presentAccountRecoveryKeyEntry';

type SectionState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable'; scopeKey: string; problem: EmailPasswordProblem }>
    | Readonly<{ kind: 'ready'; scopeKey: string; projection: AccountSecurityGetResponseV1 }>;

type OpenForm = 'none' | 'change_password' | 'remove_password' | 'change_email';
/**
 * The last completed password mutation, kept only so a finished change is
 * visible. Enrolled -> enrolled leaves every row identical, so without this the
 * only feedback for a multi-second KDF would be the form closing.
 */
type PasswordOutcome = 'set_up' | 'changed' | 'removed';
type PreparedPlainPasswordEnrollment = NonNullable<Awaited<ReturnType<
    typeof readAccountPasswordEnrollmentExternalAuthProof
>>>;
type PendingPlainPasswordEnrollmentOAuth = Readonly<{
    kind: 'oauth';
    provider: string;
    url: string;
    scopeKey: string;
    target: Readonly<{ serverId: string; serverUrl: string }>;
}>;

/**
 * A pending address is only ever echoed back masked. The mailbox itself is the
 * proof channel, and this row stays on screen while anyone can look at it, so it
 * reuses the same canonical preview masker the Home's verification preview uses.
 */
function describePendingVerification(address: string): string {
    const masked = maskEmailForNativeAuthPreview(address);
    return masked
        ? t('settingsAccount.nativePassword.verificationPending', { email: masked })
        : t('settingsAccount.nativePassword.checkYourEmail');
}

function resolveE2eePasswordExpectedAudience(serverId: string) {
    const audience = resolveHomeKeyChallengeExpectedAudience({
        kind: 'saved_profile',
        profileRef: serverId,
    });
    if (!audience) {
        throw new HappyError('Account password challenge audience is unavailable', false, {
            kind: 'auth', code: 'challenge_unavailable',
        });
    }
    return audience;
}

/**
 * The email and password rows of Account Security.
 *
 * It shows the one native sign-in email and the enrolment state of the password
 * credential. It never lists internal verified-mailbox evidence rows, hashes or
 * envelopes, and every mutation goes through the canonical Account Security
 * Actions with the credential revision the projection reported. E2EE proof
 * preparation is local, but its final mutation still crosses that same Action
 * front door.
 */
export const AccountEmailPasswordSection = React.memo(function AccountEmailPasswordSection(props: Readonly<{
    client?: AccountSecurityActionClient;
    /** Exact credential-bound Account when a routed Security screen already resolved it. */
    accountId?: string;
    verificationToken?: string | null;
    connectIntent?: boolean;
    /**
     * Publishes the one Account Security projection this section already reads
     * so the route owner can compose its own rows from it. A second reader would
     * be a second decision-maker for the same Account facts.
     */
    onProjection?: (projection: AccountSecurityGetResponseV1 | null) => void;
}>) {
    const auth = useAuth();
    const profile = useProfile();
    const activeServer = useActiveServerSnapshot();
    // The credential-bound active scope is authoritative while profile storage
    // catches up after a Home switch. The profile remains the compatibility
    // fallback for the initial unbound render and test fixtures.
    const accountId = props.accountId ?? getActiveServerAccountScope()?.accountId ?? profile.id;
    const { theme } = useUnistyles();
    const client = React.useMemo(() => props.client ?? createAccountSecurityActionClient(), [props.client]);
    // Start from the last projection read for this Account and Home, so a page opened after the
    // Account overview does not re-announce facts it already has.
    const [state, setState] = React.useState<SectionState>(() => {
        const initialScopeKey = auth.credentials ? accountSecurityProjectionScopeKey(activeServer.serverId, accountId) : null;
        const known = initialScopeKey ? getLastKnownAccountSecurityProjection(initialScopeKey) : null;
        return known && initialScopeKey ? { kind: 'ready', scopeKey: initialScopeKey, projection: known } : { kind: 'loading' };
    });
    const [openForm, setOpenForm] = React.useState<OpenForm>(
        props.verificationToken || props.connectIntent ? 'change_password' : 'none',
    );
    const [draft, setDraft] = React.useState<EmailPasswordDraft>(() => createEmailPasswordDraft());
    const [problem, setProblem] = React.useState<EmailPasswordProblem | null>(null);
    const [outcome, setOutcome] = React.useState<PasswordOutcome | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [pendingEmail, setPendingEmail] = React.useState<string | null>(null);
    const [pendingEnrollment, setPendingEnrollment] = React.useState(false);
    const [pendingActionId, setPendingActionId] = React.useState<string | null>(null);
    const [pendingPlainPasswordOAuth, setPendingPlainPasswordOAuth] =
        React.useState<PendingPlainPasswordEnrollmentOAuth | null>(null);
    const activeActionRef = React.useRef<Readonly<{ id: string; scopeKey: string }> | null>(null);
    const mountedRef = React.useRef(true);
    const operationAbortRef = React.useRef<AbortController | null>(null);
    const onProjectionRef = React.useRef(props.onProjection);
    /**
     * A recovery secret supplied by the person for this mounted ceremony only.
     * It is never written to storage and is wiped when the section retires or
     * the Account/Home scope changes.
     */
    const unlockedSecretRef = React.useRef<Uint8Array | null>(null);
    const passwordEnrollmentResumeRef = React.useRef<string | null>(null);
    const emailInputRef = React.useRef<{ focus(): void } | null>(null);
    const currentPasswordInputRef = React.useRef<{ focus(): void } | null>(null);
    const passwordInputRef = React.useRef<{ focus(): void } | null>(null);
    const confirmPasswordInputRef = React.useRef<{ focus(): void } | null>(null);
    const scopeKey = auth.credentials
        ? accountSecurityProjectionScopeKey(activeServer.serverId, accountId)
        : null;
    const scopeKeyRef = React.useRef(scopeKey);
    const noopApprovalRefresh = React.useCallback(() => undefined, []);
    const {
        approvalPending,
        requestApproval,
    } = useActionApprovalContinuation({
        scopeKey: scopeKey ?? `unbound:${activeServer.serverId}`,
        serverId: activeServer.serverId,
        // Result-bearing Account Security continuations own their exact
        // completion callback below. A second blanket reader here would race
        // that owner and issue duplicate projection refreshes.
        onExecuted: noopApprovalRefresh,
    });

    // Declared before every consumer effect so the first published projection
    // already reaches the current route owner.
    React.useEffect(() => {
        onProjectionRef.current = props.onProjection;
    });

    React.useEffect(() => {
        // React StrictMode replays mount effects. Every setup must restore the
        // liveness fence after the replayed cleanup.
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            operationAbortRef.current?.abort();
            unlockedSecretRef.current?.fill(0);
            unlockedSecretRef.current = null;
            const expected = {
                accountId,
                target: {
                    serverId: activeServer.serverId,
                    serverUrl: activeServer.serverUrl,
                },
            };
            queueMicrotask(() => {
                if (!mountedRef.current) {
                    clearAccountPasswordEnrollmentExternalAuthCustody(
                        expected,
                    );
                }
            });
        };
    }, [accountId, activeServer.serverId, activeServer.serverUrl]);

    React.useEffect(() => {
        // The ref starts with the first render's scope, so only a real
        // Account/Home transition retires the section. This preserves a
        // purpose-bound verification token on first mount and is idempotent
        // under React StrictMode's effect replay.
        if (scopeKeyRef.current === scopeKey) return;
        clearAccountPasswordEnrollmentExternalAuthCustody();
        scopeKeyRef.current = scopeKey;
        operationAbortRef.current?.abort();
        operationAbortRef.current = null;
        passwordEnrollmentResumeRef.current = null;
        activeActionRef.current = null;
        unlockedSecretRef.current?.fill(0);
        unlockedSecretRef.current = null;
        // The previous Account's facts must not survive into the new scope.
        onProjectionRef.current?.(null);
        const known = scopeKey ? getLastKnownAccountSecurityProjection(scopeKey) : null;
        setState(known && scopeKey ? { kind: 'ready', scopeKey, projection: known } : { kind: 'loading' });
        setOpenForm(props.verificationToken || props.connectIntent ? 'change_password' : 'none');
        setDraft(createEmailPasswordDraft());
        setProblem(null);
        setOutcome(null);
        setBusy(false);
        setPendingEmail(null);
        setPendingEnrollment(false);
        setPendingActionId(null);
        setPendingPlainPasswordOAuth(null);
    }, [props.connectIntent, props.verificationToken, scopeKey]);

    React.useEffect(() => {
        if (!props.verificationToken && !props.connectIntent) return;
        setPendingPlainPasswordOAuth(null);
        clearAccountPasswordEnrollmentExternalAuthCustody({
            accountId,
            target: {
                serverId: activeServer.serverId,
                serverUrl: activeServer.serverUrl,
            },
        });
        setProblem(null);
        setDraft(createEmailPasswordDraft());
        setOpenForm('change_password');
    }, [
        activeServer.serverId,
        activeServer.serverUrl,
        accountId,
        props.connectIntent,
        props.verificationToken,
    ]);

    React.useEffect(() => {
        if (openForm === 'change_password') return;
        setPendingPlainPasswordOAuth(null);
        clearAccountPasswordEnrollmentExternalAuthCustody({
            accountId,
            target: {
                serverId: activeServer.serverId,
                serverUrl: activeServer.serverUrl,
            },
        });
    }, [accountId, activeServer.serverId, activeServer.serverUrl, openForm]);

    /**
     * Reads the projection through the shared owner. The mount read joins a read already in flight
     * for this scope (the Account overview's); every later read (retry, after a mutation) is fresh.
     */
    const reload = React.useCallback(async (options?: Readonly<{ joinInFlight?: boolean }>) => {
        if (!auth.credentials || !scopeKey) return;
        const requestedScopeKey = scopeKey;
        const accountLifetime = captureActiveServerAccountScopeCurrentness();
        const controller = new AbortController();
        const retirement = accountLifetime.onRetire(() => controller.abort());
        try {
            const projection = await readAccountSecurityProjection(
                requestedScopeKey,
                () => client.read(),
                { fresh: options?.joinInFlight !== true },
            );
            if (controller.signal.aborted) return;
            if (!mountedRef.current || !accountLifetime.isCurrent() || scopeKeyRef.current !== requestedScopeKey) return;
            setState({ kind: 'ready', scopeKey: requestedScopeKey, projection });
            onProjectionRef.current?.(projection);
        } catch (cause) {
            if (!mountedRef.current || controller.signal.aborted || !accountLifetime.isCurrent()
                || scopeKeyRef.current !== requestedScopeKey) return;
            setState({ kind: 'unavailable', scopeKey: requestedScopeKey, problem: describeEmailPasswordFailure(cause) });
            onProjectionRef.current?.(null);
        } finally {
            retirement.dispose();
        }
    }, [auth.credentials, client, scopeKey]);

    React.useEffect(() => { void reload({ joinInFlight: true }); }, [reload]);

    const closeForm = React.useCallback(() => {
        setPendingPlainPasswordOAuth(null);
        setOpenForm('none');
        setDraft(createEmailPasswordDraft());
        setProblem(null);
    }, []);

    /**
     * The escape every Cancel control runs. Cancel stays pressable while the
     * section is busy by design, so closing the form must also stop the
     * operation it belongs to: otherwise a deferred preparation (key
     * derivation, reauthentication, approval wait) still dispatches the
     * mutation after the person was told it was cancelled.
     *
     * The HTTP owner decides whether cancellation interrupted an issued write.
     * Its content-free unknown outcome must still be presented in this scope.
     */
    const cancelForm = React.useCallback(() => {
        const inFlight = operationAbortRef.current;
        if (inFlight) {
            // Keep admission until settlement so a replacement cannot overtake
            // an issued write whose outcome is still unknown.
            inFlight.abort();
        }
        closeForm();
    }, [closeForm]);

    const completePlainPasswordEnrollment = React.useCallback(async () => {
        const requestedScopeKey = scopeKey;
        if (!requestedScopeKey || !mountedRef.current || scopeKeyRef.current !== requestedScopeKey) return;
        setProblem(null);
        closeForm();
        setOutcome('set_up');
        await reload();
    }, [closeForm, reload, scopeKey]);

    const reportPlainPasswordEnrollmentApprovalFailure = React.useCallback((code: string) => {
        if (!mountedRef.current || scopeKeyRef.current !== scopeKey) return;
        const nextProblem = describeEmailPasswordFailure(
            new HappyError('Password enrollment approval did not complete', false, {
                kind: 'auth',
                code,
            }),
            { homeLabel: activeServer.serverUrl },
        );
        setProblem(nextProblem);
        if (requiresAccountSecurityReconciliation(nextProblem)) void reload();
    }, [activeServer.serverUrl, reload, scopeKey]);

    /**
     * Stop deferred preparation before Action admission when cancelled. Only
     * the transport can determine whether the subsequent write was issued.
     */
    const dispatchMutation = React.useCallback(async <T,>(
        signal: AbortSignal,
        operation: () => Promise<T>,
    ): Promise<T> => {
        // An escape pressed during the deferred preparation stops here, so the
        // refusal stays a pre-effect one and nothing reaches the Home.
        signal.throwIfAborted();
        return await operation();
    }, []);

    const submitPreparedPlainPasswordEnrollment = React.useCallback(async (
        prepared: PreparedPlainPasswordEnrollment,
        verificationToken: string,
        signal: AbortSignal,
    ): Promise<'completed' | 'approval_pending'> => {
        const target = {
            serverId: activeServer.serverId,
            serverUrl: activeServer.serverUrl,
        };
        const actionInput = {
            v: 1 as const,
            kind: 'plain' as const,
            email: prepared.normalizedNativeEmail,
            targetCredential: prepared.targetCredential,
            verificationToken,
            reauthentication: prepared.externalAuthProof,
        };
        try {
            await dispatchMutation(signal, () => client.enrollPlainPassword(actionInput, signal));
        } catch (cause) {
            if (
                cause instanceof AccountSecurityActionApprovalPendingError
                && cause.actionId === 'account.password.enroll'
                && scopeKey
            ) {
                clearAccountPasswordEnrollmentExternalAuthCustody({
                    accountId,
                    includingClaimed: true,
                    target,
                });
                requestApproval(createActionApprovalContinuation({
                    artifactId: cause.artifactId,
                    actionId: 'account.password.enroll',
                    scope: { serverId: activeServer.serverId, accountId },
                    expectedInput: actionInput,
                    onSucceeded: completePlainPasswordEnrollment,
                    onFailed: reportPlainPasswordEnrollmentApprovalFailure,
                }));
                setProblem(describeEmailPasswordFailure(
                    new HappyError('Password enrollment is waiting for approval', false, {
                        kind: 'auth',
                        code: 'approval_pending',
                    }),
                ));
                return 'approval_pending';
            }
            if (
                cause instanceof HappyError
                && cause.code === 'reauthentication_required'
            ) {
                clearAccountPasswordEnrollmentExternalAuthCustody({
                    accountId,
                    target,
                });
            }
            throw cause;
        }
        clearAccountPasswordEnrollmentExternalAuthCustody({
            accountId,
            target,
        });
        return 'completed';
    }, [
        activeServer.serverId,
        activeServer.serverUrl,
        client,
        completePlainPasswordEnrollment,
        dispatchMutation,
        accountId,
        reportPlainPasswordEnrollmentApprovalFailure,
        requestApproval,
        scopeKey,
    ]);

    const continuePlainPasswordEnrollmentOAuth = React.useCallback(async (
        pending: PendingPlainPasswordEnrollmentOAuth,
        verificationToken: string,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const currentCredentials = auth.credentials;
        if (!currentCredentials || pending.scopeKey !== scopeKey) {
            setPendingPlainPasswordOAuth(null);
            clearAccountPasswordEnrollmentExternalAuthCustody();
            throw new HappyError(
                'Password enrollment proof is unavailable',
                false,
                {
                    kind: 'auth',
                    code: 'password-enrollment-external-auth-invalid',
                },
            );
        }
        let session: Awaited<ReturnType<
            typeof openAccountPasswordEnrollmentExternalAuthSession
        >>;
        try {
            session = await openAccountPasswordEnrollmentExternalAuthSession({
                kind: 'oauth',
                provider: pending.provider,
                url: pending.url,
                currentCredentials,
                target: pending.target,
            });
        } finally {
            if (mountedRef.current) setPendingPlainPasswordOAuth(null);
        }
        if (session.kind !== 'completed') return false;
        const reauthentication = await readAccountPasswordEnrollmentExternalAuthProof({
            accountId,
            currentCredentials,
            target: pending.target,
        });
        if (!reauthentication) {
            throw new HappyError(
                'Password enrollment proof is unavailable',
                false,
                {
                    kind: 'auth',
                    code: 'password-enrollment-external-auth-invalid',
                },
            );
        }
        const submission = await submitPreparedPlainPasswordEnrollment(
            reauthentication,
            verificationToken,
            signal,
        );
        return submission === 'completed';
    }, [accountId, auth.credentials, scopeKey, submitPreparedPlainPasswordEnrollment]);

    const problemMessage = problem ? resolveEmailPasswordProblemMessage(problem) : null;
    const outcomeMessage = outcome === 'set_up'
        ? t('settingsAccount.nativePassword.passwordSetUp')
        : outcome === 'changed'
            ? t('settingsAccount.nativePassword.passwordChanged')
            : outcome === 'removed'
                ? t('settingsAccount.nativePassword.passwordRemoved')
                : null;

    const focusProblem = React.useCallback((nextProblem: EmailPasswordProblem) => {
        requestAnimationFrame(() => {
            if (nextProblem.field === 'email') emailInputRef.current?.focus();
            if (nextProblem.field === 'currentPassword') currentPasswordInputRef.current?.focus();
            if (nextProblem.field === 'password') passwordInputRef.current?.focus();
            if (nextProblem.field === 'confirmPassword') confirmPasswordInputRef.current?.focus();
        });
    }, []);

    const runVisibleAction = React.useCallback(async (
        actionId: string,
        action: () => Promise<void> | void,
    ) => {
        if (!scopeKey || approvalPending || activeActionRef.current !== null) return;
        const activeAction = { id: actionId, scopeKey };
        activeActionRef.current = activeAction;
        setPendingActionId(actionId);
        try {
            await action();
        } finally {
            if (activeActionRef.current === activeAction && scopeKeyRef.current === scopeKey) {
                activeActionRef.current = null;
                setPendingActionId(null);
            }
        }
    }, [approvalPending, scopeKey]);
    const actionAdmission = React.useMemo<WelcomeActionAdmission>(() => ({
        pendingActionId: pendingActionId
            ?? (approvalPending ? 'settings-account-change-password-submit' : null),
        run: runVisibleAction,
    }), [approvalPending, pendingActionId, runVisibleAction]);

    const run = React.useCallback(async (
        operation: (signal: AbortSignal) => Promise<void>,
        credentialField?: 'password' | 'currentPassword',
    ) => {
        if (busy || approvalPending || !scopeKey) return;
        const requestedScopeKey = scopeKey;
        const requestedForm = openForm;
        const controller = new AbortController();
        const accountLifetime = captureActiveServerAccountScopeCurrentness();
        const retirement = accountLifetime.onRetire(() => controller.abort());
        operationAbortRef.current?.abort();
        operationAbortRef.current = controller;
        // A previous outcome is no longer the current truth once new work starts.
        setOutcome(null);
        setBusy(true);
        try {
            if (!accountLifetime.isCurrent() || scopeKeyRef.current !== requestedScopeKey) return;
            await operation(controller.signal);
            if (!accountLifetime.isCurrent() || scopeKeyRef.current !== requestedScopeKey) controller.abort();
        } catch (cause) {
            const unknownOutcome = cause instanceof HappyError && cause.code === 'outcome_unknown';
            if (mountedRef.current && accountLifetime.isCurrent() && scopeKeyRef.current === requestedScopeKey
                && (!controller.signal.aborted || unknownOutcome)) {
                const nextProblem = describeEmailPasswordFailure(cause, {
                    // Named-Home copy ("disabled on X", "update X") is otherwise
                    // rendered with an empty placeholder from this surface.
                    homeLabel: activeServer.serverUrl,
                    ...(credentialField ? { credentialField } : {}),
                });
                if (unknownOutcome) setOpenForm(requestedForm);
                setProblem(nextProblem);
                focusProblem(nextProblem);
                // The Home owns what actually happened. Re-read it rather than
                // leaving a stale revision or an unknown enrolment state on screen.
                if (requiresAccountSecurityReconciliation(nextProblem)) void reload();
            }
        } finally {
            retirement.dispose();
            if (operationAbortRef.current === controller && scopeKeyRef.current === requestedScopeKey) {
                operationAbortRef.current = null;
                if (mountedRef.current) setBusy(false);
            }
        }
    }, [activeServer.serverUrl, approvalPending, busy, focusProblem, openForm, reload, scopeKey]);

    React.useEffect(() => {
        const verificationToken = props.verificationToken;
        const currentCredentials = auth.credentials;
        if (
            !verificationToken
            || state.kind !== 'ready'
            || state.projection.encryptionMode !== 'plain'
            || state.projection.password.status !== 'not_enrolled'
            || !currentCredentials
            || !scopeKey
        ) return;
        const resumeKey = `${scopeKey}\u0000${verificationToken}`;
        if (passwordEnrollmentResumeRef.current === resumeKey) return;
        passwordEnrollmentResumeRef.current = resumeKey;
        void run(async (signal) => {
            const prepared =
                await readAccountPasswordEnrollmentExternalAuthProof({
                    accountId,
                    currentCredentials,
                    target: {
                        serverId: activeServer.serverId,
                        serverUrl: activeServer.serverUrl,
                    },
                });
            if (!prepared) return;
            const submission = await submitPreparedPlainPasswordEnrollment(
                prepared,
                verificationToken,
                signal,
            );
            if (submission === 'approval_pending' || !mountedRef.current || signal.aborted) return;
            await completePlainPasswordEnrollment();
        });
    }, [
        activeServer.serverId,
        activeServer.serverUrl,
        auth.credentials,
        completePlainPasswordEnrollment,
        accountId,
        props.verificationToken,
        run,
        scopeKey,
        state,
        submitPreparedPlainPasswordEnrollment,
    ]);

    const currentCredentials = auth.credentials;
    /**
     * Which surface the current problem belongs to. One `problem` serves every
     * operation, so the pending-confirmation body and an open form in another
     * row must not both announce it.
     */
    const [problemSurface, setProblemSurface] = React.useState<'form' | 'pending'>('form');
    if (!currentCredentials || !scopeKey) return null;

    if (state.kind === 'loading' || state.scopeKey !== scopeKey) {
        // The rows exist before their values do: render them now so nothing
        // below this section moves when the projection lands.
        // (The section's `SettingSection` answers search for these rows until they render.)
        return (
            <ItemGroup title={t('settingsAccount.nativePassword.securitySectionTitle')}>
                <ItemLoadStateRows
                    testID="settings-account-security-loading"
                    state={{ kind: 'loading' }}
                    rows={2}
                    lines={1}
                    accessibilityLabel={t('settingsAccount.nativePassword.securitySectionTitle')}
                />
            </ItemGroup>
        );
    }

    if (state.kind === 'unavailable') {
        // One failure row for the read: what failed, and Retry, which re-reads it. The row stays
        // until the answer lands (Retry shows its own progress), so the section never blanks.
        return (
            <ItemGroup title={t('settingsAccount.nativePassword.securitySectionTitle')}>
                <ItemLoadStateRows
                    testID="settings-account-security-unavailable"
                    state={{
                        kind: 'failed',
                        reason: resolveEmailPasswordProblemMessage(state.problem),
                        onRetry: () => reload(),
                    }}
                />
            </ItemGroup>
        );
    }

    const enrollmentVerificationToken = props.verificationToken;
    const projection = state.projection;
    const revision = projection.password.revision ?? 0;
    const enrolled = projection.password.status === 'enrolled';
    const e2ee = projection.encryptionMode === 'e2ee';
    // A first enrollment proves the mailbox before it may carry a credential,
    // in both Account modes: this step only sends the mail, so asking for a
    // password here would collect a secret the form discards and then ask for
    // it again on the verified continuation. Same shape as
    // `EmailPasswordAuthPanel`'s mailbox-proof-first creation.
    const enrollmentProvesMailboxFirst = !enrolled && !enrollmentVerificationToken;
    const recoverySecret = isLegacyAuthCredentials(currentCredentials)
        ? currentCredentials.secret
        : null;
    const fieldsEditable = !busy && !approvalPending && !pendingPlainPasswordOAuth;
    const emailPending = pendingEmail !== null && !pendingEnrollment;
    const passwordPending = pendingEmail !== null && pendingEnrollment;

    /**
     * The recovery secret an E2EE password mutation must wrap and prove with.
     * A device that already holds it never asks; a data-key-only device asks for
     * the existing recovery key once per mounted ceremony (02.05 §5.5). The
     * caller owns the returned copy and wipes it.
     */
    const resolveE2eeSecretBytes = async (): Promise<Uint8Array | null> => {
        if (recoverySecret) return decodeBase64(recoverySecret, 'base64url');
        if (unlockedSecretRef.current) return unlockedSecretRef.current.slice();
        const requestedScopeKey = scopeKeyRef.current;
        const entered = await presentAccountRecoveryKeyEntry();
        if (!entered) return null;
        if (!mountedRef.current || scopeKeyRef.current !== requestedScopeKey) {
            entered.fill(0);
            return null;
        }
        unlockedSecretRef.current = entered;
        return entered.slice();
    };

    /**
     * Every primary action goes through the section's one admission owner, so a
     * second mutation cannot start while one is in flight and the pending
     * action shows its own progress. Escapes (Cancel) are never admitted.
     */
    const admit = (actionId: string, action: () => Promise<void> | void, surface: 'form' | 'pending' = 'form') => {
        setProblemSurface(surface);
        return actionAdmission.run(actionId, action);
    };
    const admissionState = (actionId: string) => {
        const pending = actionAdmission.pendingActionId === actionId;
        return { loading: pending, disabled: actionAdmission.pendingActionId !== null && !pending };
    };

    /** A problem whose field this form does not render is announced at the form, never dropped. */
    const fieldProblem = (field: EmailPasswordProblem['field']) => (
        problemSurface === 'form' && problem?.field === field ? problemMessage : null
    );
    const formProblem = (renderedFields: readonly EmailPasswordProblem['field'][]) => (
        problemSurface === 'form' && problem && !renderedFields.includes(problem.field) ? problemMessage : null
    );

    const clearPending = () => {
        setPendingEmail(null);
        setPendingEnrollment(false);
        setProblem(null);
    };

    const submitEmailChange = () => run(async (signal) => {
        const email = draft.email.trim();
        const normalized = normalizeVerifiedEmail(email);
        if (!normalized) {
            const nextProblem = {
                field: 'email',
                messageKey: email
                    ? 'settingsAccount.nativePassword.emailInvalid'
                    : 'settingsAccount.nativePassword.emailRequired',
            } as const;
            setProblem(nextProblem);
            focusProblem(nextProblem);
            return;
        }
        setProblem(null);
        await client.requestEmailChange({ email: normalized.address }, signal);
        if (!mountedRef.current || signal.aborted) return;
        // Process-local only: the Home's one-time operation stays
        // the authority and no unverified address is persisted.
        setPendingEmail(normalized.address);
        setPendingEnrollment(false);
        closeForm();
    });

    const resendPending = () => run(async (signal) => {
        if (!pendingEmail) return;
        setProblem(null);
        if (pendingEnrollment) {
            await client.requestPasswordEnrollmentEmail({ email: pendingEmail }, signal);
        } else {
            await client.requestEmailChange({ email: pendingEmail }, signal);
        }
    });

    const continuePasswordEnrollment = () => {
        const pendingOAuth = pendingPlainPasswordOAuth;
        if (!pendingOAuth || !enrollmentVerificationToken) return undefined;
        return run(async (signal) => {
            const completed = await continuePlainPasswordEnrollmentOAuth(
                pendingOAuth,
                enrollmentVerificationToken,
                signal,
            );
            if (!completed || !mountedRef.current || signal.aborted) return;
            await completePlainPasswordEnrollment();
        }, 'password');
    };

    const submitPasswordForm = () => run(async (signal) => {
        if (openForm === 'change_password') {
            const validated = validateEmailPasswordDraft({
                purpose: enrollmentProvesMailboxFirst
                    ? 'verify_email'
                    : enrolled ? 'change' : 'enroll',
                draft,
                requiresCurrentPassword: enrolled && !e2ee,
            });
            if (!validated.ok) {
                setProblem(validated.problem);
                focusProblem(validated.problem);
                return;
            }
            setProblem(null);
            if (!enrolled && !e2ee) {
                if (!enrollmentVerificationToken) {
                    await client.requestPasswordEnrollmentEmail({ email: validated.normalizedEmail }, signal);
                    if (!mountedRef.current) return;
                    setPendingEmail(validated.normalizedEmail);
                    setPendingEnrollment(true);
                    closeForm();
                    return;
                }
                const target = {
                    serverId: activeServer.serverId,
                    serverUrl: activeServer.serverUrl,
                };
                let reauthentication = await readAccountPasswordEnrollmentExternalAuthProof({
                    accountId,
                    currentCredentials,
                    target,
                });
                if (!reauthentication) {
                    const started = await startAccountPasswordEnrollmentExternalAuth({
                        accountId,
                        currentCredentials,
                        linkedProviderIds: (profile.linkedProviders ?? []).map((linked) => linked.id),
                        normalizedNativeEmail: validated.normalizedEmail,
                        newPassword: validated.password,
                        signal,
                        returnTo: `/settings/account/security?${new URLSearchParams({
                            verificationToken: enrollmentVerificationToken,
                            serverId: activeServer.serverId,
                        }).toString()}`,
                        target,
                    });
                    if (started.kind === 'oauth') {
                        if (Platform.OS === 'web') {
                            // Browser popup APIs require a direct user gesture. Preparation above
                            // crosses network boundaries, so expose a second in-memory Continue
                            // action instead of risking a blocked popup or persisting the credential.
                            setPendingPlainPasswordOAuth({
                                ...started,
                                scopeKey,
                                target,
                            });
                            return;
                        }
                        // Native completes the provider session
                        // inline, so this gesture owns settling
                        // the surface exactly like web's Continue.
                        const completed = await continuePlainPasswordEnrollmentOAuth(
                            { ...started, scopeKey, target },
                            enrollmentVerificationToken,
                            signal,
                        );
                        if (!completed || !mountedRef.current || signal.aborted) return;
                        await completePlainPasswordEnrollment();
                        return;
                    } else {
                        reauthentication = {
                            normalizedNativeEmail:
                                started.normalizedNativeEmail,
                            targetCredential:
                                started.targetCredential,
                            externalAuthProof: started.externalAuthProof,
                        };
                    }
                }
                const submission = await submitPreparedPlainPasswordEnrollment(
                    reauthentication,
                    enrollmentVerificationToken,
                    signal,
                );
                if (submission === 'approval_pending') return;
                await completePlainPasswordEnrollment();
                return;
            } else if (e2ee) {
                const enrollmentToken = props.verificationToken ?? null;
                if (!enrolled && !enrollmentToken) {
                    // Prove the mailbox before asking for any recovery secret.
                    await client.requestPasswordEnrollmentEmail({ email: validated.normalizedEmail }, signal);
                    if (!mountedRef.current) return;
                    setPendingEmail(validated.normalizedEmail);
                    setPendingEnrollment(true);
                    closeForm();
                    return;
                }
                const expectedAudience =
                    resolveE2eePasswordExpectedAudience(
                        activeServer.serverId,
                    );
                const secret = await resolveE2eeSecretBytes();
                if (!secret) return;
                try {
                    if (enrolled) {
                        const request = await prepareE2eeAccountPasswordChange(serverFetch, {
                            expectedCredentialRevision: revision,
                            normalizedNativeEmail: normalizeVerifiedEmail(projection.nativeEmail ?? '')?.normalizedEmail ?? null,
                            secret,
                            accountId,
                            expectedAudience,
                            newPassword: validated.password,
                            signal,
                        });
                        await dispatchMutation(signal, () => client.changeE2eePassword(request, signal));
                    } else {
                        const request = await prepareE2eeAccountPasswordEnroll(serverFetch, {
                            email: validated.email,
                            normalizedNativeEmail: validated.normalizedEmail,
                            secret,
                            accountId,
                            expectedAudience,
                            newPassword: validated.password,
                            signal,
                            ...(enrollmentToken ? { verificationToken: enrollmentToken } : {}),
                        });
                        await dispatchMutation(signal, () => client.enrollE2eePassword(request, signal));
                    }
                } finally {
                    secret.fill(0);
                }
            } else if (enrolled) {
                await dispatchMutation(signal, () => client.changePlainPassword({
                    expectedCredentialRevision: revision,
                    currentPassword: draft.currentPassword,
                    newPassword: validated.password,
                }, signal));
            }
        } else {
            if (!e2ee && !draft.currentPassword) {
                const nextProblem = { field: 'currentPassword', messageKey: 'settingsAccount.nativePassword.currentPasswordRequired' } as const;
                setProblem(nextProblem);
                focusProblem(nextProblem);
                return;
            }
            setProblem(null);
            if (e2ee) {
                const expectedAudience =
                    resolveE2eePasswordExpectedAudience(
                        activeServer.serverId,
                    );
                const secret = await resolveE2eeSecretBytes();
                if (!secret) return;
                try {
                    const request = await prepareE2eeAccountPasswordRemove(serverFetch, {
                        expectedCredentialRevision: revision,
                        normalizedNativeEmail: normalizeVerifiedEmail(projection.nativeEmail ?? '')?.normalizedEmail ?? null,
                        secret,
                        accountId,
                        expectedAudience,
                    });
                    await dispatchMutation(signal, () => client.removeE2eePassword(request, signal));
                } finally {
                    secret.fill(0);
                }
            } else {
                await dispatchMutation(signal, () => client.removePlainPassword({
                    expectedCredentialRevision: revision,
                    currentPassword: draft.currentPassword,
                }, signal));
            }
        }
        if (!mountedRef.current || signal.aborted) return;
        closeForm();
        setOutcome(openForm === 'remove_password'
            ? 'removed'
            : enrolled ? 'changed' : 'set_up');
        await reload();
    }, openForm === 'remove_password' || (!e2ee && enrolled) ? 'currentPassword' : 'password');

    const cancelPasswordForm = () => {
        if (!enrolled && !e2ee && props.verificationToken) {
            clearAccountPasswordEnrollmentExternalAuthCustody({
                accountId,
                includingClaimed: true,
                target: {
                    serverId: activeServer.serverId,
                    serverUrl: activeServer.serverUrl,
                },
            });
        }
        cancelForm();
    };

    // --- Row disclosure: each row expands in place to its form or its result.
    /**
     * With no sign-in email yet, the email and the password are added together: the Home links the
     * first address only through the mailbox-first password setup (an email change needs a current
     * address to change). The email row hosts that one flow, step by step, and the Password row
     * says it needs the email first and leads there.
     */
    const setsUpFirstEmail = !enrolled && projection.nativeEmail === null;
    const setupExpanded = openForm === 'change_password' || passwordPending;
    const setupStep: EmailPasswordSetupStep = openForm === 'change_password' && enrollmentVerificationToken
        ? 'password'
        : passwordPending ? 'confirm' : 'email';
    // Until the Home reports the new password, the setup's result is announced where the setup ran.
    const emailExpanded = setsUpFirstEmail
        ? setupExpanded || outcomeMessage !== null
        : openForm === 'change_email' || emailPending;
    const passwordExpanded = openForm === 'change_password' || passwordPending || outcomeMessage !== null;
    const removeExpanded = openForm === 'remove_password';

    const setEmailExpanded = (next: boolean) => {
        if (next) {
            setProblemSurface('form');
            setProblem(null);
            setOutcome(null);
            setPendingEmail(null);
            setPendingEnrollment(false);
            setDraft(createEmailPasswordDraft());
            setOpenForm('change_email');
            return;
        }
        if (openForm === 'change_email') cancelForm();
        else if (emailPending) clearPending();
    };

    const setPasswordExpanded = (next: boolean) => {
        if (next) {
            setProblemSurface('form');
            setProblem(null);
            setOutcome(null);
            setDraft(createEmailPasswordDraft());
            setOpenForm('change_password');
            return;
        }
        setOutcome(null);
        if (openForm === 'change_password') cancelPasswordForm();
        else if (passwordPending) clearPending();
    };

    const setRemoveExpanded = async (next: boolean) => {
        if (!next) {
            cancelForm();
            return;
        }
        const requestedScopeKey = scopeKey;
        const confirmed = await Modal.confirm(
            t('settingsAccount.nativePassword.removePassword'),
            t('settingsAccount.nativePassword.removePasswordConsequence'),
            { cancelText: t('common.cancel'), confirmText: t('settingsAccount.nativePassword.removePassword'), destructive: true },
        );
        if (!confirmed || !mountedRef.current || scopeKeyRef.current !== requestedScopeKey) return;
        setProblemSurface('form');
        setProblem(null);
        setOutcome(null);
        setDraft(createEmailPasswordDraft());
        setOpenForm('remove_password');
    };

    const renderPendingBody = () => {
        if (!pendingEmail) return null;
        const resendState = admissionState('settings-account-change-email-resend');
        const pendingProblem = problemSurface === 'pending' ? problemMessage : null;
        return (
            <View style={styles.body} testID="settings-account-pending-email-actions">
                <View style={styles.notice}>
                    <Icon name="paper-plane" size={16} color={theme.colors.text.secondary} />
                    <Text style={styles.noticeText} accessibilityLiveRegion="polite">
                        {describePendingVerification(pendingEmail)}
                    </Text>
                </View>
                {pendingProblem ? <FormError message={pendingProblem} /> : null}
                <View style={styles.actions}>
                    <RoundButton
                        testID="settings-account-change-email-resend"
                        size="small"
                        display="secondary"
                        title={t('settingsAccount.nativePassword.resend')}
                        loading={resendState.loading}
                        disabled={resendState.disabled}
                        action={() => admit('settings-account-change-email-resend', resendPending, 'pending')}
                    />
                    <RoundButton
                        testID="settings-account-change-email-cancel-pending"
                        size="small"
                        display="inverted"
                        title={t('common.cancel')}
                        onPress={clearPending}
                    />
                </View>
            </View>
        );
    };

    const emailFormError = formProblem(['email']);
    const emailSubmitState = admissionState('settings-account-change-email-submit');
    const submitEmailForm = () => admit('settings-account-change-email-submit', submitEmailChange);

    const passwordFormFields: EmailPasswordProblem['field'][] = openForm === 'remove_password'
        ? (!e2ee ? ['currentPassword'] : [])
        : [
            ...(enrolled && !e2ee ? ['currentPassword' as const] : []),
            ...(!enrolled ? ['email' as const] : []),
            ...(!enrollmentProvesMailboxFirst ? ['password' as const, 'confirmPassword' as const] : []),
        ];
    const passwordFormError = formProblem(passwordFormFields);
    const passwordSubmitId = pendingPlainPasswordOAuth
        ? 'settings-account-password-enrollment-continue'
        : openForm === 'change_password'
            ? 'settings-account-change-password-submit'
            : 'settings-account-remove-password-submit';
    const passwordSubmitState = admissionState(passwordSubmitId);
    const submitPassword = () => admit(
        passwordSubmitId,
        pendingPlainPasswordOAuth && enrollmentVerificationToken ? continuePasswordEnrollment : submitPasswordForm,
    );

    const renderPasswordForm = () => {
        if (openForm !== 'change_password' && openForm !== 'remove_password') return null;
        const removing = openForm === 'remove_password';
        const collectsNewPassword = !removing && !enrollmentProvesMailboxFirst;
        return (
            <View style={styles.body} testID={`settings-account-${removing ? 'remove' : 'change'}-password-form`}>
                <View style={styles.fields}>
                    {enrolled && !e2ee ? (
                        <PasswordField
                            inputRef={currentPasswordInputRef}
                            testID="settings-account-current-password"
                            label={t('settingsAccount.nativePassword.currentPassword')}
                            value={draft.currentPassword}
                            onChangeText={(currentPassword) => setDraft((current) => ({ ...current, currentPassword }))}
                            autoComplete="current-password"
                            error={fieldProblem('currentPassword')}
                            editable={fieldsEditable}
                            returnKeyType={collectsNewPassword ? 'next' : 'go'}
                            onSubmitEditing={collectsNewPassword
                                ? () => passwordInputRef.current?.focus()
                                : () => { void submitPassword(); }}
                        />
                    ) : null}
                    {!enrolled && !removing ? (
                        <FieldItem label={t('settingsAccount.nativePassword.email')}>
                            <FieldTextInput
                                ref={emailInputRef as never}
                                testID="settings-account-password-enroll-email"
                                accessibilityLabel={t('settingsAccount.nativePassword.email')}
                                error={fieldProblem('email')}
                                placeholder={t('settingsAccount.nativePassword.emailPlaceholder')}
                                value={draft.email}
                                onChangeText={(email) => setDraft((current) => ({ ...current, email }))}
                                keyboardType="email-address"
                                inputMode="email"
                                autoComplete="email"
                                textContentType="username"
                                editable={fieldsEditable}
                                returnKeyType={collectsNewPassword ? 'next' : 'go'}
                                onSubmitEditing={collectsNewPassword
                                    ? () => passwordInputRef.current?.focus()
                                    : () => { void submitPassword(); }}
                            />
                        </FieldItem>
                    ) : null}
                    {collectsNewPassword ? (
                        <>
                            <PasswordField
                                inputRef={passwordInputRef}
                                testID="settings-account-new-password"
                                label={t('settingsAccount.nativePassword.newPassword')}
                                value={draft.password}
                                onChangeText={(password) => setDraft((current) => ({ ...current, password }))}
                                autoComplete="new-password"
                                supportingText={t('settingsAccount.nativePassword.passwordRequirements')}
                                error={fieldProblem('password')}
                                editable={fieldsEditable}
                                returnKeyType="next"
                                onSubmitEditing={() => confirmPasswordInputRef.current?.focus()}
                            />
                            <PasswordField
                                inputRef={confirmPasswordInputRef}
                                testID="settings-account-confirm-password"
                                label={t('settingsAccount.nativePassword.confirmPassword')}
                                value={draft.confirmPassword}
                                onChangeText={(confirmPassword) => setDraft((current) => ({ ...current, confirmPassword }))}
                                autoComplete="new-password"
                                error={fieldProblem('confirmPassword')}
                                editable={fieldsEditable}
                                returnKeyType="go"
                                onSubmitEditing={() => { void submitPassword(); }}
                            />
                        </>
                    ) : null}
                </View>
                {passwordFormError ? (
                    <FormError testID="settings-account-password-form-error" message={passwordFormError} />
                ) : null}
                <View style={styles.actions}>
                    <RoundButton
                        testID={passwordSubmitId}
                        size="small"
                        display={removing && !pendingPlainPasswordOAuth ? 'destructive' : 'default'}
                        title={pendingPlainPasswordOAuth
                            ? t('common.continue')
                            : !removing
                                ? enrollmentProvesMailboxFirst
                                    ? t('settingsAccount.nativePassword.sendVerification')
                                    : enrolled ? t('settingsAccount.nativePassword.changePassword') : t('settingsAccount.nativePassword.setNewPassword')
                                : t('settingsAccount.nativePassword.removePassword')}
                        loading={passwordSubmitState.loading}
                        disabled={passwordSubmitState.disabled}
                        action={submitPassword}
                    />
                    <RoundButton
                        testID="settings-account-password-form-cancel"
                        size="small"
                        display="inverted"
                        title={t('common.cancel')}
                        onPress={cancelPasswordForm}
                    />
                </View>
            </View>
        );
    };

    const renderOutcome = () => outcomeMessage ? (
        <View style={styles.body}>
            <View style={styles.notice}>
                <Icon name="check" size={16} color={theme.colors.state.success.foreground} />
                <Text
                    testID="settings-account-password-outcome"
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                    style={[styles.noticeText, { color: theme.colors.state.success.foreground }]}
                >{outcomeMessage}</Text>
            </View>
        </View>
    ) : null;

    const openSetupAtEmail = () => {
        if (!setupExpanded) setPasswordExpanded(true);
        requestAnimationFrame(() => emailInputRef.current?.focus());
    };

    if (setsUpFirstEmail) {
        return (
            <ItemGroup title={t('settingsAccount.nativePassword.securitySectionTitle')}>
                <SettingAnchor setting={ACCOUNT_SECURITY_SETTINGS.settings.signInEmail}>
                    <ExpandableItem
                        testID="settings-account-sign-in-email-row"
                        expanded={emailExpanded}
                        onExpandedChange={setPasswordExpanded}
                        header={({ headerProps }) => (
                            <Item
                                {...headerProps}
                                testID="settings-account-sign-in-email"
                                title={t('settingsAccount.nativePassword.signInEmail')}
                                detail={t('settingsAccount.nativePassword.signInEmailNotSet')}
                            />
                        )}
                    >
                        {setupExpanded ? <EmailPasswordSetupSteps step={setupStep} /> : null}
                        {renderOutcome()}
                        {passwordPending ? renderPendingBody() : null}
                        {openForm === 'change_password' ? renderPasswordForm() : null}
                    </ExpandableItem>
                </SettingAnchor>
                <SettingAnchor setting={ACCOUNT_SECURITY_SETTINGS.settings.password}>
                    <Item
                        testID="settings-account-password"
                        title={t('settingsAccount.nativePassword.password')}
                        detail={t('settingsAccount.nativePassword.passwordNeedsEmail')}
                        accessibilityHint={t('settingsAccount.nativePassword.passwordNeedsEmailHint')}
                        showChevron={false}
                        onPress={openSetupAtEmail}
                    />
                </SettingAnchor>
            </ItemGroup>
        );
    }

    return (
        <ItemGroup title={t('settingsAccount.nativePassword.securitySectionTitle')}>
            <SettingAnchor setting={ACCOUNT_SECURITY_SETTINGS.settings.signInEmail}>
                <ExpandableItem
                    testID="settings-account-sign-in-email-row"
                    expanded={emailExpanded}
                    onExpandedChange={setEmailExpanded}
                    header={({ headerProps }) => (
                        <Item
                            {...headerProps}
                            testID="settings-account-sign-in-email"
                            title={t('settingsAccount.nativePassword.signInEmail')}
                            detail={projection.nativeEmail ?? t('settingsAccount.nativePassword.signInEmailNotSet')}
                        />
                    )}
                >
                    {emailPending ? renderPendingBody() : null}
                    {openForm === 'change_email' ? (
                        <View style={styles.body} testID="settings-account-change-email-form">
                            <View style={styles.fields}>
                                <FieldItem
                                    label={t('settingsAccount.nativePassword.email')}
                                    supportingText={t('settingsAccount.nativePassword.changeEmailExplanation')}
                                >
                                    <FieldTextInput
                                        ref={emailInputRef as never}
                                        testID="settings-account-change-email-input"
                                        accessibilityLabel={t('settingsAccount.nativePassword.email')}
                                        error={fieldProblem('email')}
                                        placeholder={t('settingsAccount.nativePassword.emailPlaceholder')}
                                        value={draft.email}
                                        onChangeText={(email) => setDraft((current) => ({ ...current, email }))}
                                        keyboardType="email-address"
                                        inputMode="email"
                                        autoComplete="email"
                                        textContentType="username"
                                        editable={fieldsEditable}
                                        returnKeyType="go"
                                        onSubmitEditing={() => { void submitEmailForm(); }}
                                    />
                                </FieldItem>
                            </View>
                            {emailFormError ? (
                                <FormError testID="settings-account-change-email-form-error" message={emailFormError} />
                            ) : null}
                            <View style={styles.actions}>
                                <RoundButton
                                    testID="settings-account-change-email-submit"
                                    size="small"
                                    title={t('settingsAccount.nativePassword.sendVerification')}
                                    loading={emailSubmitState.loading}
                                    disabled={emailSubmitState.disabled}
                                    action={submitEmailForm}
                                />
                                <RoundButton
                                    testID="settings-account-change-email-cancel"
                                    size="small"
                                    display="inverted"
                                    title={t('common.cancel')}
                                    onPress={cancelForm}
                                />
                            </View>
                        </View>
                    ) : null}
                </ExpandableItem>
            </SettingAnchor>
            <SettingAnchor setting={ACCOUNT_SECURITY_SETTINGS.settings.password}>
                <ExpandableItem
                    testID="settings-account-password-row"
                    expanded={passwordExpanded}
                    onExpandedChange={setPasswordExpanded}
                    header={({ headerProps }) => (
                        <Item
                            {...headerProps}
                            testID="settings-account-password"
                            title={t('settingsAccount.nativePassword.password')}
                            detail={enrolled ? t('settingsAccount.nativePassword.passwordEnrolled') : t('settingsAccount.nativePassword.passwordNotEnrolled')}
                        />
                    )}
                >
                    {renderOutcome()}
                    {passwordPending ? renderPendingBody() : null}
                    {openForm === 'change_password' ? renderPasswordForm() : null}
                </ExpandableItem>
            </SettingAnchor>
            {enrolled ? (
                <ExpandableItem
                    testID="settings-account-password-remove-row"
                    expanded={removeExpanded}
                    onExpandedChange={(next) => { void setRemoveExpanded(next); }}
                    header={({ headerProps }) => (
                        <Item
                            {...headerProps}
                            testID="settings-account-password-remove"
                            title={t('settingsAccount.nativePassword.removePassword')}
                            subtitle={t('settingsAccount.nativePassword.removePasswordSubtitle')}
                            destructive
                            showChevron={false}
                        />
                    )}
                >
                    {removeExpanded ? renderPasswordForm() : null}
                </ExpandableItem>
            ) : null}
        </ItemGroup>
    );
});

/** An error that belongs to one field, announced beneath it. */
/** An error with no field of its own in this form, announced above the actions. */
function FormError(props: Readonly<{ message: string; testID?: string }>) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.notice}>
            <Icon name="warning" size={16} color={theme.colors.status.error} />
            <Text testID={props.testID} accessibilityRole="alert" accessibilityLiveRegion="polite"
                style={[styles.noticeText, { color: theme.colors.status.error }]}>{props.message}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    // Aligned to the row's own text inset so the form reads as the row's continuation.
    body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16, gap: 14 },
    // Text fields stay a readable width on wide pages instead of spanning the sheet.
    fields: { gap: 12, maxWidth: 480, width: '100%' },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
    notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, maxWidth: 560 },
    noticeText: { flex: 1, fontSize: 14, lineHeight: 20, color: theme.colors.text.secondary },
}));
