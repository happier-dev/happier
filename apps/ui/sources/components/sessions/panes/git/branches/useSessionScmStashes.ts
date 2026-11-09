import * as React from 'react';
import type { ScmStashEntry } from '@happier-dev/protocol/scm';

import { resolveScmStashEntries } from '@/scm/stash/useScmStashSummaryCount';
import { sessionScmStashList } from '@/sync/ops';

const EMPTY: readonly ScmStashEntry[] = Object.freeze([]);

/**
 * The session repository's stashes, read while `enabled` and again when `refreshKey` changes (the branch, the
 * snapshot's stash count). The last good list stays while a refresh runs or fails; a failure is not a list.
 */
export function useSessionScmStashes(input: Readonly<{
    sessionId: string;
    serverId?: string;
    enabled: boolean;
    refreshKey: string;
}>): readonly ScmStashEntry[] {
    const [stashes, setStashes] = React.useState<readonly ScmStashEntry[]>(EMPTY);
    React.useEffect(() => {
        if (!input.enabled) return;
        let active = true;
        void sessionScmStashList(input.sessionId, {}, input.serverId).then((response) => {
            if (!active || !response.success) return;
            setStashes(resolveScmStashEntries(response));
        }).catch(() => undefined);
        return () => { active = false; };
    }, [input.enabled, input.refreshKey, input.serverId, input.sessionId]);
    return input.enabled ? stashes : EMPTY;
}
