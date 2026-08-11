import * as React from 'react';

import {
    useEnsureSidechainsLoaded,
    type SidechainHydrationStatus,
} from '@/hooks/session/useEnsureSidechainsLoaded';
import { useSessionMessagesReducerSnapshot } from '@/sync/domains/state/storage';

import {
    deriveAgentActivityPreview,
    type AgentActivityPreviewMessage,
    type AgentActivityPreviewModel,
} from './deriveAgentActivityPreview';

/**
 * One sidechain, demand-loaded, projected into the bounded preview.
 *
 * **Everything here happens because a row was EXPANDED.** Rows draw from activity and headline data
 * alone; this hook is mounted by the disclosed body, so a roster of forty agents costs forty rows
 * and zero transcript fetches until somebody asks about one of them.
 *
 * `useEnsureSidechainsLoaded` is the hydration owner and is asked by id (V-2) — no tool call is
 * required, which is exactly why an orphan workflow sidechain can be previewed at all. A second
 * hydration path is the split-brain this wave exists to avoid, so this hook adds none: it fetches
 * through that hook and reads what the reducer stored (V-1).
 *
 * The read is keyed on `reducerVersion` and not on the reducer state object, which is mutated in
 * place for streaming performance — a `useMemo` over the state alone can never recompute, and that
 * exact mistake is how the Agents pane's activity preview once became unrefreshable.
 */

export type AgentActivitySidechainPreview = Readonly<{
    preview: AgentActivityPreviewModel;
    /** Hydration status for THIS sidechain, so a body can say "loading" without guessing. */
    status: SidechainHydrationStatus;
    /** Whether the store holds any message for it at all — distinct from a preview with nothing in it. */
    hasMessages: boolean;
}>;

type SidechainStateLike = Readonly<{
    sidechains?: ReadonlyMap<string, readonly AgentActivityPreviewMessage[]> | null;
}> | null;

export function useAgentActivitySidechainPreview(params: Readonly<{
    sessionId: string;
    sidechainId: string;
}>): AgentActivitySidechainPreview {
    const { sessionId, sidechainId } = params;
    const { reducerState, reducerVersion } = useSessionMessagesReducerSnapshot(sessionId);

    // One id, because one row was expanded. The array identity changes only when the id does, so
    // the hook's own request signature is stable across every streamed commit.
    const sidechainIds = React.useMemo(() => [sidechainId], [sidechainId]);
    const hydration = useEnsureSidechainsLoaded({
        enabled: sidechainId.length > 0 && sessionId.length > 0,
        sessionId,
        sidechainIds,
    });

    const messages = (reducerState as SidechainStateLike)?.sidechains?.get(sidechainId) ?? null;
    const hasMessages = messages != null && messages.length > 0;

    const preview = React.useMemo(
        () => deriveAgentActivityPreview(messages ?? []),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reducerState is mutated in place; reducerVersion is its only change signal (D-4)
        [messages, reducerVersion, sidechainId],
    );

    const status = hydration.bySidechainId[sidechainId]?.status ?? hydration.status;

    return React.useMemo(
        () => ({ preview, status, hasMessages }),
        [hasMessages, preview, status],
    );
}
