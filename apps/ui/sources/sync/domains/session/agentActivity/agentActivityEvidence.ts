import type { SessionAgentActivityHeadlineV1 } from '@happier-dev/protocol';

import { deriveHeadlineAgentActivityEntries } from './sources/fromHeadline';

/**
 * The freshest instant we have for one unit of agent work, joined across the sources that hold one.
 *
 * **Why a join exists at all.** A workflow run's durable `activity/workflow_run.v1` record is
 * refetched on its record revision, and the revision does not advance for a display-only update. So
 * the snapshot in hand can be older than the published headline already knows about, and an agent
 * that is working would be called silent by the silence rule. Taking the LATER of the two is not a
 * preference between disagreeing sources — both are evidence, and the newer one is the one that has
 * not gone stale.
 *
 * **Why it lives here.** Three surfaces need it (the run panel, the transcript workflow card, and
 * the shared activity surface that supplies the map). A second spelling of "later of" is how one
 * screen ends up saying "no update for over 10 min" about the same agent another screen shows as
 * fresh — which is exactly the defect this module was extracted to close.
 *
 * Never fabricates an instant: with no evidence at all the answer is `null`, because "we have not
 * looked" is not "nothing happened" (PLAN 4.10).
 */

/** Anything that carries an agent-activity entry id and, maybe, an evidence instant. */
export type AgentActivityEvidenceSource = Readonly<{
    id: string;
    updatedAtMs?: number | null;
}>;

const NO_AGENT_ACTIVITY_EVIDENCE: ReadonlyMap<string, number> = new Map();

function readEvidenceAtMs(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Index the freshest evidence instant per entry id.
 *
 * Keyed by the protocol entry id, which is the same string a durable workflow snapshot spells for
 * its agent rows (`buildAgentActivityEntryId`), so the two join exactly.
 */
export function buildAgentActivityEvidenceIndex(
    entries: Iterable<AgentActivityEvidenceSource>,
): ReadonlyMap<string, number> {
    const byEntryId = new Map<string, number>();
    for (const entry of entries) {
        const updatedAtMs = readEvidenceAtMs(entry.updatedAtMs);
        if (updatedAtMs === null) continue;
        const known = byEntryId.get(entry.id);
        if (known === undefined || updatedAtMs > known) byEntryId.set(entry.id, updatedAtMs);
    }
    return byEntryId;
}

/**
 * The same index, read straight from the unified headline in session metadata.
 *
 * For a host that has no roster subscription — the transcript workflow card holds a tool call and
 * the session's metadata, nothing else. It goes through the canonical headline adapter rather than
 * reading `entryId`/`updatedAt` itself, so the id spelling still has exactly one owner.
 */
export function readAgentActivityEvidenceIndexFromHeadline(
    headline: SessionAgentActivityHeadlineV1 | null | undefined,
): ReadonlyMap<string, number> {
    if (!headline) return NO_AGENT_ACTIVITY_EVIDENCE;
    return buildAgentActivityEvidenceIndex(deriveHeadlineAgentActivityEntries(headline));
}

/**
 * The later of the durable instant and the headline instant for one row, or `null` for neither.
 */
export function resolveAgentActivityEvidenceAtMs(params: Readonly<{
    entryId: string;
    /** The instant carried by the durable record the surface is drawing. */
    recordUpdatedAtMs?: number | null;
    /** The freshest headline evidence per entry id, when the host has one. */
    evidenceAtMsById?: ReadonlyMap<string, number> | undefined;
}>): number | null {
    const fromHeadline = readEvidenceAtMs(params.evidenceAtMsById?.get(params.entryId));
    const fromRecord = readEvidenceAtMs(params.recordUpdatedAtMs);
    if (fromHeadline === null) return fromRecord;
    if (fromRecord === null) return fromHeadline;
    return Math.max(fromHeadline, fromRecord);
}
