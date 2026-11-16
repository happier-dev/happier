import type { AuthCredentialLifecycleResult, HomeCredentialTarget } from '@/auth/context/AuthContext';
import { TokenStorage, type AuthCredentials, type RecoveryKeyReminderTarget } from '@/auth/storage/tokenStorage';
import { SecretKeyBackupModal } from '@/components/account/SecretKeyBackupModal';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors/errors';
import { presentFirstKeyCredentialLifecycle } from '@/components/account/presentFirstKeyCredentialLifecycle';

import type { EmailPasswordAuthOutcome } from './EmailPasswordAuthPanel';

const EMAIL_PASSWORD_METHOD_ID = 'email_password';

export type EmailPasswordAuthenticationCompletion = 'completed' | 'retired';

async function discloseProvisionedRecoveryKey(
    recoverySecret: Uint8Array,
    target: RecoveryKeyReminderTarget,
): Promise<'saved' | 'later' | 'interrupted'> {
    const disclosureSecret = recoverySecret.slice();
    recoverySecret.fill(0);

    return await new Promise((resolve) => {
        let settled = false;
        let modalId = '';
        const settle = (result: 'saved' | 'later' | 'interrupted') => {
            if (settled) return;
            settled = true;
            // The decision is captured before resuming any destination. The
            // modal also clears on unmount, but this owner must not depend on
            // navigation successfully unmounting it to retire the bytes.
            disclosureSecret.fill(0);
            resolve(result);
        };

        try {
            modalId = Modal.show({
                component: SecretKeyBackupModal,
                props: {
                    secret: disclosureSecret,
                    onSaved: async () => {
                        await TokenStorage.setRecoveryKeyReminderDismissed(true, target).catch(() => false);
                        settle('saved');
                    },
                    onDefer: async () => {
                        await TokenStorage.setRecoveryKeyReminderDismissed(false, target).catch(() => false);
                        settle('later');
                    },
                },
                // Account creation has already committed. The two explicit actions
                // are the truthful exits; an accidental backdrop/back dismissal
                // must not discard the one process-held disclosure before a choice.
                dismissible: false,
                closeOnBackdrop: false,
                onHostUnmount: () => settle('interrupted'),
            });
        } catch {
            settle('interrupted');
            return;
        }
        if (!modalId) {
            disclosureSecret.fill(0);
            settle('interrupted');
            return;
        }
    });
}

/**
 * Shared post-result boundary for every mounted native email/password host.
 *
 * A provisioned Account already exists when this runs, so credentials are
 * persisted first. Fresh E2EE creation then pauses the caller's destination
 * until the canonical recovery-key modal records Saved or Later. Process loss
 * does not invent durable secret custody: the exact existing credentials stay
 * stored, the reminder remains available, and this invocation does not finish
 * a stale destination. A credential lifecycle that does not complete raises a
 * typed refusal rather than returning a value both hosts would have to branch
 * on identically; `retired` is the one outcome a host may ignore.
 */
export async function completeEmailPasswordAuthentication(params: Readonly<{
    outcome: EmailPasswordAuthOutcome;
    target: HomeCredentialTarget;
    /**
     * Whose recovery key the reminder is about. Defaults to the Home `target`; an Account created on
     * an account service names that service, so the Home's own reminder is never touched.
     */
    reminderTarget?: RecoveryKeyReminderTarget;
    signal?: AbortSignal;
    loginWithCredentials: (
        credentials: AuthCredentials,
        options: Readonly<{ target: HomeCredentialTarget; signInMethodId: string }>,
    ) => Promise<AuthCredentialLifecycleResult>;
    onCompleted: () => void | Promise<void>;
}>): Promise<EmailPasswordAuthenticationCompletion> {
    const reminderTarget: RecoveryKeyReminderTarget = params.reminderTarget ?? params.target;
    let persistence: AuthCredentialLifecycleResult;
    try {
        persistence = await params.loginWithCredentials(params.outcome.credentials, {
            target: params.target,
            signInMethodId: EMAIL_PASSWORD_METHOD_ID,
        });
    } catch (cause) {
        params.outcome.recoverySecret?.fill(0);
        throw cause;
    }
    if (persistence.kind !== 'completed') {
        if (persistence.kind === 'finish_encryption_setup') {
            // Keep the exact custody handle and let the existing presenter own
            // Finish/Abandon/Keep. Its retry still enters canonical adoption.
            const pending = persistence;
            let initial = true;
            let adopted = false;
            await presentFirstKeyCredentialLifecycle({
                run: async () => {
                    if (initial) {
                        initial = false;
                        return pending;
                    }
                    if (params.signal?.aborted) return { kind: 'recovery_failed' };
                    return await params.loginWithCredentials(params.outcome.credentials, { target: params.target, signInMethodId: EMAIL_PASSWORD_METHOD_ID });
                },
                onCompleted: () => { adopted = true; },
            }).catch((cause: unknown) => {
                params.outcome.recoverySecret?.fill(0);
                throw cause;
            });
            if (!adopted) {
                // A created Account still owns its process-held recovery key,
                // even when this device keeps its earlier pending migration.
                if (params.outcome.recoverySecret) {
                    await TokenStorage.setRecoveryKeyReminderDismissed(false, reminderTarget).catch(() => false);
                    await discloseProvisionedRecoveryKey(params.outcome.recoverySecret, reminderTarget);
                }
                return 'retired';
            }
        } else {
            // A provisioned Account still needs its one process-held recovery
            // key disclosed when this device's credential adoption fails.
            if (params.outcome.recoverySecret) {
                await TokenStorage.setRecoveryKeyReminderDismissed(false, reminderTarget).catch(() => false);
                await discloseProvisionedRecoveryKey(params.outcome.recoverySecret, reminderTarget);
            }
            throw new HappyError('Native credentials did not complete their lifecycle on this device', false, {
                kind: 'auth',
                code: 'operation_failed',
            });
        }
    }

    if (params.outcome.recoverySecret) {
        // Once native provision returned a recovery key, the Account already
        // exists. A host transition caused by publishing its credentials must
        // not cancel the one canonical disclosure. Only Save/Later completes
        // the intended destination; process/modal-host loss retires it while
        // the persisted Account remains recoverable through existing Settings.
        await TokenStorage.setRecoveryKeyReminderDismissed(false, reminderTarget).catch(() => false);
        const decision = await discloseProvisionedRecoveryKey(params.outcome.recoverySecret, reminderTarget);
        if (decision === 'interrupted') return 'retired';
    } else if (params.signal?.aborted) {
        return 'retired';
    }

    await params.onCompleted();
    return 'completed';
}
