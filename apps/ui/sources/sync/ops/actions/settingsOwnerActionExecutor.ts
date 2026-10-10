import type { SettingsOwnerActionExecute } from '@/components/settings/catalog/settingDeclarations';

/** Nested domain writes never inherit the outer Settings Action's approval bypass. */
export function createSettingsOwnerActionExecutor(
    execute: SettingsOwnerActionExecute,
    account: Readonly<{ serverId: string; accountId: string; assertCurrent(): void }>,
): SettingsOwnerActionExecute {
    return async (request) => {
        request.context.signal?.throwIfAborted();
        account.assertCurrent();
        const context = { ...request.context, serverId: account.serverId, runtimeAccountId: account.accountId,
            expectedAccountId: account.accountId, bypassApprovals: false };
        const result = await execute({ ...request, context });
        request.context.signal?.throwIfAborted();
        account.assertCurrent();
        return result;
    };
}
