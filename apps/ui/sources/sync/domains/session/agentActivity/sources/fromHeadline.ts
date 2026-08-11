import {
    resolveAgentActivityEntryAgentHandle,
    type SessionAgentActivityEntryV1,
    type SessionAgentActivityHeadlineV1,
} from '@happier-dev/protocol';

import { toAgentActivityEntryKind, type AgentActivityHeadlineEntry } from '../types';

/**
 * The unified agent-activity headline, read as roster entries.
 *
 * This is the source R-3 rests on: the headline is published into session metadata, so it arrives
 * with the session itself and is complete regardless of how much transcript has paged in. Everything
 * here is a straight projection — no ordering, no bounding, no invention. Ordering already happened
 * at the producer through the shared protocol owner, and re-deciding it here would be the second
 * ordering owner §8.4 forbids.
 *
 * Active entries come before recent ones because that is the order the producer published them in
 * and the merge preserves input order; the section model is what actually decides what a reader
 * sees.
 *
 * No `liveAgentComplement` is projected, and its absence is the honest statement: this headline
 * describes a run's complement by NAMING its agents (`parentId`), where the older count-only
 * headline can only state a number. The counts owner reads whichever of the two the producer gave
 * it, so a run is described the same way on both paths.
 */

function toHeadlineEntry(entry: SessionAgentActivityEntryV1): AgentActivityHeadlineEntry {
    return {
        id: entry.entryId,
        kind: toAgentActivityEntryKind(entry.kind),
        // Resolved through the protocol owner, never parsed locally: the join is only safe while
        // exactly one module knows how an entry id is spelled.
        handle: resolveAgentActivityEntryAgentHandle(entry.entryId),
        status: entry.status,
        title: entry.title,
        startedAtMs: entry.startedAt ?? null,
        updatedAtMs: entry.updatedAt,
        parentId: entry.parentId ?? null,
        runId: entry.runId ?? null,
        sidechainId: entry.sidechainId ?? null,
    };
}

export function deriveHeadlineAgentActivityEntries(
    headline: SessionAgentActivityHeadlineV1 | null | undefined,
): readonly AgentActivityHeadlineEntry[] {
    if (!headline) return [];
    const entries: AgentActivityHeadlineEntry[] = [];
    for (const entry of headline.activeEntries) entries.push(toHeadlineEntry(entry));
    for (const entry of headline.recentEntries ?? []) entries.push(toHeadlineEntry(entry));
    return entries;
}
