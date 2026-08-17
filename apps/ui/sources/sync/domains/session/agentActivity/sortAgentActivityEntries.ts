import { isInProgressAgentActivityStatus } from '@happier-dev/protocol';

import { resolveAgentActivityEvidenceAtMs } from './agentActivityEvidence';
import type { AgentActivityEntry } from './types';

/**
 * The merged roster's order: live work first, then the freshest evidence, then a stable tiebreak.
 *
 * The same shape `deriveSessionSubagents.sortSubagents` uses for the local roster, applied one
 * layer up for one reason: after the merge, both facts it orders on can differ from what the local
 * source knew. The status may have been overruled by the headline, and the evidence instant is the
 * LATER of the two sources — so ordering by the local row's own instant would place a row the merge
 * already knows is the freshest thing in the session below a staler one.
 *
 * Evidence is read from the index rather than from the row, which is the whole point of keeping it
 * out of the row: a fresh observation reorders the list without giving any row a new identity.
 */
export function sortAgentActivityEntries(
    entries: readonly AgentActivityEntry[],
    evidenceAtMsById: ReadonlyMap<string, number>,
): readonly AgentActivityEntry[] {
    if (entries.length < 2) return entries;
    return [...entries].sort((left, right) => {
        const leftLive = isInProgressAgentActivityStatus(left.status) ? 0 : 1;
        const rightLive = isInProgressAgentActivityStatus(right.status) ? 0 : 1;
        if (leftLive !== rightLive) return leftLive - rightLive;

        const leftEvidence = resolveAgentActivityEvidenceAtMs({ entryId: left.id, evidenceAtMsById }) ?? 0;
        const rightEvidence = resolveAgentActivityEvidenceAtMs({ entryId: right.id, evidenceAtMsById }) ?? 0;
        if (leftEvidence !== rightEvidence) return rightEvidence - leftEvidence;

        return left.id.localeCompare(right.id);
    });
}
