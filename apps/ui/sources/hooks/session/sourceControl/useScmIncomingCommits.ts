import * as React from 'react';
import type { ScmLogEntry } from '@happier-dev/protocol/scm';

import { sessionScmLogList } from '@/sync/ops';
import { selectScmIncomingLogEntries } from '@/scm/history/gitTimelineProjection';
import { SCM_HISTORY_PAGE_SIZE } from '@/scm/history/historyPresentation';

/**
 * The commits origin has that this branch does not (Git lab S3: "Ana pushed 2 commits"), read through the one
 * log RPC with its `incoming` range. `null` while unknown: nothing is behind, the read has not answered, or an
 * older daemon ignored the range (its current-branch page must never be shown as commits to pull).
 *
 * Reads once per (upstream, behind count, branch) and only while the timeline is on screen — never per status poll; the history page
 * size bounds the read, and the timeline marks origin as further back when more are waiting.
 */
export function useScmIncomingCommits(input: Readonly<{
    sessionId: string;
    serverId?: string;
    enabled: boolean;
    upstream: string | null;
    behind: number;
    /** The branch tip; a new tip (or a new upstream count) re-reads what is incoming. */
    head: string | null;
}>): readonly ScmLogEntry[] | null {
    const key = input.enabled && input.upstream && input.behind > 0
        ? JSON.stringify([input.sessionId, input.serverId ?? null, input.upstream, input.behind, input.head])
        : null;
    const [loaded, setLoaded] = React.useState<{ key: string; entries: readonly ScmLogEntry[] | null } | null>(null);
    const { sessionId, serverId, behind } = input;
    React.useEffect(() => {
        if (!key) return;
        let cancelled = false;
        void sessionScmLogList(sessionId, { limit: Math.min(behind, SCM_HISTORY_PAGE_SIZE), skip: 0, range: 'incoming' }, serverId)
            .then((response) => {
                if (!cancelled) setLoaded({ key, entries: selectScmIncomingLogEntries(response) });
            })
            .catch(() => {
                if (!cancelled) setLoaded({ key, entries: null });
            });
        return () => { cancelled = true; };
    }, [behind, key, serverId, sessionId]);
    if (!key) return null;
    // Keep the last answer while a newer read is in flight, so the dashed commits do not blink out on refresh.
    return loaded?.entries ?? null;
}
