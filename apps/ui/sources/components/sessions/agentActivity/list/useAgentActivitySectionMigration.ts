import * as React from 'react';

import type { AgentActivityRowEntry } from '../agentActivityRowEntry';
import { resolveAgentActivitySectionId, type AgentActivitySectionId } from './agentActivitySectionModel';
import type { ListMotionQuiet } from './listMotionQuiet';

/**
 * When a row is allowed to change section — the timing half of the migration choreography.
 *
 * The list itself is pure: hand it entries and it partitions them. This hook sits in front of that
 * and answers a different question — *not yet* — by reporting, for each entry whose section has
 * changed, the section it should still be drawn in. Keeping it here rather than in the section
 * model matters: the model stays a total function of its input, and the timing has one owner that
 * a test can drive with a clock.
 *
 * Three rules, in the order they bite:
 *
 * 1. **A finished agent dwells where it finished.** For `AGENT_ACTIVITY_MIGRATION_DWELL_MS` it
 *    stays in the section the reader was watching, settling its status mark in place. Work that is
 *    over can afford to wait; a row that jumps the instant it completes takes the reader's place
 *    away from them for information they already got from the glyph.
 * 2. **Ready migrations travel together.** The commit waits for every pending migration to become
 *    ready, up to `AGENT_ACTIVITY_MIGRATION_BATCH_CEILING_MS` past the first one. Six agents
 *    finishing within a second of each other therefore cost ONE reflow, and a roster that keeps
 *    completing cannot starve — the ceiling forces a commit.
 * 3. **Nothing moves under a finger.** A commit that comes due while the list is being scrolled or
 *    hovered is held until the quiet window says the list is still again.
 *
 * An escalation is deliberately exempt from rule 1: a row entering `NEEDS YOU` is the one case
 * where the person is the thing being waited on, so it is ready at once and only rules 2 and 3
 * apply.
 *
 * **`Date.now()` and `setTimeout` here are not a second clock.** The shared `useNowMs` store exists
 * so that many rows displaying elapsed time share one tick, and its finest bucket is a second —
 * coarser than either constant below, and rounded to boundaries this schedule must not inherit.
 * This is a one-shot scheduler for a transition, reads no time into any rendered value, and adds
 * no recurring timer: at most one timeout is armed, only while a migration is actually pending.
 */

/** How long a terminal row stays in the section the reader watched it finish in. */
export const AGENT_ACTIVITY_MIGRATION_DWELL_MS = 900;

/** The longest a ready migration waits for stragglers before the batch commits without them. */
export const AGENT_ACTIVITY_MIGRATION_BATCH_CEILING_MS = 1200;

type PendingMigration = Readonly<{ target: AgentActivitySectionId; readyAt: number }>;

type MigrationState = {
    /** The section each known entry is currently DRAWN in. */
    drawn: Map<string, AgentActivitySectionId>;
    /** Entries whose real section differs from the drawn one, with the instant they may move. */
    pending: Map<string, PendingMigration>;
    /** Bumped whenever `pending` changes, so the scheduling effect re-runs exactly when it must. */
    revision: number;
    /** Last returned override map, reused while unchanged so the section model can be memoized. */
    held: ReadonlyMap<string, AgentActivitySectionId> | undefined;
};

function createMigrationState(): MigrationState {
    return { drawn: new Map(), pending: new Map(), revision: 0, held: undefined };
}

function sameHeld(
    left: ReadonlyMap<string, AgentActivitySectionId> | undefined,
    right: ReadonlyMap<string, AgentActivitySectionId> | undefined,
): boolean {
    if (left === right) return true;
    if (left == null || right == null || left.size !== right.size) return false;
    for (const [id, section] of left) {
        if (right.get(id) !== section) return false;
    }
    return true;
}

/**
 * Bring the bookkeeping up to date with the entries this render was given.
 *
 * Runs during render on purpose. Establishing the hold in an effect would mean one committed frame
 * in the NEW section before the hold applied — a visible jump, which is the whole thing this
 * choreography exists to remove. It is idempotent: re-running it for the same entries changes
 * nothing, so a double-invoked or discarded render costs at most a dwell.
 */
function reconcileMigrations(
    state: MigrationState,
    entries: readonly AgentActivityRowEntry[],
    now: number,
): void {
    const present = new Set<string>();
    let held: Map<string, AgentActivitySectionId> | undefined;

    for (const entry of entries) {
        present.add(entry.id);
        const target = resolveAgentActivitySectionId(entry.status);
        const drawn = state.drawn.get(entry.id);

        // A row nobody has seen yet has nowhere to travel from: it adopts its real section at once.
        if (drawn === undefined) {
            state.drawn.set(entry.id, target);
            if (state.pending.delete(entry.id)) state.revision += 1;
            continue;
        }

        if (drawn === target) {
            if (state.pending.delete(entry.id)) state.revision += 1;
            continue;
        }

        const pending = state.pending.get(entry.id);
        if (pending === undefined || pending.target !== target) {
            state.pending.set(entry.id, {
                target,
                readyAt: now + (target === 'finished' ? AGENT_ACTIVITY_MIGRATION_DWELL_MS : 0),
            });
            state.revision += 1;
        }
        (held ??= new Map()).set(entry.id, drawn);
    }

    for (const id of [...state.drawn.keys()]) {
        if (!present.has(id)) state.drawn.delete(id);
    }
    for (const id of [...state.pending.keys()]) {
        if (!present.has(id) && state.pending.delete(id)) state.revision += 1;
    }

    if (!sameHeld(held, state.held)) state.held = held;
}

/** When the current batch is due: every migration ready, or the ceiling past the first one. */
function resolveBatchCommitAt(pending: ReadonlyMap<string, PendingMigration>): number | null {
    let earliest = Number.POSITIVE_INFINITY;
    let latest = Number.NEGATIVE_INFINITY;
    for (const migration of pending.values()) {
        if (migration.readyAt < earliest) earliest = migration.readyAt;
        if (migration.readyAt > latest) latest = migration.readyAt;
    }
    if (earliest === Number.POSITIVE_INFINITY) return null;
    return Math.min(latest, earliest + AGENT_ACTIVITY_MIGRATION_BATCH_CEILING_MS);
}

/** Moves every migration whose dwell is up. Returns whether anything moved. */
function applyReadyMigrations(state: MigrationState, now: number): boolean {
    let moved = false;
    for (const [id, migration] of [...state.pending]) {
        if (migration.readyAt > now) continue;
        state.drawn.set(id, migration.target);
        state.pending.delete(id);
        moved = true;
    }
    if (moved) state.revision += 1;
    return moved;
}

export function useAgentActivitySectionMigration(params: Readonly<{
    entries: readonly AgentActivityRowEntry[];
    quiet: ListMotionQuiet;
}>): ReadonlyMap<string, AgentActivitySectionId> | undefined {
    const { entries, quiet } = params;

    const stateRef = React.useRef<MigrationState | null>(null);
    stateRef.current ??= createMigrationState();
    const state = stateRef.current;

    const [, commit] = React.useReducer((count: number) => count + 1, 0);

    reconcileMigrations(state, entries, Date.now());
    const revision = state.revision;

    React.useEffect(() => {
        if (state.pending.size === 0) return;

        let timer: ReturnType<typeof setTimeout> | null = null;
        let unsubscribe: (() => void) | null = null;
        let cancelled = false;

        const attempt = (): void => {
            if (cancelled) return;
            const commitAt = resolveBatchCommitAt(state.pending);
            if (commitAt === null) return;

            const now = Date.now();
            if (now < commitAt) {
                timer = setTimeout(attempt, commitAt - now);
                return;
            }
            if (!quiet.isQuiet()) {
                // Nothing will re-render while a finger is down, so the quiet window is the only
                // thing that can release this.
                unsubscribe = quiet.subscribe(() => {
                    unsubscribe?.();
                    unsubscribe = null;
                    attempt();
                });
                return;
            }
            if (applyReadyMigrations(state, now)) commit();
        };

        attempt();
        return () => {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
            unsubscribe?.();
        };
    }, [commit, quiet, revision, state]);

    return state.held;
}
