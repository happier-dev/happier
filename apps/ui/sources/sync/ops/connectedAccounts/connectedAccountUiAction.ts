import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import type { ConnectedServiceConfigurationActionIdV1 } from '@happier-dev/protocol/connect/configurationActionsV1';

/** Connected UI intents share Action admission and retain the invoking Home/Account custody. */
export async function executeConnectedAccountUiAction(input: Readonly<{
    actionId: ConnectedServiceConfigurationActionIdV1;
    input: unknown;
    serverId: string;
    accountId?: string;
    credentials?: AuthCredentials;
    isCurrent?: () => boolean;
}>): Promise<unknown> {
    const { withDefaultActionExecuteContext } = await import('@/sync/ops/actions/defaultActionExecutor');
    const result = await withDefaultActionExecuteContext(undefined, {
        serverId: input.serverId,
        ...(input.accountId ? { expectedAccountId: input.accountId } : {}),
    }, async (executor, account) => {
        if (input.isCurrent?.() === false || (input.credentials
            && resolveAuthCredentialsScopeKey(account.credentials) !== resolveAuthCredentialsScopeKey(input.credentials))) {
            throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
        }
        return await executor.execute(input.actionId, input.input, {
            surface: 'ui', authority: 'present_user', serverId: account.serverId, runtimeAccountId: account.accountId,
        });
    }, input.actionId);
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
    return result.result;
}
