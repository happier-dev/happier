import * as React from 'react';

import {
    computeContextPercentUsed,
    type SessionContextUsageSnapshotV1,
} from '@happier-dev/protocol';

import { getAgentCore } from '@/agents/catalog/catalog';
import { buildSessionScmSummary } from '@/components/sessions/sourceControl/status/statusSummary';
import { resolveSessionAgentActivityPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { t } from '@/text';
import { useSessionListRelativeNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { useSessionAgentActivity } from '@/hooks/session/useSessionAgentActivity';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { EMPTY_SESSION_LIST_SERVER_KEY } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    useOpenApprovalArtifactsForSession,
    useSession,
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

/** The running turn's observed start, the same fact the submit-mode owner reads. */
function readTurnStartedAtMs(session: Session): number | null {
    return session.latestTurnStatus === 'in_progress'
        && typeof session.latestTurnStatusObservedAt === 'number'
        && Number.isFinite(session.latestTurnStatusObservedAt)
        ? session.latestTurnStatusObservedAt
        : null;
}

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
 * Awareness is projected on every render rather than memoized on the Session
 * object: memoizing a `Date.now()` projection by object identity freezes
 * freshness, which would make this card a competing status owner. The projection
 * is a cheap pure function of facts Lane 09A already decided, and this module adds
 * no timer, poll, cache or store of its own.
 */
export function useSessionSummaryModel(input: Readonly<{
    session: Session;
    serverId?: string | null;
}>): SessionSummaryCardModel {
    const { session } = input;
    const candidateAddress = normalizeSessionAddress(input.serverId ?? session.serverId, session.id);
    const address = candidateAddress && (
        !session.serverId
        || areServerProfileIdentifiersEquivalent(candidateAddress.serverId, session.serverId)
    ) ? candidateAddress : null;
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

    // Lane 09 awareness consumers share one subscribed instant. This keeps
    // freshness moving even when the normalized Session object is referentially
    // stable, without adding a Summary-owned timer or clock.
    const awarenessNowMs = useSessionListRelativeNowMs(true);
    // The Session shell hands every child a deliberately stabilised Session whose signature
    // omits `activeAt`, `thinkingAt`, `runtimeActivity*` and `encryptedContentAvailability` —
    // exactly the facts the awareness adapter consumes. Projecting from that object makes the
    // Summary age while heartbeats keep arriving, so this surface subscribes to the live row
    // itself. That is below the memoized shell, so the shell's own subscription locality and
    // its narrow rerender signature are unchanged.
    const liveSession = useSession(address?.sessionId ?? '', address?.serverId ?? null);
    const awarenessSource = liveSession ?? session;
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
    const awareness = React.useMemo(
        () => projectUiSessionAwareness(awarenessSource, awarenessNowMs),
        [awarenessNowMs, awarenessSource],
    );
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
        turnStartedAtMs: readTurnStartedAtMs(awarenessSource),
    });
}
