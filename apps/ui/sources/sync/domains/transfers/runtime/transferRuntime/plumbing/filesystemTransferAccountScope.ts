import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { resolveTargetServer } from '@/sync/domains/machines/peer/mediation/stream/productionRouteHttp';

/** Account custody outlives the upload signal when its existing finalize continuation is retained. */
export async function captureFilesystemTransferAccountScope(serverId?: string | null, signal?: AbortSignal | null) {
    const server = resolveTargetServer(serverId);
    if (!server) throw new Error('action_home_not_found');
    const account = await captureLazyActionAccountContext(server.serverId);
    const retirement = new AbortController();
    const subscription = account.accountLifetime.onRetire(() => { retirement.abort(); account.dispose(); });
    const live = mergeAbortSignals([signal ?? undefined, retirement.signal]);
    return {
        serverId: account.serverId,
        accountId: account.accountId,
        accountLifetime: account.accountLifetime,
        accountOnlyLifetime: account.accountOnlyLifetime,
        signal: live.signal,
        assertCurrent: () => { live.signal.throwIfAborted(); account.assertAccountCurrent(); },
        assertAccountCurrent: account.assertAccountCurrent,
        dispose: () => { live.dispose(); subscription.dispose(); account.dispose(); },
    };
}
