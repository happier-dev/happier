import type { AccountErasureResponseV1 } from '@happier-dev/protocol/auth/accountErasure';
import type { AuthCredentialLifecycleResult } from '@/auth/context/AuthContext';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { AccountErasureManagedResourcesReviewRequiredError, type DeleteCurrentAccountOptions } from '@/sync/api/account/deleteCurrentAccount';
import { reviewManagedResourceRemoval } from '@/components/settings/machines/managed/reviewManagedResourceRemoval';
import { removeRunnerCreatorCustodyForAccount } from '@/sync/domains/ephemeralRunner/runnerCreatorDraftRemoval';

export type AccountDeletionLifecycleResult = AuthCredentialLifecycleResult & Readonly<{
    erasure: AccountErasureResponseV1 | null;
}>;

export class AccountDeletedLocalCleanupError extends Error {
    readonly retryLocalCleanup: () => Promise<AccountDeletionLifecycleResult>;

    constructor(
        retryLocalCleanup: () => Promise<AccountDeletionLifecycleResult>,
        readonly erasure: AccountErasureResponseV1,
        options?: ErrorOptions,
    ) {
        super('account_deleted_local_cleanup_failed', options);
        this.name = 'AccountDeletedLocalCleanupError';
        this.retryLocalCleanup = retryLocalCleanup;
    }
}

export async function completeAccountDeletion(params: Readonly<{
    target: ServerAccountScopeLifetime;
    deleteCurrentAccount(options?: DeleteCurrentAccountOptions): Promise<AccountErasureResponseV1>;
    logout(options?: Readonly<{ beforeMutation?: () => void | Promise<void> }>): Promise<AuthCredentialLifecycleResult>;
    replace(path: '/'): void | Promise<void>;
    confirmManagedResourceRemoval?: boolean;
}>): Promise<AccountDeletionLifecycleResult> {
    let erasure: AccountErasureResponseV1 | null = null;
    const abortError = () => {
        const error = new Error('account_deletion_canceled');
        error.name = 'AbortError';
        return error;
    };
    const attempt = async (deleteRemotely: boolean): Promise<AccountDeletionLifecycleResult> => {
        try {
            if (deleteRemotely && !params.target.isCurrent()) throw abortError();
            const lifecycle = await params.logout({
                beforeMutation: async () => {
                    if (deleteRemotely) {
                        let managedResourceDispositions: DeleteCurrentAccountOptions['managedResourceDispositions'];
                        while (true) {
                            if (!params.target.isCurrent()) throw abortError();
                            try {
                                erasure = await params.deleteCurrentAccount({
                                    ...(managedResourceDispositions ? { managedResourceDispositions } : {}),
                                });
                                break;
                            } catch (cause) {
                                if (!(cause instanceof AccountErasureManagedResourcesReviewRequiredError)) throw cause;
                                if (!params.target.isCurrent()) throw abortError();
                                const reviewed = await reviewManagedResourceRemoval(cause.resources, undefined,
                                    { confirmationRequired: params.confirmManagedResourceRemoval !== false });
                                if (!reviewed || !params.target.isCurrent()) throw abortError();
                                managedResourceDispositions = reviewed;
                            }
                        }
                    }
                    await removeRunnerCreatorCustodyForAccount(params.target.scope);
                    await params.replace('/');
                },
            });
            return { ...lifecycle, erasure };
        } catch (cause) {
            if (erasure) throw new AccountDeletedLocalCleanupError(() => attempt(false), erasure, { cause });
            throw cause;
        }
    };
    return await attempt(true);
}
