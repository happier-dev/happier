import * as React from 'react';

import { useWorkflowRunDetails, type WorkflowRunDetails } from '@/components/sessions/workState/useWorkflowRunDetails';
import {
    useSessionAgentActivityRoster,
    type SessionAgentActivityRow,
    type SessionBackgroundTaskRow,
} from '@/hooks/session/useSessionAgentActivity';
import { useNowMs } from '@/hooks/time/useNowMs';
import { buildAgentActivityEvidenceIndex } from '@/sync/domains/session/agentActivity';
import {
    deriveSessionWorkObservation,
    type SessionWorkObservation,
} from '@/sync/domains/session/attention/deriveSessionWorkObservation';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { useSession } from '@/sync/domains/state/storage';

import { partitionAgentActivityRuns } from '../list/agentActivityRunPartition';
import { resolveAgentActivitySectionId } from '../list/agentActivitySectionModel';

/**
 * Everything an agent-activity surface needs, decided once for every host that draws one.
 *
 * The partition, the run-detail fetch, the folded-work arithmetic and the evidence instants used
 * for the silence notes were each computed independently by the popover and by the Agents pane.
 * They agreed by luck, not by construction — the pane computed a folded count and the popover
 * computed none, the pane fetched run details with one key set and the popover with another. A
 * shared configuration would have documented how not to diverge; deriving it once removes the
 * ability to.
 *
 * `liveOnly` is the ONE genuine difference between the two surfaces and it is a parameter of the
 * partition, not a second filter: the compact surface answers "what is running", the pane also
 * keeps history.
 *
 * The session-level observation (RULING-16) is derived here for the same reason the counts are: it
 * is one fact about one session, and two hosts asking it separately is how they come to hedge
 * differently about the same roster. The model reports it; the surface decides how to say it.
 */

export type AgentActivitySurfaceModel = Readonly<{
    sessionId: string;
    session: ReturnType<typeof useSession>;
    /** Live `workflow_run` entries, each drawn as its own panel. */
    runEntries: readonly SessionAgentActivityRow[];
    /** Everything the list should print: not a panel, and not a member of one. */
    listedEntries: readonly SessionAgentActivityRow[];
    /**
     * How much live work the surface draws OUTSIDE the list.
     *
     * The one tally minus what the list will print (RULING-12). It is what keeps the WORKING
     * heading and the tab badge one number rather than two — and it is what tells the list that
     * "no rows" does not mean "nothing is running", which is the empty-state defect.
     */
    foldedWorkingCount: number;
    runDetails: WorkflowRunDetails;
    /**
     * The freshest evidence instant per entry id, from the unified headline.
     *
     * A run's durable snapshot is refetched on its record revision, which does not advance for a
     * display-only update — so an agent inside a run panel can carry an `updatedAt` older than the
     * headline already knows about, and would be called silent while it was working. The headline
     * entry ids and the snapshot row ids are the same protocol id, so the two join exactly.
     */
    agentEvidenceAtMsById: ReadonlyMap<string, number>;
    /**
     * Whether this session is still observing the work it owns, and if not, since when (RULING-16).
     *
     * A fact about the SESSION, stated once beside the work by whoever draws it. It must never be
     * mapped onto a row's status or its section: a client that has stopped observing a session has
     * learned nothing about the individual agents, and rewriting them would be a durable-looking
     * claim about work nobody watched.
     */
    sessionObservation: SessionWorkObservation;
    /**
     * Whether anything on this surface still claims to be in flight — the one tally (RULING-12).
     *
     * Read by the consumer of `sessionObservation`, because the hedge that observation licenses is
     * about work still SHOWN as running. Nearly every session a reader opens is `unobserved` — that
     * is simply what a session that is not running looks like — so a notice that ignored this would
     * sit permanently above every finished roster in the app.
     */
    hasWorkInFlight: boolean;
    subagents: readonly SessionSubagent[];
    readSubagentForEntry: (entryId: string) => SessionSubagent | null;
    readBackgroundTaskForEntry: (entryId: string) => SessionBackgroundTaskRow | null;
    /** `false` when this surface would draw nothing at all, so a host can decide presence in render. */
    hasContent: boolean;
}>;

/**
 * How often the observation is re-asked, and why it is the staleness cadence.
 *
 * The only answer time alone can change is `observed` -> `unobserved`, at a 120 s freshness budget
 * (`SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS`) — so a 30 s check is at worst 30 s late on a sentence
 * nobody is waiting for. It is the interval the row staleness resolver already subscribes to, and
 * `nowMsClockStore` buckets by interval, so this surface still has exactly one timer.
 */
const SESSION_OBSERVATION_CHECK_INTERVAL_MS = 30_000;

export function useAgentActivitySurfaceModel(params: Readonly<{
    sessionId: string;
    /** Restrict the surface to work in flight. The compact surface does; the pane does not. */
    liveOnly?: boolean;
}>): AgentActivitySurfaceModel {
    const { liveOnly, sessionId } = params;
    const session = useSession(sessionId);
    const activity = useSessionAgentActivityRoster({ sessionId });
    const { counts, entries } = activity;

    const { listedEntries, runEntries } = React.useMemo(
        () => partitionAgentActivityRuns(entries, { liveOnly: liveOnly === true }),
        [entries, liveOnly],
    );

    const foldedWorkingCount = React.useMemo(() => {
        let printed = 0;
        for (const entry of listedEntries) {
            if (resolveAgentActivitySectionId(entry.status) === 'working') printed += 1;
        }
        return Math.max(0, counts.live - printed);
    }, [counts.live, listedEntries]);

    const runIds = React.useMemo(
        () => runEntries.map((entry) => entry.runId ?? entry.id),
        [runEntries],
    );
    const runDetails = useWorkflowRunDetails({
        sessionId,
        metadata: session?.metadata,
        runIds,
    });

    // The shared owner of "freshest instant per entry id", not a fourth private index: the run
    // panel, the transcript workflow card and this surface all join the durable record against the
    // headline, and a second spelling of that join is how one screen calls an agent silent while
    // another shows it working.
    const agentEvidenceAtMsById = React.useMemo(
        () => buildAgentActivityEvidenceIndex(entries),
        [entries],
    );

    const observationNowMs = useNowMs(SESSION_OBSERVATION_CHECK_INTERVAL_MS);
    const sessionObservation = React.useMemo(
        () => deriveSessionWorkObservation(session ?? {}, observationNowMs),
        [observationNowMs, session],
    );

    return React.useMemo(() => ({
        sessionId,
        session,
        runEntries,
        listedEntries,
        foldedWorkingCount,
        runDetails,
        agentEvidenceAtMsById,
        sessionObservation,
        hasWorkInFlight: counts.live > 0,
        subagents: activity.subagents,
        readSubagentForEntry: activity.readSubagentForEntry,
        readBackgroundTaskForEntry: activity.readBackgroundTaskForEntry,
        hasContent: runEntries.length > 0 || listedEntries.length > 0,
    }), [
        activity.readBackgroundTaskForEntry,
        activity.readSubagentForEntry,
        activity.subagents,
        agentEvidenceAtMsById,
        counts.live,
        foldedWorkingCount,
        listedEntries,
        runDetails,
        runEntries,
        session,
        sessionId,
        sessionObservation,
    ]);
}
