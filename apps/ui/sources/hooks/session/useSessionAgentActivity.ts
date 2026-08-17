import * as React from 'react';

import {
    readSessionAgentActivityHeadlineFromMetadata,
    type SessionAgentActivityHeadlineV1,
} from '@happier-dev/protocol';

import type { UseExternalSessionRuntimeResult } from '@/components/sessions/model/useExternalSessionRuntime';
import {
    EMPTY_AGENT_ACTIVITY_COUNTS,
    NO_AGENT_ACTIVITY_EVIDENCE,
    deriveAgentActivityCounts,
    deriveAgentActivityEntries,
    sortAgentActivityEntries,
    toAgentActivityCountable,
    toLocalAgentActivityEntry,
    type AgentActivityCounts,
    type AgentActivityEntry,
    type AgentActivityMergeDiagnostics,
} from '@/sync/domains/session/agentActivity';
import { deriveSessionSubagentHasPendingPermission } from '@/sync/domains/session/subagents/deriveSessionSubagentHasPendingPermission';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    useSession,
    useSessionMessages,
    useSessionMessagesReducerState,
    useSessionSubagentSourceMessages,
} from '@/sync/domains/state/storage';

import { useReconciledStableRows } from './reconcileStableRows';
import { useSessionSubagents } from './useSessionSubagents';

/**
 * A session's agent work, as every surface reads it — in two widths over ONE model.
 *
 * It joins the two things that know about agent work, neither of which knows everything: the
 * headline published into session metadata (complete on a cold open, however little transcript has
 * paged in) and the locally derived roster (the only source with detail, and the only source at all
 * for an agent whose backend publishes no headline).
 *
 * **The two widths are not an optimisation.** `useSessionAgentActivity` subscribes to the narrow
 * subagent-source projection and nothing else, so a host that only needs a number — the session
 * header, a session-list row, a composer badge — never re-renders on a streamed token.
 * `useSessionAgentActivityRoster` adds the full transcript, which a rendered roster already pays for
 * and which the pending-permission observation requires. Shipping only the wide one silently
 * re-subscribes every count-shaped surface to the transcript.
 *
 * Both widths derive the roster from the SAME narrow projection, and everything downstream of the
 * enrichment — the merge, the entry model, the counts, the evidence index, the referential
 * stability — is shared, so the two cannot disagree about what exists.
 */

export type SessionAgentActivityEnrichment = Readonly<{
    /**
     * Subagent ids with a permission prompt on screen right now, or `null` when this host did not
     * buy the transcript needed to know.
     *
     * `null` is not "none": it is "not observed", and the difference matters because a prompt is
     * the one fact that escalates a row to `waiting`.
     */
    pendingPermissionIds: ReadonlySet<string> | null;
}>;

/**
 * The explicit "this host bought no transcript detail" value.
 *
 * Named rather than left implicit so a narrow call site states its choice out loud, and so an
 * enrichment field added later cannot silently make the narrow path start paying for it.
 */
export const NO_SESSION_AGENT_ACTIVITY_ENRICHMENT: SessionAgentActivityEnrichment = Object.freeze({
    pendingPermissionIds: null,
});

export type SessionAgentActivityState = Readonly<{
    /**
     * Every merged unit of agent work, boxes included, live first then freshest.
     *
     * This is the ONE list. A host that wants only the live half filters it; a host that wants a
     * number reads `counts`. Neither gets a pre-filtered second roster from here, because two
     * roster-shaped fields on one state object is how a reader ends up asking the wrong one what
     * exists.
     */
    entries: readonly AgentActivityEntry[];
    counts: AgentActivityCounts;
    /**
     * Freshest evidence per entry id, memoized apart from the rows so an observation can advance
     * without giving any row a new identity.
     */
    evidenceAtMsById: ReadonlyMap<string, number>;
    diagnostics: AgentActivityMergeDiagnostics;
    /** The locally derived roster, for hosts that render the subagent behind a row. */
    subagents: readonly SessionSubagent[];
    participantTargets: ReturnType<typeof useSessionSubagents>['participantTargets'];
    /** The subagent behind an entry id, or `null` for a headline-only entry. */
    readSubagentForEntry: (entryId: string) => SessionSubagent | null;
}>;

const EMPTY_ENTRIES: readonly AgentActivityEntry[] = Object.freeze([]);

function readEntryKey(entry: AgentActivityEntry): string {
    return entry.id;
}

export type SessionAgentActivityParams = Readonly<{
    sessionId: string;
    /**
     * The session, when the host already holds it. Omitted, it is read from the store — but a host
     * that has one passes it so both derivations see the same object.
     */
    session?: Session | null;
    /**
     * Forwarded to `useSessionSubagents`, which uses it only to decide whether execution runs are
     * CONTROLLABLE. A host that already has one passes it rather than letting a second runtime
     * subscription attach per session.
     */
    externalSessionRuntime?: UseExternalSessionRuntimeResult;
}>;

/**
 * The narrow width: the subagent-source projection plus the headline. No transcript subscription.
 */
export function useSessionAgentActivity(params: SessionAgentActivityParams): SessionAgentActivityState {
    const storeSession = useSession(params.sessionId);
    const session = params.session !== undefined ? params.session : storeSession;
    const messages = useSessionSubagentSourceMessages(params.sessionId);
    const roster = useSessionSubagents({
        sessionId: params.sessionId,
        session,
        messages,
        ...(params.externalSessionRuntime ? { externalSessionRuntime: params.externalSessionRuntime } : {}),
    });

    return useMergedSessionAgentActivity({
        session,
        roster,
        enrichment: NO_SESSION_AGENT_ACTIVITY_ENRICHMENT,
    });
}

/**
 * The enriched width: the same model, plus the transcript facts a rendered roster shows.
 *
 * Today that is the pending-permission observation, which is the only way a row can reach `waiting`
 * — the publisher cannot see a prompt, so this width is where the escalation becomes possible at
 * all.
 */
export function useSessionAgentActivityRoster(
    params: SessionAgentActivityParams,
): SessionAgentActivityState {
    const storeSession = useSession(params.sessionId);
    const session = params.session !== undefined ? params.session : storeSession;
    const messages = useSessionSubagentSourceMessages(params.sessionId);
    const roster = useSessionSubagents({
        sessionId: params.sessionId,
        session,
        messages,
        ...(params.externalSessionRuntime ? { externalSessionRuntime: params.externalSessionRuntime } : {}),
    });
    const enrichment = useSessionAgentActivityTranscriptEnrichment({
        sessionId: params.sessionId,
        subagents: roster.subagents,
    });

    return useMergedSessionAgentActivity({ session, roster, enrichment });
}

/**
 * The transcript half, isolated so exactly one width subscribes to it.
 *
 * Keeping the two store subscriptions inside a hook only the enriched width calls is what makes the
 * cost boundary structural rather than a comment: a narrow host cannot acquire this by accident.
 */
function useSessionAgentActivityTranscriptEnrichment(params: Readonly<{
    sessionId: string;
    subagents: readonly SessionSubagent[];
}>): SessionAgentActivityEnrichment {
    const { messages } = useSessionMessages(params.sessionId);
    const reducerState = useSessionMessagesReducerState(params.sessionId);
    const { subagents } = params;

    return React.useMemo(() => {
        const pendingPermissionIds = new Set<string>();
        for (const subagent of subagents) {
            if (!deriveSessionSubagentHasPendingPermission({ subagent, reducerState, messages })) continue;
            pendingPermissionIds.add(subagent.id);
        }
        return { pendingPermissionIds };
    }, [messages, reducerState, subagents]);
}

function useMergedSessionAgentActivity(params: Readonly<{
    session: Session | null;
    roster: ReturnType<typeof useSessionSubagents>;
    enrichment: SessionAgentActivityEnrichment;
}>): SessionAgentActivityState {
    const { enrichment, session } = params;
    const { participantTargets, subagents } = params.roster;

    const headline = React.useMemo<SessionAgentActivityHeadlineV1 | null>(() => {
        if (!session) return null;
        return readSessionAgentActivityHeadlineFromMetadata(readSessionOwnerMetadataView(session));
    }, [session]);

    const { pendingPermissionIds } = enrichment;
    const merged = React.useMemo(() => {
        const local = subagents.map((subagent) => toLocalAgentActivityEntry({
            subagent,
            hasPendingPermission: pendingPermissionIds?.has(subagent.id) ?? false,
        }));
        return deriveAgentActivityEntries({ headline, local });
    }, [headline, pendingPermissionIds, subagents]);

    const derivedEntries = React.useMemo(
        () => sortAgentActivityEntries(merged.entries, merged.evidenceAtMsById),
        [merged.entries, merged.evidenceAtMsById],
    );
    // Applied once for the whole model: an unchanged unit of work gets its previous object back,
    // which is what makes `React.memo` on a row real — and what keeps a fresh evidence instant, an
    // unrelated streamed token or a reorder from re-creating rows nothing happened to.
    const entries = useReconciledStableRows(derivedEntries, readEntryKey);

    const counts = React.useMemo(
        () => (entries.length === 0
            ? EMPTY_AGENT_ACTIVITY_COUNTS
            : deriveAgentActivityCounts(entries.map(toAgentActivityCountable))),
        [entries],
    );

    const subagentById = React.useMemo(() => {
        const bySubagentId = new Map<string, SessionSubagent>();
        for (const subagent of subagents) bySubagentId.set(subagent.id, subagent);
        return bySubagentId;
    }, [subagents]);

    const subagentIdByEntryId = React.useMemo(() => {
        const byEntryId = new Map<string, string>();
        for (const entry of entries) {
            if (entry.subagentId) byEntryId.set(entry.id, entry.subagentId);
        }
        return byEntryId;
    }, [entries]);

    // Read through a ref so the resolver keeps ONE identity for the life of the host: a callback
    // that changed with the roster would re-render every memoized row whenever any one agent moved.
    const lookupRef = React.useRef<{
        subagentIdByEntryId: ReadonlyMap<string, string>;
        subagentById: ReadonlyMap<string, SessionSubagent>;
    }>({ subagentIdByEntryId, subagentById });
    lookupRef.current = { subagentIdByEntryId, subagentById };
    const readSubagentForEntry = React.useCallback((entryId: string): SessionSubagent | null => {
        const lookup = lookupRef.current;
        // Fall back to the raw id so a caller holding a local id (a route, a details tab) resolves
        // too — a merged entry is keyed by the headline's id, which that caller never saw.
        return lookup.subagentById.get(lookup.subagentIdByEntryId.get(entryId) ?? entryId) ?? null;
    }, []);

    const evidenceAtMsById = merged.evidenceAtMsById.size === 0
        ? NO_AGENT_ACTIVITY_EVIDENCE
        : merged.evidenceAtMsById;

    return React.useMemo(() => ({
        entries: entries.length === 0 ? EMPTY_ENTRIES : entries,
        counts,
        evidenceAtMsById,
        diagnostics: merged.diagnostics,
        subagents,
        participantTargets,
        readSubagentForEntry,
    }), [
        counts,
        entries,
        evidenceAtMsById,
        merged.diagnostics,
        participantTargets,
        readSubagentForEntry,
        subagents,
    ]);
}
