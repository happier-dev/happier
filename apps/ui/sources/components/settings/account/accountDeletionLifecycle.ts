import type { AuthCredentialLifecycleResult } from '@/auth/context/AuthContext';

export class AccountDeletedLocalCleanupError extends Error {
    constructor(options?: ErrorOptions) {
        super('account_deleted_local_cleanup_failed', options);
        this.name = 'AccountDeletedLocalCleanupError';
    }
}

export async function completeAccountDeletion(params: Readonly<{
    deleteCurrentAccount(): Promise<Readonly<{ status: 'deleted' }>>;
    logout(options?: Readonly<{ beforeMutation?: () => void | Promise<void> }>): Promise<AuthCredentialLifecycleResult>;
    replace(path: '/'): void;
}>): Promise<AuthCredentialLifecycleResult> {
    let confirmed = false;
    try {
        return await params.logout({
            beforeMutation: async () => {
                await params.deleteCurrentAccount();
                confirmed = true;
                params.replace('/');
            },
        });
    } catch (cause) {
        if (confirmed) throw new AccountDeletedLocalCleanupError({ cause });
        throw cause;
    }
}
