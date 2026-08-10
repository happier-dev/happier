import type { AgentActivityStatusV1 } from '@happier-dev/protocol';

import { t } from '@/text';

/**
 * How long an entry has been silent, expressed as presentation and nothing else.
 *
 * **Silence is never an outcome.** 4.9.3 is binding for every kind: an entry reaches a terminal
 * status only on explicit evidence, and elapsed time produces presentation changes only. A stale
 * entry keeps its last known non-terminal status — it never becomes `succeeded`, `failed` or
 * `timedOut`. D-1 already shipped one version of that lie (a `timeout` run painted green
 * `succeeded`); inferring completion from a quiet clock would industrialise it across every kind.
 *
 * So this module returns a *freshness note*, and the two things it changes are a word and whether
 * the clock keeps counting. Nothing here touches status, tone-by-status, section membership or the
 * glyph.
 *
 * **No claim without evidence.** `updatedAtMs` is "the last moment we actually saw this entry do
 * something". When it is absent we say nothing: a roster whose sidechains have not been hydrated
 * knows only that it has not looked, and "no update in 10 minutes" would be a statement about our
 * own hydration, not about the agent.
 *
 * **Do not feed this `SessionSubagent.timestamps.updatedAtMs`.** For a live sidechain subagent that
 * field is the launching tool message's `createdAt` and never advances
 * (`deriveSubAgentSidechainSubagents.ts:211-212`), so it equals `startedAtMs` — using it would mark
 * every healthy long-running agent stale at ten minutes. The producer must supply an instant that
 * genuinely moves; the roster uses the newest sidechain message.
 */

/** 4.10 / ruling C7. One pair, one owner, every kind. */
export const AGENT_ACTIVITY_QUIET_AFTER_MS = 90_000;
export const AGENT_ACTIVITY_STALE_AFTER_MS = 600_000;

export type AgentActivityStaleness = 'fresh' | 'quiet' | 'stale';

/**
 * The statuses that *claim ongoing progress*, and therefore the only ones silence can contradict.
 *
 * `queued`, `blocked` and `waiting` are silent by definition — a queued agent has nothing to report
 * and an agent waiting on a person is not failing to update, it is waiting. Noting their silence
 * would be noise, and freezing a `waiting` entry's clock would destroy the one datum that makes a
 * person act: how long it has been waiting for them (4.7).
 */
const PROGRESS_CLAIMING_STATUSES: ReadonlySet<AgentActivityStatusV1> = new Set(['starting', 'running']);

type StalenessInput = Readonly<{
    status: AgentActivityStatusV1;
    /** Last moment we have evidence of activity, epoch ms. Absent means no claim is made. */
    updatedAtMs?: number | null;
    /** Terminal instant. Present means the work is over and silence means nothing. */
    endedAtMs?: number | null;
}>;

function readSilenceStartMs(input: StalenessInput): number | null {
    if (readTimestamp(input.endedAtMs) != null) return null;
    if (!PROGRESS_CLAIMING_STATUSES.has(input.status)) return null;
    return readTimestamp(input.updatedAtMs);
}

export function resolveAgentActivityStaleness(
    params: StalenessInput & Readonly<{ nowMs: number }>,
): AgentActivityStaleness {
    const since = readSilenceStartMs(params);
    if (since == null) return 'fresh';

    const silentForMs = params.nowMs - since;
    if (silentForMs >= AGENT_ACTIVITY_STALE_AFTER_MS) return 'stale';
    if (silentForMs >= AGENT_ACTIVITY_QUIET_AFTER_MS) return 'quiet';
    return 'fresh';
}

/**
 * The instant an entry's elapsed clock stops counting, or `null` when it never does.
 *
 * Derived from the same silence rule rather than from a `staleness` value the caller already
 * resolved, and deliberately so: the clock ticks once a second while the note is recomputed on a
 * much calmer cadence, and a clock that waited for that slower signal would run past the threshold
 * and then jump *backwards* to the frozen value.
 */
export function resolveAgentActivityElapsedFreezeAtMs(params: StalenessInput): number | null {
    const since = readSilenceStartMs(params);
    return since == null ? null : since + AGENT_ACTIVITY_STALE_AFTER_MS;
}

/**
 * The word that carries the state, because colour never carries it alone (R-12).
 *
 * Both strings are observations, never conclusions: "no update" says what we saw, where "stalled"
 * or "not responding" would assert something about the agent that nothing has told us.
 */
export function resolveAgentActivityStalenessNote(staleness: AgentActivityStaleness): string | null {
    if (staleness === 'quiet') return t('session.agentActivity.staleness.quiet');
    if (staleness === 'stale') {
        return t('session.agentActivity.staleness.stale', {
            minutes: Math.round(AGENT_ACTIVITY_STALE_AFTER_MS / 60_000),
        });
    }
    return null;
}

function readTimestamp(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
