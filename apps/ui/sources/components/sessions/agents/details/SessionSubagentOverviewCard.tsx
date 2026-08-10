import * as React from 'react';

import { AgentActivityRow } from '@/components/sessions/agentActivity/row/AgentActivityRow';
import { resolveAgentActivityEntryFromSubagent } from '@/components/sessions/agentActivity/sources/fromSessionSubagents';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

/**
 * The header of a subagent's detail view: the same row the roster shows, read-only.
 *
 * It is the shared row rather than a look-alike because it used to be a look-alike, and the two
 * drifted in exactly the way that costs a reader trust — the roster painted a status in `accent.*`
 * while this card printed the raw enum in grey, so the same agent read as two different things
 * depending on which surface you were on (A1, A3). Rendering the row itself makes divergence
 * impossible rather than merely discouraged.
 *
 * No `onPress` and no actions: this row *is* the thing you already opened, and the detail view
 * below it carries the transcript and the composer.
 */
export const SessionSubagentOverviewCard = React.memo((props: Readonly<{
    subagent: SessionSubagent;
}>) => {
    const entry = React.useMemo(
        () => resolveAgentActivityEntryFromSubagent({ subagent: props.subagent }),
        [props.subagent],
    );

    return (
        <AgentActivityRow
            entry={entry}
            showDivider={false}
            testID={`session-subagent-overview:${props.subagent.id}`}
        />
    );
});
