import { isInProgressAgentActivityStatus } from '@happier-dev/protocol';

import type { AgentActivityEntry } from './types';

export type AgentActivityLivenessPartition = Readonly<{
    /** Still claiming to be happening — queued, starting, running, blocked, or waiting on a person. */
    live: readonly AgentActivityEntry[];
    /** Everything else, including the ambiguous `unknown`, which is not a claim that work goes on. */
    finished: readonly AgentActivityEntry[];
}>;

const EMPTY_PARTITION: AgentActivityLivenessPartition = Object.freeze({
    live: Object.freeze([]),
    finished: Object.freeze([]),
});

/**
 * Split a merged roster into what is still happening and what is over.
 *
 * The predicate is the protocol's own `isInProgressAgentActivityStatus`, so the roster's two
 * sections, the shared counter and the status vocabulary agree by construction rather than by three
 * surfaces each remembering that `waiting` is not finished and `unknown` is not running.
 *
 * It reads the MERGED status, which is the point: the local transcript lags — a tool call whose
 * result has not arrived still reads as running long after its agent finished — so splitting on the
 * locally derived status alone leaves finished work sitting in the live section.
 */
export function partitionAgentActivityEntriesByLiveness(
    entries: readonly AgentActivityEntry[],
): AgentActivityLivenessPartition {
    if (entries.length === 0) return EMPTY_PARTITION;
    const live: AgentActivityEntry[] = [];
    const finished: AgentActivityEntry[] = [];
    for (const entry of entries) {
        if (isInProgressAgentActivityStatus(entry.status)) live.push(entry);
        else finished.push(entry);
    }
    return { live, finished };
}
