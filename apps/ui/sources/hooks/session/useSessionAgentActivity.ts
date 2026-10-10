import { readSessionRuntimeLostSinceMs, readSessionRuntimePresentationFreshnessExpirations, type SessionRuntimePresentationInput } from '@/sync/domains/session/attention/runtimePresentation';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from './sessionListRuntimeClock';
import * as React from 'react';

import {
    readSessionAgentActivityHeadlineFromMetadata,
    type SessionAgentActivityHeadlineV1,
} from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineV1';

import type { UseExternalSessionRuntimeResult } from '@/components/sessions/model/useExternalSessionRuntime';
import {
    EMPTY_AGENT_ACTIVITY_COUNTS,
    NO_AGENT_ACTIVITY_EVIDENCE,
    NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    deriveAgentActivityCounts,
    deriveAgentActivityEntries,
    sortAgentActivityEntries,
    toAgentActivityCountable,
    toLocalAgentActivityEntry,
    type AgentActivityCounts,
    type AgentActivityEntry,
    type AgentActivityMergeDiagnostics,
    type SessionAgentActivityAttentionKind,
} from '@/sync/domains/session/agentActivity';
import { deriveSessionSubagentPendingAttentionKinds } from '@/sync/domains/session/subagents/deriveSessionSubagentPendingAttentionKinds';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Message } from "@happier-dev/session-core/messages";
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import {
    useSession,
    useSessionListRenderableWithServerScope,
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
     * What each subagent is waiting on a person for right now, or `null` when this host did not buy
     * the transcript needed to know.
     *
     * `null` is not "none": it is "not observed", and the difference matters because a prompt is
     * the one fact that escalates a row to `waiting`. A subagent absent from the map has been
     * observed and is waiting on nobody.
     */
    attentionKindsBySubagentId: ReadonlyMap<string, readonly SessionAgentActivityAttentionKind[]> | null;
}>;

/**
 * The explicit "this host bought no transcript detail" value.
 *
 * Named rather than left implicit so a narrow call site states its choice out loud, and so an
 * enrichment field added later cannot silently make the narrow path start paying for it.
 */
export const NO_SESSION_AGENT_ACTIVITY_ENRICHMENT: SessionAgentActivityEnrichment = Object.freeze({
    attentionKindsBySubagentId: null,
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
    /**
     * The entry for an Execution Run id, or `null`.
     *
     * Owned here so a run-addressed surface — Run Details, a conversation's run reference, a route
     * that only knows a run id — reads the same merged row every other surface reads. Callers that
     * scanned `subagents` or built a local index instead could, and did, select a workflow or child
     * entry that merely mentions the same run id.
     */
    readExecutionRunEntry: (runId: string) => AgentActivityEntry | null;
}>;

const EMPTY_ENTRIES: readonly AgentActivityEntry[] = Object.freeze([]);
const EMPTY_MESSAGES = Object.freeze([]) as readonly Message[];

function readEntryKey(entry: AgentActivityEntry): string {
    return entry.id;
}

export type SessionAgentActivityParams = Readonly<{
    sessionId: string;
    /**
     * A mounted cross-Home surface supplies its exact Home.  The legacy
     * Session-id-only callers retain their established active-Home behavior,
     * but a qualified caller must never read another Home's same-id runtime
     * projection from the legacy live-session/message cache.
     */
    serverId?: string;
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

function normalizeServerScopeId(serverId: string | null | undefined): string {
    const raw = typeof serverId === 'string' ? serverId.trim() : '';
    return raw ? resolveServerProfileScopeIdForIdentifier(raw) || raw : '';
}

function readActivitySessionForScope(
    session: Session | null,
    serverId: string | undefined,
): Session | null {
    if (!session || !serverId) return session;

    const expectedServerId = normalizeServerScopeId(serverId);
    if (!expectedServerId) return null;
    const declaredServerId = normalizeServerScopeId(session.serverId);
    if (declaredServerId) return declaredServerId === expectedServerId ? session : null;

    // Released live Session records can predate their explicit serverId field.
    // They are safe only for the currently active Home; an omitted declaration
    // must not let a qualified background/Home-B surface borrow them.
    return normalizeServerScopeId(getActiveServerSnapshot().serverId) === expectedServerId
        ? session
        : null;
}

/**
 * The narrow width: the subagent-source projection plus the headline. No transcript subscription.
 */
export function useSessionAgentActivity(params: SessionAgentActivityParams): SessionAgentActivityState {
    const storeSession = useSession(params.sessionId);
    const serverScopeId = normalizeServerScopeId(params.serverId);
    const scopedRenderable = useSessionListRenderableWithServerScope(serverScopeId || params.serverId, params.sessionId);
    const session = readActivitySessionForScope(
        params.session !== undefined ? params.session : storeSession,
        params.serverId,
    );
    const messages = useSessionSubagentSourceMessages(params.sessionId);
    const roster = useSessionSubagents({
        sessionId: params.sessionId,
        serverId: serverScopeId || params.serverId,
        session,
        messages: session ? messages : EMPTY_MESSAGES,
        ...(params.externalSessionRuntime ? { externalSessionRuntime: params.externalSessionRuntime } : {}),
    });

    return useMergedSessionAgentActivity({
        session,
        runtimeSource: session ?? scopedRenderable,
        headline: session ? undefined : scopedRenderable?.agentActivityHeadline ?? null,
        roster,
        enrichment: NO_SESSION_AGENT_ACTIVITY_ENRICHMENT,
    });
}

/**
 * The enriched width: the same model, plus the transcript facts a rendered roster shows.
 *
 * Today that is the pending-attention observation, which is the only way a row can reach `waiting`
 * — the publisher cannot see a prompt, so this width is where the escalation becomes possible at
 * all, and the only place that can tell an approval apart from a question.
 */
export function useSessionAgentActivityRoster(
    params: SessionAgentActivityParams,
): SessionAgentActivityState {
    const storeSession = useSession(params.sessionId);
    const serverScopeId = normalizeServerScopeId(params.serverId);
    const scopedRenderable = useSessionListRenderableWithServerScope(serverScopeId || params.serverId, params.sessionId);
    const session = readActivitySessionForScope(
        params.session !== undefined ? params.session : storeSession,
        params.serverId,
    );
    const messages = useSessionSubagentSourceMessages(params.sessionId);
    const roster = useSessionSubagents({
        sessionId: params.sessionId,
        serverId: serverScopeId || params.serverId,
        session,
        messages: session ? messages : EMPTY_MESSAGES,
        ...(params.externalSessionRuntime ? { externalSessionRuntime: params.externalSessionRuntime } : {}),
    });
    const enrichment = useSessionAgentActivityTranscriptEnrichment({
        sessionId: params.sessionId,
        subagents: roster.subagents,
    });

    return useMergedSessionAgentActivity({
        session,
        runtimeSource: session ?? scopedRenderable,
        headline: session ? undefined : scopedRenderable?.agentActivityHeadline ?? null,
        roster,
        enrichment,
    });
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
        const attentionKindsBySubagentId = new Map<string, readonly SessionAgentActivityAttentionKind[]>();
        for (const subagent of subagents) {
            const attentionKinds = deriveSessionSubagentPendingAttentionKinds({ subagent, reducerState, messages });
            if (attentionKinds.length === 0) continue;
            attentionKindsBySubagentId.set(subagent.id, attentionKinds);
        }
        return { attentionKindsBySubagentId };
    }, [messages, reducerState, subagents]);
}

function useMergedSessionAgentActivity(params: Readonly<{
    session: Session | null;
    runtimeSource?: SessionRuntimePresentationInput | null;
    /** A Home-qualified concurrent-list headline when the raw live cache is another Home. */
    headline?: SessionAgentActivityHeadlineV1 | null;
    roster: ReturnType<typeof useSessionSubagents>;
    enrichment: SessionAgentActivityEnrichment;
}>): SessionAgentActivityState {
    const { enrichment, session } = params;
    const { participantTargets, subagents } = params.roster;
    const runtimeNowMs = useSessionListRuntimeNowMs(session === null && params.runtimeSource != null);
    const fallbackNowMs = Math.max(runtimeNowMs, Date.now());
    const runtimeLostSinceMs = session !== null ? params.roster.runtimeLostSinceMs
        : params.runtimeSource ? readSessionRuntimeLostSinceMs(params.runtimeSource, fallbackNowMs) : null;
    const expirations = session === null && params.runtimeSource ? readSessionRuntimePresentationFreshnessExpirations(params.runtimeSource, fallbackNowMs) : [];
    useSessionListRuntimeWake(expirations.length > 0 ? Math.min(...expirations) : null);

    const headline = React.useMemo<SessionAgentActivityHeadlineV1 | null>(() => {
        if (params.headline !== undefined) return params.headline;
        if (!session) return null;
        return readSessionAgentActivityHeadlineFromMetadata(readSessionOwnerMetadataView(session));
    }, [params.headline, session]);

    const { attentionKindsBySubagentId } = enrichment;
    const merged = React.useMemo(() => {
        const local = subagents.map((subagent) => toLocalAgentActivityEntry({
            subagent,
            attentionKinds: attentionKindsBySubagentId?.get(subagent.id) ?? NO_SESSION_AGENT_ACTIVITY_ATTENTION,
        }));
        return deriveAgentActivityEntries({ headline, local, runtimeLostSinceMs });
    }, [attentionKindsBySubagentId, headline, subagents, runtimeLostSinceMs]);

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

    const executionRunEntryByRunId = React.useMemo(() => {
        const byRunId = new Map<string, AgentActivityEntry>();
        for (const entry of entries) {
            if (entry.kind !== 'execution_run' || entry.runId === null || byRunId.has(entry.runId)) continue;
            byRunId.set(entry.runId, entry);
        }
        return byRunId;
    }, [entries]);

    // Read through a ref so the resolver keeps ONE identity for the life of the host: a callback
    // that changed with the roster would re-render every memoized row whenever any one agent moved.
    const lookupRef = React.useRef<{
        executionRunEntryByRunId: ReadonlyMap<string, AgentActivityEntry>;
        subagentIdByEntryId: ReadonlyMap<string, string>;
        subagentById: ReadonlyMap<string, SessionSubagent>;
    }>({ executionRunEntryByRunId, subagentIdByEntryId, subagentById });
    lookupRef.current = { executionRunEntryByRunId, subagentIdByEntryId, subagentById };
    const readSubagentForEntry = React.useCallback((entryId: string): SessionSubagent | null => {
        const lookup = lookupRef.current;
        // Fall back to the raw id so a caller holding a local id (a route, a details tab) resolves
        // too — a merged entry is keyed by the headline's id, which that caller never saw.
        return lookup.subagentById.get(lookup.subagentIdByEntryId.get(entryId) ?? entryId) ?? null;
    }, []);
    const readExecutionRunEntry = React.useCallback((runId: string): AgentActivityEntry | null => (
        lookupRef.current.executionRunEntryByRunId.get(runId) ?? null
    ), []);

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
        readExecutionRunEntry,
    }), [
        counts,
        entries,
        evidenceAtMsById,
        merged.diagnostics,
        participantTargets,
        readExecutionRunEntry,
        readSubagentForEntry,
        subagents,
    ]);
}
