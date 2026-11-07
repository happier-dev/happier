import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readSessionBatchForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionBatchForAuthority';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';

/** Exact structural proofs use the captured Account's existing read transport. */
export function createUiSessionRead(account: LazyActionAccountContext | null | undefined): ActionExecutorDeps['sessionRead'] {
    if (!account) return undefined;
    return async ({ sessionIds, underSessionId, serverId, signal }) => withActionAccountRequestSignal(account, signal, async signal => {
        account.assertCurrent();
        if (serverId && !areServerProfileIdentifiersEquivalent(serverId, account.serverId)) {
            throw new Error('Session read Account scope unavailable');
        }
        const parts = await runWithServerRequestAuthorityForServerAccountScope({ scope: account.accountLifetime.scope,
            activeRequest: account.request }, authority => readSessionBatchForAuthority({ authority, sessionIds, underSessionId,
                includeSnapshot: true, includeTurns: false, includeMessages: false, accessProjectionVersion: 1,
                signal, assertCurrent: account.assertCurrent }));
        return { results: [...parts.values()] };
    });
}
