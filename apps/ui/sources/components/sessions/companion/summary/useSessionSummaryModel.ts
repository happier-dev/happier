import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import * as React from 'react';

import {
    computeContextPercentUsed,
    type SessionContextUsageSnapshotV1,
} from '@happier-dev/protocol/usage/contextUsage';

import { getAgentCore } from '@/agents/catalog/catalog';
import { buildSessionScmSummary } from '@/components/sessions/sourceControl/status/statusSummary';
import { resolveSessionAgentActivityPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { useSessionAgentActivity } from '@/hooks/session/useSessionAgentActivity';
import { EMPTY_SESSION_LIST_SERVER_KEY } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    useOpenApprovalArtifactsForSession,
    useSessionProjectScmSummarySnapshot,
    useSessionUsage,
} from '@/sync/domains/state/storage';

import {
    projectSessionSummaryCard,
    type SessionSummaryCardModel,
    type SessionSummaryUsageFacts,
} from './sessionSummaryProjection';
import { useSessionRecap } from './useSessionRecap';
import { listPendingRequestListsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { useOptionalSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import type { SessionPendingRequestLists } from '@happier-dev/session-core/pending';
import { isTranscriptPendingRequestAnswerable } from '@/utils/sessions/deriveTranscriptInteraction';
import { useSessionSummaryAwareness } from './useSessionSummaryAwareness';

type SessionUsageLike = Readonly<{
    contextSize?: number;
    contextSnapshot?: SessionContextUsageSnapshotV1;
    contextSnapshotStale?: boolean;
}> | null;

const REALM_UNAVAILABLE_SUMMARY: SessionSummaryCardModel = Object.freeze({
    scope: 'realm_unavailable',
    title: null,
    agentLabel: null,
    agentId: null,
    status: null,
    stale: false,
    availability: 'locked',
    encryption: 'unknown',
    identityDestination: 'sessionInfo',
    rows: Object.freeze([]),
    needsYou: null,
    sinceMs: null,
    plan: null,
    facts: Object.freeze([]),
});

const NO_PENDING_REQUESTS: SessionPendingRequestLists = Object.freeze({
    permissionRequests: Object.freeze([]),
    userActionRequests: Object.freeze([]),
});

function readUsageFacts(usage: SessionUsageLike): SessionSummaryUsageFacts | null {
    if (!usage) return null;
    const snapshot = usage.contextSnapshot ?? null;
    const stale = usage.contextSnapshotStale === true;
    const tokens = snapshot?.usedTokens ?? (typeof usage.contextSize === 'number' ? usage.contextSize : null);
    // A stale snapshot keeps its last-known values and is labelled. Computing
    // the ratio from that same snapshot does not claim freshness; dropping it
    // would instead turn known stale context pressure into an unavailable value.
    const contextPercent = snapshot ? computeContextPercentUsed(snapshot) : null;
    if (tokens === null && contextPercent === null) return null;
    return Object.freeze({ tokens, contextPercent, stale });
}

/**
 * The Session's context use, read once from the Session usage owner for every Companion reader (the
 * status block's model and the Usage section): tokens and the context ratio, stale when last-known.
 */
export function useSessionContextUsageFacts(session: Session, serverId: string | null): SessionSummaryUsageFacts | null {
    const usage = useSessionUsage(
        session.id,
        { serverId: serverId ?? EMPTY_SESSION_LIST_SERVER_KEY, session },
    ) as SessionUsageLike;
    return React.useMemo(() => readUsageFacts(usage), [usage]);
}

/** The Session's Agent by name ("Claude", "Codex"); the one label the status block and Usage use. */
export function readSessionAgentLabel(session: Session): string | null {
    const agentId = readSessionPresentationAgentId(session);
    if (!agentId) return null;
    const core = getAgentCore(agentId);
    return core ? formatAgentLikeIdForDisplay(core.id) : null;
}

/**
 * The narrowly subscribed model owner for the first-party Session Summary.
 *
 * High-frequency usage, SCM and approval subscriptions live HERE, below the
 * memoized Session shell, so a usage tick re-renders the summary subtree and not
 * `SessionView` or the composer.
 *
 * Awareness comes from the shared live-Session binding and canonical clock;
 * the stable shell cannot freeze freshness. This model adds no timer, poll,
 * cache or store of its own.
 */
export function useSessionSummaryModel(input: Readonly<{
    session: Session;
    serverId?: string | null;
}>): SessionSummaryCardModel {
    const { session } = input;
    const { address, awarenessSource, awareness, turnStartedAtMs, plan } = useSessionSummaryAwareness(input);
    const approvals = useOpenApprovalArtifactsForSession(address);
    const activity = useSessionAgentActivity({
        sessionId: session.id,
        serverId: address?.serverId ?? EMPTY_SESSION_LIST_SERVER_KEY,
        session: address ? session : null,
    });
    const scmSnapshot = useSessionProjectScmSummarySnapshot(
        address?.sessionId ?? null,
        address?.serverId ?? null,
    );
    const usageFacts = useSessionContextUsageFacts(session, address?.serverId ?? null);

    const transcriptSource = useOptionalSessionTranscriptSource();
    const transcriptPendingRequests = transcriptSource?.usePendingRequests();
    const pendingRequests = React.useMemo(() => {
        if (!address) return NO_PENDING_REQUESTS;
        if (transcriptSource) {
            if (transcriptSource.sessionId !== address.sessionId
                || !transcriptSource.serverId
                || !areServerProfileIdentifiersEquivalent(transcriptSource.serverId, address.serverId)) {
                return NO_PENDING_REQUESTS;
            }
            return transcriptPendingRequests ?? NO_PENDING_REQUESTS;
        }
        // Standalone presentation may use the exact Session row, never ambient
        // transcript storage keyed only by a same-id Session from another Home.
        return listPendingRequestListsFromSession(awarenessSource, []);
    }, [address, awarenessSource, transcriptPendingRequests, transcriptSource]);
    // Only what this viewer can answer now waits for them: the request owner's one verdict,
    // the same the chat tray and the Inbox consume. A Session whose runtime is away holds
    // its asks until it is back, and its freshness line says why.
    const answerableRequests = React.useMemo((): SessionPendingRequestLists => {
        const answerable = (request: SessionPendingRequestLists['permissionRequests'][number]) =>
            isTranscriptPendingRequestAnswerable(awarenessSource, request);
        const permissionRequests = pendingRequests.permissionRequests.filter(answerable);
        const userActionRequests = pendingRequests.userActionRequests.filter(answerable);
        return permissionRequests.length === pendingRequests.permissionRequests.length
            && userActionRequests.length === pendingRequests.userActionRequests.length
            ? pendingRequests
            : Object.freeze({ permissionRequests, userActionRequests });
    }, [awarenessSource, pendingRequests]);
    const recap = useSessionRecap(address);
    const scm = React.useMemo(() => buildSessionScmSummary(scmSnapshot), [scmSnapshot]);
    const agentLabel = React.useMemo(() => readSessionAgentLabel(session), [session]);
    const agentId = React.useMemo(() => readSessionPresentationAgentId(session), [session]);
    const activityHeadline = React.useMemo(() => {
        const entry = activity.entries[0];
        if (!entry) return null;
        const presentation = resolveSessionAgentActivityPresentation({
            entry,
            subagent: activity.readSubagentForEntry(entry.id),
        });
        return Object.freeze({ title: presentation.title, statusLabel: presentation.statusLabel });
    }, [activity]);

    if (!address) return REALM_UNAVAILABLE_SUMMARY;

    return projectSessionSummaryCard({
        awareness,
        viewer: awarenessSource.viewer,
        agentLabel,
        agentId,
        activity: activity.counts.total > 0
            ? { ...activity.counts, headline: activityHeadline }
            : null,
        openApprovalCount: approvals.length,
        scm,
        usage: usageFacts,
        recap,
        pendingPermissions: answerableRequests.permissionRequests,
        pendingUserActions: answerableRequests.userActionRequests,
        plan,
        turnStartedAtMs,
        lastObservedAtMs: awarenessSource.activeAt,
    });
}
