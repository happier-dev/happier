/**
 * The freshest instant we have for one unit of agent work — indexed apart from the work itself.
 *
 * **Why it is not a field on the entry.** A unit of work's identity (what it is, what state it is
 * in, what it belongs to) changes rarely; the instant we last saw evidence about it changes on
 * every observation. Carrying the instant on the row makes the row a new object every time
 * anything is observed anywhere, which defeats the per-row memoization the roster depends on and
 * re-renders every surface for a fact none of them is drawing. So evidence is indexed by entry id
 * and read at the point of use, and a fresh observation extends the index without touching a
 * single row.
 *
 * **Why a join exists at all.** Two sources carry an instant for the same unit of work — the
 * published headline and the locally derived transcript row — and either can be the newer one. A
 * durable record's revision does not advance for a display-only update, so the snapshot in hand can
 * be older than the headline already knows about. Taking the LATER of the two is not a preference
 * between disagreeing sources: both are evidence, and the newer one is the one that has not gone
 * stale.
 *
 * It never fabricates an instant. With no evidence at all the answer is `null`, because "we have
 * not looked" is not "nothing happened".
 */

/** Anything that carries an agent-activity entry id and, maybe, an evidence instant. */
export type AgentActivityEvidenceSource = Readonly<{
    id: string;
    updatedAtMs?: number | null;
}>;

export const NO_AGENT_ACTIVITY_EVIDENCE: ReadonlyMap<string, number> = new Map<string, number>();

export function readAgentActivityEvidenceInstant(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Index the freshest evidence instant per entry id, keeping the later of any two observations.
 *
 * Keyed by the protocol entry id (`buildAgentActivityEntryId`), which is the same string a durable
 * snapshot spells for its agent rows, so a record-side instant and a headline-side instant join
 * exactly.
 */
export function buildAgentActivityEvidenceIndex(
    entries: Iterable<AgentActivityEvidenceSource>,
): ReadonlyMap<string, number> {
    const byEntryId = new Map<string, number>();
    for (const entry of entries) {
        const updatedAtMs = readAgentActivityEvidenceInstant(entry.updatedAtMs);
        if (updatedAtMs === null) continue;
        const known = byEntryId.get(entry.id);
        if (known === undefined || updatedAtMs > known) byEntryId.set(entry.id, updatedAtMs);
    }
    return byEntryId;
}

/**
 * The evidence instant for one entry, or `null` when nothing has been observed about it.
 *
 * A host that also holds a durable record for the entry passes its instant, and the later of the
 * two wins — the same rule the index itself applies, expressed once so a second spelling of "later
 * of" cannot appear at a surface.
 */
export function resolveAgentActivityEvidenceAtMs(params: Readonly<{
    entryId: string;
    evidenceAtMsById: ReadonlyMap<string, number>;
    /** The instant carried by a durable record the caller is drawing, when it has one. */
    recordUpdatedAtMs?: number | null;
}>): number | null {
    const fromIndex = readAgentActivityEvidenceInstant(params.evidenceAtMsById.get(params.entryId));
    const fromRecord = readAgentActivityEvidenceInstant(params.recordUpdatedAtMs);
    if (fromIndex === null) return fromRecord;
    if (fromRecord === null) return fromIndex;
    return Math.max(fromIndex, fromRecord);
}
