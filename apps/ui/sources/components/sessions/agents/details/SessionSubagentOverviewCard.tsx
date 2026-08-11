import * as React from 'react';

import { resolveAgentActivityEntryFromSubagent } from '@/components/sessions/agentActivity/entry/fromSubagent';
import { useAgentActivityStalenessResolver } from '@/components/sessions/agentActivity/presentation/useAgentActivityStaleness';
import { AgentActivityRow } from '@/components/sessions/agentActivity/row/AgentActivityRow';
import { AGENT_ACTIVITY_SURFACE_DENSITY } from '@/components/sessions/agentActivity/row/agentRowMetrics';
import { deriveSessionSubagentLastActivityAtMs } from '@/sync/domains/session/subagents/deriveSessionSubagentActivityPreview';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { useSessionMessagesReducerSnapshot } from '@/sync/domains/state/storage';

/**
 * The header of a subagent's detail view: the same row the roster shows, read-only.
 *
 * It is the shared row rather than a look-alike because it used to be a look-alike, and the two
 * drifted in exactly the way that costs a reader trust — the roster painted a status in `accent.*`
 * while this card printed the raw enum in grey, so the same agent read as two different things
 * depending on which surface you were on (A1, A3). Rendering the row itself makes divergence
 * impossible rather than merely discouraged.
 *
 * **Sharing the component was not sufficient; the CONFIGURATION had to be shared too.** This host
 * mounted the row with neither of the two decisions its three siblings pass, and each omission was
 * a visible disagreement with the roster the reader had just come from:
 *
 * - **density** fell through to `uiItemDensity` (default cozy), so the same agent was drawn one
 *   step LARGER in the detail header than in the compact roster behind it. It is pinned now,
 *   through the one constant every agent row reads;
 * - **staleness** was never resolved, so a ten-minutes-silent agent kept a turning spinner and a
 *   running clock here while the roster said "no update for over 10 min" about the same row. The
 *   evidence instant comes from the same derivation the roster's enrichment uses — the newest
 *   message in this agent's own sidechain — so the two cannot reach different answers. When there
 *   is no hydrated sidechain the derivation returns `null` and nothing is claimed, which is the
 *   silence rule's own "we have not looked" case rather than a note about our hydration.
 *
 * No `onPress` and no actions: this row *is* the thing you already opened, and the detail view
 * below it carries the transcript and the composer.
 */
export const SessionSubagentOverviewCard = React.memo((props: Readonly<{
    sessionId: string;
    subagent: SessionSubagent;
}>) => {
    const { subagent } = props;
    const { reducerState, reducerVersion } = useSessionMessagesReducerSnapshot(props.sessionId);
    const resolveStaleness = useAgentActivityStalenessResolver();

    const entry = React.useMemo(
        () => resolveAgentActivityEntryFromSubagent({
            subagent,
            lastActivityAtMs: deriveSessionSubagentLastActivityAtMs({ subagent, reducerState }),
        }),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reducerState is mutated in place; reducerVersion is its only change signal (D-4)
        [reducerState, reducerVersion, subagent],
    );

    return (
        <AgentActivityRow
            entry={entry}
            density={AGENT_ACTIVITY_SURFACE_DENSITY}
            staleness={resolveStaleness(entry)}
            showDivider={false}
            testID={`session-subagent-overview:${subagent.id}`}
        />
    );
});
