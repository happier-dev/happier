import * as React from 'react';

import {
    computeContextPercentUsed,
    type SessionContextUsageSnapshotV1,
} from '@happier-dev/protocol/usage/contextUsage';

import { getAgentCore } from '@/agents/catalog/catalog';
import { buildSessionScmSummary } from '@/components/sessions/sourceControl/status/statusSummary';
import { resolveSessionAgentActivityPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { t } from '@/text';
import { useSessionAgentActivity } from '@/hooks/session/useSessionAgentActivity';
import { EMPTY_SESSION_LIST_SERVER_KEY } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    useOpenApprovalArtifactsForSession,
    useSessionProjectScmSnapshot,
    useSessionUsage,
} from '@/sync/domains/state/storage';

import {
    projectSessionSummaryCard,
    type SessionSummaryCardModel,
    type SessionSummaryUsageFacts,
} from './sessionSummaryProjection';
import { useSessionRecap } from './useSessionRecap';
import { projectSessionAgentPlan } from '../plan/sessionAgentPlan';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { listSessionPendingPermissions, type SessionPendingPermission } from '@/sync/ops/sessionPendingPermissions';
import { listPendingRequestListsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { useOptionalSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import type { SessionPendingRequestLists } from '@happier-dev/session-core/pending';
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
    progress: null,
    plan: null,
    facts: Object.freeze([]),
});

const NO_PENDING_PERMISSIONS: readonly SessionPendingPermission[] = Object.freeze([]);
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

function readAgentLabel(session: Session): string | null {
    const agentId = readSessionPresentationAgentId(session);
    if (!agentId) return null;
    const core = getAgentCore(agentId);
    return core ? t(core.displayNameKey) : null;
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
    const { address, awarenessSource, awareness, turnStartedAtMs } = useSessionSummaryAwareness(input);
    const approvals = useOpenApprovalArtifactsForSession(address);
    const activity = useSessionAgentActivity({
        sessionId: session.id,
        serverId: address?.serverId ?? EMPTY_SESSION_LIST_SERVER_KEY,
        session: address ? session : null,
    });
    const scmSnapshot = useSessionProjectScmSnapshot(
        address?.sessionId ?? null,
        address?.serverId ?? null,
    );
    const usage = useSessionUsage(
        session.id,
        { serverId: address?.serverId ?? EMPTY_SESSION_LIST_SERVER_KEY, session },
    ) as SessionUsageLike;

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
    const recap = useSessionRecap(address);
    const accountScopeResolution = useServerCredentialAccountScopeResolution(address?.serverId);
    const accountScope = accountScopeResolution.kind === 'bound' ? accountScopeResolution.scope : null;
    // Pending asks and the Plan come from the live row: both are exactly the facts
    // the stabilised shell Session omits from its render signature.
    const pendingPermissions = React.useMemo(
        () => (address ? listSessionPendingPermissions(awarenessSource, accountScope, pendingRequests.permissionRequests) : NO_PENDING_PERMISSIONS),
        [accountScope, address, awarenessSource, pendingRequests.permissionRequests],
    );
    const plan = projectSessionAgentPlan(awarenessSource.todos);
    const scm = React.useMemo(() => buildSessionScmSummary(scmSnapshot), [scmSnapshot]);
    const usageFacts = React.useMemo(() => readUsageFacts(usage), [usage]);
    const agentLabel = React.useMemo(() => readAgentLabel(session), [session]);
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
        agentLabel,
        agentId,
        activity: activity.counts.total > 0
            ? { ...activity.counts, headline: activityHeadline }
            : null,
        openApprovalCount: approvals.length,
        scm,
        usage: usageFacts,
        recap,
        pendingPermissions,
        pendingUserActions: pendingRequests.userActionRequests,
        plan,
        turnStartedAtMs,
    });
}
