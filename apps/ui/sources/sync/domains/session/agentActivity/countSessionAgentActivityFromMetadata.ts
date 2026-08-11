import { readSessionAgentActivityHeadlineFromMetadata } from '@happier-dev/protocol';

// The older workflow key's reader still lives beside its presentation, which is where its cross-repo
// parity test pins the literal. Importing it is better than spelling that key a second time here,
// outside the lock; when it follows the unified reader into `packages/protocol` this import goes.
import { readSessionWorkflowActivityHeadlineFromMetadata } from '@/components/sessions/workState/sessionWorkflowActivityPresentation';

import {
    EMPTY_AGENT_ACTIVITY_COUNTS,
    deriveAgentActivityCounts,
    type AgentActivityCounts,
} from './deriveAgentActivityCounts';
import { deriveAgentActivityEntries, toAgentActivityCountable } from './deriveAgentActivityEntries';

/**
 * A session's agent activity, counted from its metadata alone.
 *
 * This is the session LIST's source, and it is metadata-only for a reason that is easy to get wrong:
 * a list row has no transcript. Deriving a roster per row would mean paging in and re-deriving every
 * listed session's messages to draw one number, which is the shape of a measured freeze in this
 * repository's history. The headline is published into session metadata precisely so existence and
 * status arrive with the session itself (R-3), so a row can answer "how many agents" for the cost of
 * one already-decrypted object.
 *
 * It goes through the same merge and the same counter as every other surface — with no local
 * entries — rather than reading `activeEntries.length`. That keeps one grouping rule and one
 * status partition: a session whose row says `3` opens onto a pane that says three.
 *
 * A session whose CLI publishes no headline (an older CLI, or any backend other than Claude, whose
 * launchers are the only ones that compose the publisher) counts zero. That is the §5.2 degrade
 * path, and zero renders nothing rather than something wrong.
 */
export function countSessionAgentActivityFromMetadata(metadata: unknown): AgentActivityCounts {
    const headline = readSessionAgentActivityHeadlineFromMetadata(metadata);
    // Only when the unified key is absent: both headlines project the same committed run snapshots,
    // so reading both would count every run twice.
    const workflowHeadline = headline ? null : readSessionWorkflowActivityHeadlineFromMetadata(metadata);
    if (!headline && !workflowHeadline) return EMPTY_AGENT_ACTIVITY_COUNTS;

    const merged = deriveAgentActivityEntries({ headline, workflowHeadline, local: [] });
    if (merged.entries.length === 0) return EMPTY_AGENT_ACTIVITY_COUNTS;
    return deriveAgentActivityCounts(merged.entries.map(toAgentActivityCountable));
}
