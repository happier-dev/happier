import type { AuthCredentialLifecycleResult } from '@/auth/context/AuthContext';
import { presentFirstKeyCredentialLifecycle } from '@/components/account/presentFirstKeyCredentialLifecycle';

export async function completeApiTokenSettingsSignOutEverywhere(params: Readonly<{
    signOutEverywhere(): Promise<boolean>;
    logout(options?: Readonly<{ beforeMutation?: () => void | Promise<void> }>): Promise<AuthCredentialLifecycleResult>;
    replace(path: '/'): void;
}>): Promise<boolean> {
    const actionFailed = new Error('account_sessions_sign_out_failed');
    let actionSucceeded = false;

    try {
        await presentFirstKeyCredentialLifecycle({
            run: async () => await params.logout({
                beforeMutation: async () => {
                    if (!(await params.signOutEverywhere())) throw actionFailed;
                    actionSucceeded = true;
                    params.replace('/');
                },
            }),
        });
        return actionSucceeded;
    } catch (error) {
        if (error === actionFailed) return false;
        throw error;
    }
}
