import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { getCurrentAuth } from '@/auth/context/currentAuth';
import { presentFirstKeyCredentialLifecycle } from '@/components/account/presentFirstKeyCredentialLifecycle';
import { AccountDeletedLocalCleanupError, completeAccountDeletion, type AccountDeletionLifecycleResult } from '@/components/settings/account/accountDeletionLifecycle';
import { Modal } from '@/modal';
import { deleteCurrentAccount } from '@/sync/api/account/deleteCurrentAccount';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { t } from '@/text';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Admission supplies the original Account; Auth still owns credential custody and teardown. */
export function createUiAccountLifecycleAction(account: LazyActionAccountContext,
    openRoute: (path: string) => void | Promise<void>): NonNullable<ActionExecutorDeps['accountLifecycleAction']> {
    return async ({ actionId, input, context }) => {
        account.assertCurrent();
        if (input.accountId !== account.accountId || !areServerProfileIdentifiersEquivalent(input.serverId, account.serverId)) {
            return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        }
        const auth = getCurrentAuth();
        if (!auth) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
        const target = { serverId: account.serverId, serverUrl: account.endpointUrl };
        const leave = async () => {
            if (areServerProfileIdentifiersEquivalent(getActiveServerSnapshot().serverId, account.serverId)) await openRoute('/');
        };
        const beforeCredentialRemoval = async () => {
            account.assertCurrent();
            context.signal?.throwIfAborted();
            // Auth invokes this only after its first-key custody guard allows
            // leaving; retire the signed-in page before removing credentials.
            await leave();
        };
        let completed = false;
        if (actionId !== 'account.delete') {
            await presentFirstKeyCredentialLifecycle({
                run: () => actionId === 'account.credentials.forgetAll'
                    ? auth.logout({ scope: 'all-credentials', beforeMutation: beforeCredentialRemoval })
                    : auth.logout({ target, expectedCredentials: account.credentials, beforeMutation: beforeCredentialRemoval }),
                onCompleted: () => {
                    completed = true;
                },
            });
            return { ok: true, result: { status: completed
                ? actionId === 'account.signOut' ? 'signed_out' : 'forgotten' : 'cancelled' } };
        }
        // The Action front door already confirmed or waived this exact deletion.
        // Newly discovered resource responsibility uses that same user's policy.
        const confirmManagedResourceRemoval = isApprovalRequiredByActionsSettings('account.delete',
            normalizeActionsSettingsV1(context.actionsSettings), { surface: context.surface });
        account.assertCurrent();
        context.signal?.throwIfAborted();
        let run = () => completeAccountDeletion({ target: account.accountLifetime, confirmManagedResourceRemoval,
            deleteCurrentAccount: options => deleteCurrentAccount(account.credentials, { ...options, request: account.request }),
            logout: options => auth.logout({ ...options, target, expectedCredentials: account.credentials }),
            replace: () => leave(),
        });
        const deletion: { erasure: AccountDeletionLifecycleResult['erasure'] } = { erasure: null };
        while (true) {
            try {
                await presentFirstKeyCredentialLifecycle({ run: async () => {
                    const result = await run();
                    deletion.erasure = result.erasure;
                    return result;
                }, onCompleted: () => { completed = true; } });
                const status = completed && deletion.erasure ? deletion.erasure.status : 'cancelled';
                if (status === 'disabled_pending_completion') {
                    await Modal.alertAsync(t('homeGovernance.deleteIncompleteTitle'), t('settingsAccount.deleteAccountFinishing'));
                }
                return { ok: true, result: { status } };
            } catch (error) {
                if (!(error instanceof AccountDeletedLocalCleanupError)) throw error;
                let retry = false;
                const deletionPending = error.erasure.status === 'disabled_pending_completion';
                await Modal.alertAsync(
                    t(deletionPending ? 'homeGovernance.deleteIncompleteTitle' : 'settingsAccount.deleteAccountCleanupFailedTitle'),
                    t(deletionPending ? 'settingsAccount.deleteAccountFinishingCleanupFailed' : 'settingsAccount.deleteAccountCleanupFailed'), [
                    { text: t('common.cancel'), style: 'cancel' }, { text: t('common.retry'), onPress: () => { retry = true; } },
                ]);
                if (!retry) return { ok: true, result: { status: deletionPending ? 'disabled_pending_completion' : 'deleted_cleanup_pending' } };
                run = error.retryLocalCleanup;
            }
        }
    };
}
