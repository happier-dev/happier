import * as React from 'react';

import { useWorkflowRunDetails, type WorkflowRunDetails } from '@/components/sessions/workState/useWorkflowRunDetails';
import {
    useSessionAgentActivityRoster,
    type SessionAgentActivityRow,
    type SessionBackgroundTaskRow,
} from '@/hooks/session/useSessionAgentActivity';
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
    subagents: readonly SessionSubagent[];
    readSubagentForEntry: (entryId: string) => SessionSubagent | null;
    readBackgroundTaskForEntry: (entryId: string) => SessionBackgroundTaskRow | null;
    /** `false` when this surface would draw nothing at all, so a host can decide presence in render. */
    hasContent: boolean;
}>;

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

    const agentEvidenceAtMsById = React.useMemo(() => {
        const byEntryId = new Map<string, number>();
        for (const entry of entries) {
            const updatedAtMs = entry.updatedAtMs;
            if (typeof updatedAtMs === 'number' && Number.isFinite(updatedAtMs)) {
                byEntryId.set(entry.id, updatedAtMs);
            }
        }
        return byEntryId;
    }, [entries]);

    return React.useMemo(() => ({
        sessionId,
        session,
        runEntries,
        listedEntries,
        foldedWorkingCount,
        runDetails,
        agentEvidenceAtMsById,
        subagents: activity.subagents,
        readSubagentForEntry: activity.readSubagentForEntry,
        readBackgroundTaskForEntry: activity.readBackgroundTaskForEntry,
        hasContent: runEntries.length > 0 || listedEntries.length > 0,
    }), [
        activity.readBackgroundTaskForEntry,
        activity.readSubagentForEntry,
        activity.subagents,
        agentEvidenceAtMsById,
        foldedWorkingCount,
        listedEntries,
        runDetails,
        runEntries,
        session,
        sessionId,
    ]);
}
