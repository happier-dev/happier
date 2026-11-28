import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { isLegacyAuthCredentials, type RecoveryKeyReminderTarget } from '@/auth/storage/tokenStorage';
import { SecretKeyBackupModal } from '@/components/account/SecretKeyBackupModal';
import { RecoveryKeyUnlockModal } from '@/components/account/RecoveryKeyUnlockModal';
import { recordRecoveryKeyHandled } from '@/components/account/useRecoveryKeyReminder';
import { Modal } from '@/modal';
import type { FocusReturnRef } from '@/keyboard/focusReturn';
import { t } from '@/text';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { serverFetch, type ServerFetch } from '@/sync/http/client';

/**
 * Whose recovery key is opened. `home` (the default) is the signed-in Home Account: its local secret,
 * else the Home's password unlock. `account_service` is an Account on an account service: this device
 * never holds that key, so it is only ever unlocked with that Account's email and password against the
 * service itself, and saving it answers that service's own reminder.
 */
export type RecoveryKeySource =
    | Readonly<{ kind: 'home' }>
    | Readonly<{
        kind: 'account_service';
        request: ServerFetch;
        reminderTarget: RecoveryKeyReminderTarget;
    }>;

const HOME_SOURCE: RecoveryKeySource = Object.freeze({ kind: 'home' as const });

/**
 * Check before showing or copying the recovery key. `recoveryEmail` is the
 * enrolled password's email from the Account Security projection. `triggerRef`
 * receives focus again when the modal closes.
 */
export function useRecoveryKeyDisclosure(
    recoveryEmail: string | null,
    triggerRef: FocusReturnRef,
    source: RecoveryKeySource = HOME_SOURCE,
): Readonly<{
    canDisclose: boolean;
    /** Opens the backup disclosure (the key, copy, download/share, "I saved it"). */
    open: () => void;
    /**
     * Runs `use` after password unlock or confirmation for a passwordless Home.
     * The caller owns the secret it receives and must not keep it.
     */
    withRecoveryKey: (use: (secret: string | Uint8Array) => void | Promise<void>) => void;
}> {
    const auth = useAuth();
    // An account-service Account's key is never the Home credential's secret.
    const secret = source.kind === 'home' && auth.credentials && isLegacyAuthCredentials(auth.credentials)
        ? auth.credentials.secret
        : null;
    const reminderTarget = source.kind === 'account_service' ? source.reminderTarget : undefined;
    const canDisclose = source.kind === 'account_service' || Boolean(secret || recoveryEmail);

    const showDisclosure = React.useCallback((value: string | Uint8Array) => {
        const target = reminderTarget ?? getActiveServerSnapshot();
        Modal.show({
            component: SecretKeyBackupModal,
            props: {
                secret: value,
                onSaved: () => recordRecoveryKeyHandled(target),
            },
            focusReturnRef: triggerRef,
        });
    }, [reminderTarget, triggerRef]);

    const withRecoveryKey = React.useCallback((use: (secret: string | Uint8Array) => void | Promise<void>) => {
        if (source.kind === 'account_service') {
            const controller = new AbortController();
            const request: ServerFetch = async (path, init, options) => {
                if (controller.signal.aborted) throw new Error('recovery_key_unlock_closed');
                return await source.request(path, { ...init, signal: controller.signal }, options);
            };
            Modal.show({
                component: RecoveryKeyUnlockModal,
                props: {
                    // The service does not disclose its login email; the person types it.
                    email: null,
                    request,
                    onUnlocked: async (recovered) => { await use(recovered.slice()); },
                },
                focusReturnRef: triggerRef,
                onHostUnmount: () => controller.abort(),
            });
            return;
        }
        if (!recoveryEmail) {
            if (!secret) {
                Modal.alert(t('settingsAccount.secretKey'), t('settingsAccount.secretKeyMissing'));
                return;
            }
            const lifetime = captureActiveServerAccountScopeCurrentness();
            const controller = new AbortController();
            const retirement = lifetime.onRetire(() => controller.abort());
            void (async () => {
                try {
                    const confirmed = await Modal.confirm(t('settingsAccount.showRecoveryKey'), t('settingsAccount.backupDescription'), {
                        confirmText: t('settingsAccount.showRecoveryKey'),
                        focusReturnRef: triggerRef,
                        signal: controller.signal,
                    });
                    if (confirmed && lifetime.isCurrent()) await use(secret);
                } finally {
                    retirement.dispose();
                }
            })();
            return;
        }
        const lifetime = captureActiveServerAccountScopeCurrentness();
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        const request = async (...args: Parameters<ServerFetch>) => {
            if (!lifetime.isCurrent() || controller.signal.aborted) throw new Error('action_account_scope_changed');
            const [path, init, options] = args;
            const response = await serverFetch(path, { ...init, signal: controller.signal }, options);
            if (!lifetime.isCurrent() || controller.signal.aborted) throw new Error('action_account_scope_changed');
            return response;
        };
        Modal.show({
            component: RecoveryKeyUnlockModal,
            props: {
                email: recoveryEmail,
                request,
                onUnlocked: async (recovered) => {
                    if (lifetime.isCurrent()) await use(recovered.slice());
                },
            },
            focusReturnRef: triggerRef,
            onHostUnmount: () => {
                controller.abort();
                retirement.dispose();
            },
        });
    }, [recoveryEmail, secret, source, triggerRef]);

    const open = React.useCallback(() => withRecoveryKey(showDisclosure), [showDisclosure, withRecoveryKey]);
    return React.useMemo(() => ({ canDisclose, open, withRecoveryKey }), [canDisclose, open, withRecoveryKey]);
}
