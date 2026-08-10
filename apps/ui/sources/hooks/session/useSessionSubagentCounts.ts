import * as React from 'react';

import type { UseDirectSessionRuntimeResult } from '@/components/sessions/model/useDirectSessionRuntime';
import { useSessionSubagents } from '@/hooks/session/useSessionSubagents';
import { deriveSessionSubagentCounts } from '@/sync/domains/session/subagents/deriveSessionSubagentCounts';
import { useSession } from '@/sync/domains/state/storage';
import { useSessionSubagentSourceMessages } from '@/sync/store/hooks';

/**
 * A session's live subagent counts, for a surface that shows *how many* without showing the roster.
 *
 * It composes the existing owners rather than counting again: the subagent-source message selector,
 * `useSessionSubagents`, and `deriveSessionSubagentCounts`. There is deliberately no second counting
 * rule here — a badge that disagreed with the roster it points at would be worse than no badge.
 *
 * The direct-session runtime is stubbed out on purpose. `useSessionSubagents` only uses it to decide
 * whether execution runs are *controllable*, which is a capability of a row, not of a count; letting
 * this hook create a real one would attach a second sub-second direct-session poll per session for
 * nothing.
 */
const COUNT_ONLY_DIRECT_SESSION_RUNTIME: UseDirectSessionRuntimeResult = Object.freeze({
    directSessionLink: null,
    status: null,
    refreshNow: async () => null,
});

export type SessionSubagentCounts = ReturnType<typeof deriveSessionSubagentCounts>;

export function useSessionSubagentCounts(sessionId: string): SessionSubagentCounts {
    const session = useSession(sessionId);
    const subagentSourceMessages = useSessionSubagentSourceMessages(sessionId);
    const { subagents } = useSessionSubagents({
        sessionId,
        session,
        messages: subagentSourceMessages,
        directSessionRuntime: COUNT_ONLY_DIRECT_SESSION_RUNTIME,
    });
    return React.useMemo(() => deriveSessionSubagentCounts(subagents), [subagents]);
}
