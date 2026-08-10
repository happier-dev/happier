import type { AgentActivityStatusV1 } from '@happier-dev/protocol';

/**
 * What a row needs to draw one unit of agent work — and nothing else.
 *
 * This is the row's *presentation contract*, deliberately smaller than the sync-domain
 * `AgentActivityEntry` that will feed it: the merge model owns provenance, detail state, sidechain
 * ids and structured results, none of which the row renders. Structural typing means a producer's
 * richer entry is assignable here with no adapter and no second model — the row simply cannot read
 * fields it has no business reading.
 *
 * Two properties are load-bearing and easy to break:
 *
 * 1. **Identity is stability.** An unchanged unit of work must keep the same object identity across
 *    recomputes (INV-4), because `AgentActivityRow` is memoized on it. A producer that rebuilds
 *    entries every tick turns every roster tick into N row renders.
 * 2. **Affordance is data, never a flag.** There is no `showOverflow`, no `readOnly`, no `variant`.
 *    An empty `actions` array means no overflow; an absent `onPress` means a read-only row; a null
 *    `metaDetail` on a normal status means a one-line row. A flag would let a caller ask for an
 *    overflow with nothing in it.
 *
 * Note the absent field: there is no `kind`. `AgentActivityKindV1` ships only the kinds with a
 * proven live writer, and a row does not render kind anyway — requiring one here would push callers
 * to invent a member for subagents and execution runs before their producers exist.
 */
export type AgentActivityRowEntry = Readonly<{
    /** Stable across recomputes; the handle every callback is keyed by. */
    id: string;
    status: AgentActivityStatusV1;
    /** Raw producer title. Blank/whitespace falls back inside `resolveAgentActivityTitle`. */
    title: string;
    /**
     * The single extra fact this row may show, already human-readable and translated by its
     * producer (an activity preview, an error, a provider label). It shares the one meta line with
     * the status word rather than getting a line of its own — a row has at most two lines.
     */
    metaDetail?: string | null;
    /** Start of the work, in epoch ms. Absent means no elapsed time is knowable, so none is shown. */
    startedAtMs?: number | null;
    /**
     * The last moment we have EVIDENCE of this entry doing something, in epoch ms.
     *
     * Not "when the producer last rebuilt the entry", and specifically not
     * `SessionSubagent.timestamps.updatedAtMs`, which for a live sidechain subagent is the
     * launching tool message's `createdAt` and never advances. It feeds the quiet/stale notes
     * (4.10), so an instant that does not move would mark every healthy long-running agent stale.
     *
     * Absent means "we have not looked", and nothing is claimed — never "nothing happened".
     */
    updatedAtMs?: number | null;
    /**
     * Terminal instant, in epoch ms. Its presence is what stops the clock: a finished agent shows a
     * fixed total, and only a live one subscribes to the shared tick.
     */
    endedAtMs?: number | null;
    /**
     * Available actions, in menu order. Must be referentially stable for a stable entry — build it
     * in the derivation, not in the render.
     */
    actions: readonly AgentActivityRowActionId[];
}>;

/**
 * The row action vocabulary (4.4).
 *
 * Ids rather than `{ label, icon }` objects: the row owns the label, glyph, danger styling and
 * confirmation for each action, so a host cannot ship a destructive action without its
 * confirmation, and a translation lives in exactly one place. It also makes the array trivially
 * stable, which memoization depends on.
 *
 * Row press is "open" and is not in this list — an action here is an overflow item.
 *
 * `delete` and `delete_team` are separate because they destroy different things: one teammate
 * versus the whole team it belongs to. Folding them into one id would make the confirmation copy
 * lie about the blast radius, which is the one thing a destructive confirmation exists to state.
 */
export type AgentActivityRowActionId =
    | 'open_full'
    | 'open_advanced'
    | 'send'
    | 'stop'
    | 'delete'
    | 'delete_team';

/** Shared empty action list, so a producer of read-only rows allocates no arrays at all. */
export const AGENT_ACTIVITY_ROW_NO_ACTIONS: readonly AgentActivityRowActionId[] = Object.freeze([]);
