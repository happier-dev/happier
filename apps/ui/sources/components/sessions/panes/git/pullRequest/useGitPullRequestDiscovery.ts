import * as React from 'react';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { sessionScmPullRequestList } from '@/sync/ops/sessionScm';
import { scmStatusSync } from '@/scm/scmStatusSync';

/** Branch discovery is demanded by the presented Git pane, never by snapshot polling. */
export function useGitPullRequestDiscovery(input: Readonly<{
    sessionId: string;
    serverId?: string;
    snapshot: ScmWorkingSnapshot | null;
    machineReachable: boolean;
    lastPushedAt: number | null;
}>) {
    const { sessionId, serverId, snapshot, machineReachable, lastPushedAt } = input;
    const head = snapshot?.branch.head;
    const repoRoot = snapshot?.repo.rootPath;
    const enabled = machineReachable && snapshot?.repo.isRepo === true && snapshot.capabilities?.readPullRequestStatus === true;
    const refresh = React.useCallback(async () => {
        if (!enabled || !head) return;
        await sessionScmPullRequestList(sessionId, { head, state: 'open' }, serverId);
    }, [enabled, head, repoRoot, serverId, sessionId]);
    React.useEffect(() => {
        if (!enabled || !head) return;
        // Listing seeds the SCM projection; ordinary snapshot refreshes only read it.
        void refresh().then(() => scmStatusSync.invalidateFromUserAndAwait(sessionId, serverId)).catch(() => {});
    }, [enabled, head, lastPushedAt, refresh, serverId, sessionId]);
    return refresh;
}
