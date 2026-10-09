import type { AuthCredentialLifecycleResult } from '@/auth/context/AuthContext';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { AccountErasureManagedResourcesReviewRequiredError, type DeleteCurrentAccountOptions } from '@/sync/api/account/deleteCurrentAccount';
import { reviewManagedResourceRemoval } from '@/components/settings/machines/managed/reviewManagedResourceRemoval';
import { removeRunnerCreatorCustodyForAccount } from '@/sync/domains/ephemeralRunner/runnerCreatorDraftRemoval';

export class AccountDeletedLocalCleanupError extends Error {
    readonly retryLocalCleanup: () => Promise<AuthCredentialLifecycleResult>;

    constructor(
        retryLocalCleanup: () => Promise<AuthCredentialLifecycleResult>,
        options?: ErrorOptions,
    ) {
        super('account_deleted_local_cleanup_failed', options);
        this.name = 'AccountDeletedLocalCleanupError';
        this.retryLocalCleanup = retryLocalCleanup;
    }
}

export async function completeAccountDeletion(params: Readonly<{
    target: ServerAccountScopeLifetime;
    deleteCurrentAccount(options?: DeleteCurrentAccountOptions): Promise<Readonly<{ status: 'deleted' }>>;
    logout(options?: Readonly<{ beforeMutation?: () => void | Promise<void> }>): Promise<AuthCredentialLifecycleResult>;
    replace(path: '/'): void;
}>): Promise<AuthCredentialLifecycleResult> {
    let confirmed = false;
    const abortError = () => {
        const error = new Error('account_deletion_canceled');
        error.name = 'AbortError';
        return error;
    };
    const attempt = async (deleteRemotely: boolean): Promise<AuthCredentialLifecycleResult> => {
        const abort = new AbortController();
        const retirement = deleteRemotely ? params.target.onRetire(() => abort.abort()) : null;
        try {
            if (deleteRemotely && !params.target.isCurrent()) throw abortError();
            return await params.logout({
                beforeMutation: async () => {
                    if (deleteRemotely) {
                        let managedResourceDispositions: DeleteCurrentAccountOptions['managedResourceDispositions'];
                        while (true) {
                            if (!params.target.isCurrent() || abort.signal.aborted) throw abortError();
                            try {
                                await params.deleteCurrentAccount({ signal: abort.signal,
                                    ...(managedResourceDispositions ? { managedResourceDispositions } : {}),
                                });
                                confirmed = true;
                                break;
                            } catch (cause) {
                                if (!(cause instanceof AccountErasureManagedResourcesReviewRequiredError)) throw cause;
                                if (!params.target.isCurrent() || abort.signal.aborted) throw abortError();
                                const reviewed = await reviewManagedResourceRemoval(cause.resources);
                                if (!reviewed || !params.target.isCurrent() || abort.signal.aborted) throw abortError();
                                managedResourceDispositions = reviewed;
                            }
                        }
                    }
                    await removeRunnerCreatorCustodyForAccount(params.target.scope);
                    params.replace('/');
                },
            });
        } catch (cause) {
            if (confirmed) throw new AccountDeletedLocalCleanupError(() => attempt(false), { cause });
            throw cause;
        } finally { retirement?.dispose(); }
    };
    return await attempt(true);
}
