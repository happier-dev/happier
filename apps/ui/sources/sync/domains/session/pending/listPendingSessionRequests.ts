import type { Message } from '@happier-dev/session-core/messages';
import { readStoredSessionMessagesFromStateLike } from '@happier-dev/session-core/messages';
import type { AgentState } from '@happier-dev/session-core/state';
import { readAccountNameFromLegacyProfileV1, resolveAccountDisplayLabelV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionFullPublicationUpdatedAt } from '../sessionRuntimeObservation';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { buildStableJsonSignature } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { readSessionPresentationCompletedRequests } from '@/sync/domains/session/presentation/readSessionPresentationCompletedRequests';
import { readSessionRequestCoverage } from './readSessionRequestCoverage';
import {
    canReuseTranscriptRenderableAggregateRequestStates,
    isTranscriptRenderableAggregate,
} from '@/sync/domains/session/listing/transcriptRenderableAggregateReuse';
import {
    derivePendingRequestFlags,
    deriveLatestPendingRequestObservedAt,
    listPendingRequests,
    listPendingRequestLists,
    listPendingPermissionRequests,
    listPendingUserActionRequests,
    listPendingTranscriptRequests as listCorePendingTranscriptRequests,
    shouldReadTranscriptForPendingRequests,
    shouldReadTranscriptForPendingRequestList,
    readSharedMetadataActionConfirmationState,
    collectTranscriptRequestStates,
    type PendingRequestFacts,
    type PendingRequestFlags,
    type SessionPendingRequest,
    type SessionPendingRequestLists,
    type TranscriptRequestState,
    type TranscriptRequestStatesCache,
} from '@happier-dev/session-core/pending';

export { isSessionActionConfirmationRequest } from '@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1';

export {
    collectTranscriptRequestStates,
    mergeTranscriptRequestState,
    derivePendingRequestFlagsFromAgentState,
    deriveLatestPendingAgentStateRequestObservedAt,
    type SessionPendingRequest,
    type SessionPendingRequestLists,
    type TranscriptRequestState,
    type TranscriptRequestStatesCache,
} from '@happier-dev/session-core/pending';

export function readPendingRequestFactsFromSession(session: Omit<Session, 'presence'>): PendingRequestFacts {
    const permissionOwnerLabel = session.ownerProfile ? resolveAccountDisplayLabelV1({
        name: readAccountNameFromLegacyProfileV1(session.ownerProfile), username: session.ownerProfile.username,
    }) : null;
    return {
        sessionId: session.id,
        active: session.active === true,
        agentState: session.agentState ?? null,
        permissionRelationship: session.access?.level === 'owner' ? 'owner' : session.access ? 'sharedApprover' : null,
        ...(permissionOwnerLabel ? { permissionOwnerLabel } : {}),
        requestCoverage: readSessionRequestCoverage(session),
        actionConfirmations: readSharedMetadataActionConfirmationState(session.metadata, session.metadataLayoutVersion),
        presentationCompletedRequests: readSessionPresentationCompletedRequests(session),
        projected: {
            permissionCount: session.pendingPermissionRequestCount ?? null,
            userActionCount: session.pendingUserActionRequestCount ?? null,
            observedAt: readProjectedPendingRequestObservedAt(session),
            referenceAt: Number.isFinite(session.updatedAt) ? Math.trunc(readSessionFullPublicationUpdatedAt(session)) : null,
        },
    };
}

type StoredSessionMessagesForRequestStates = Parameters<typeof readStoredSessionMessagesFromStateLike>[0];

/**
 * Request states of a Session's stored transcript. The messages domain keeps them in the Session's
 * renderable aggregate, updated per changed message on every apply; reading it keeps per-arrival
 * consumers (favicon, attention, observed-at, Session header) O(requests) instead of walking the
 * whole transcript, which grows with the Session. Falls back to one walk when the aggregate is
 * absent or was folded against different completions or coverage. Callers only read the map.
 */
export function readStoredTranscriptRequestStatesCache(
    sessionMessages: StoredSessionMessagesForRequestStates | null | undefined,
    session: Omit<Session, 'presence'>,
): TranscriptRequestStatesCache {
    const completedRequests = readSessionPresentationCompletedRequests(session);
    const requestCoverage = readSessionRequestCoverage(session);
    const aggregate = (sessionMessages as { renderableAggregate?: unknown } | null | undefined)?.renderableAggregate;
    if (
        isTranscriptRenderableAggregate(aggregate)
        && canReuseTranscriptRenderableAggregateRequestStates(aggregate, completedRequests, requestCoverage)
    ) {
        return { states: aggregate.requestStates };
    }
    const states = new Map<string, TranscriptRequestState>();
    collectTranscriptRequestStates(readStoredSessionMessagesFromStateLike(sessionMessages), completedRequests, states, requestCoverage);
    return { states };
}

/** Without caller messages, transcript request states come from the registered Store. */
function readTranscriptRequestStates(
    session: Session,
    messages?: ReadonlyArray<Message>,
    statesCache?: TranscriptRequestStatesCache,
): TranscriptRequestStatesCache | undefined {
    if (messages || statesCache?.states) return statesCache;
    const sessionId = typeof session.id === 'string' ? session.id.trim() : '';
    const { states } = readStoredTranscriptRequestStatesCache(readRegisteredStorageState()?.sessionMessages?.[sessionId], session);
    if (!statesCache) return { states };
    statesCache.states = states;
    return statesCache;
}

export function shouldReadTranscriptForPendingSessionRequests(session: Session): boolean {
    return shouldReadTranscriptForPendingRequests(readPendingRequestFactsFromSession(session));
}

export function listPendingSessionRequests(
    session: Session,
    messages?: ReadonlyArray<Message>,
    statesCache?: TranscriptRequestStatesCache,
): SessionPendingRequest[] {
    const facts = readPendingRequestFactsFromSession(session);
    const readTranscript = shouldReadTranscriptForPendingRequestList(facts);
    return listPendingRequests(facts, messages, readTranscript ? readTranscriptRequestStates(session, messages, statesCache) : statesCache);
}

export function listPendingTranscriptRequests(session: Session, messages?: ReadonlyArray<Message>): SessionPendingRequest[] {
    return listCorePendingTranscriptRequests(readPendingRequestFactsFromSession(session), messages, readTranscriptRequestStates(session, messages));
}

export function listPendingPermissionRequestsFromSession(session: Session, messages?: ReadonlyArray<Message>): SessionPendingRequest[] {
    const facts = readPendingRequestFactsFromSession(session);
    return listPendingPermissionRequests(facts, messages, shouldReadTranscriptForPendingRequestList(facts) ? readTranscriptRequestStates(session, messages) : undefined);
}

export function listPendingUserActionRequestsFromSession(session: Session, messages?: ReadonlyArray<Message>): SessionPendingRequest[] {
    const facts = readPendingRequestFactsFromSession(session);
    return listPendingUserActionRequests(facts, messages, shouldReadTranscriptForPendingRequestList(facts) ? readTranscriptRequestStates(session, messages) : undefined);
}

export function listPendingRequestListsFromSession(session: Session, messages?: ReadonlyArray<Message>): SessionPendingRequestLists {
    const facts = readPendingRequestFactsFromSession(session);
    const readTranscript = shouldReadTranscriptForPendingRequestList(facts);
    return listPendingRequestLists(facts, messages, readTranscript ? readTranscriptRequestStates(session, messages) : undefined);
}

export function derivePendingRequestFlagsFromSession(
    session: Session,
    messages?: ReadonlyArray<Message>,
    statesCache?: TranscriptRequestStatesCache,
): PendingRequestFlags {
    return derivePendingRequestFlags(readPendingRequestFactsFromSession(session), messages, session.active ? readTranscriptRequestStates(session, messages, statesCache) : statesCache);
}

export function deriveLatestPendingRequestObservedAtFromSession(
    session: Session,
    messages?: ReadonlyArray<Message>,
    statesCache?: TranscriptRequestStatesCache,
): number | null {
    return deriveLatestPendingRequestObservedAt(readPendingRequestFactsFromSession(session), messages, session.active ? readTranscriptRequestStates(session, messages, statesCache) : statesCache);
}

function readProjectedPendingRequestObservedAt(session: Session): number | null {
    const value = session.pendingRequestObservedAt;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : null;
}


function buildProjectedPendingRequestCountSignature(value: unknown): string | number {
    if (typeof value !== 'number') return 'absent';
    return Number.isFinite(value) ? Math.trunc(value) : 'nonfinite';
}


export function readPendingAgentStateRequestSignature(agentState: AgentState | null | undefined): string {
    return buildStableJsonSignature(agentState?.requests ?? null);
}


export function readPendingAgentStateCompletedRequestSignature(agentState: AgentState | null | undefined): string {
    return buildStableJsonSignature(agentState?.completedRequests ?? null);
}


export function buildPendingSessionRequestsSourceSignature(session: Session): string {
    const sharedActionState = readSharedMetadataActionConfirmationState(
        session.metadata,
        session.metadataLayoutVersion,
    );
    return buildStableJsonSignature({
        active: session.active === true,
        requestCoverage: readSessionRequestCoverage(session),
        presentationCompletedRequests: readSessionPresentationCompletedRequests(session),
        agentStateRequests: session.agentState?.requests ?? null,
        permissionRelationship: session.access?.level === 'owner' ? 'owner' : session.access ? 'sharedApprover' : null,
        ownerProfile: session.ownerProfile ?? null,
        sharedActionRequests: sharedActionState?.requests ?? null,
        pendingPermissionRequestCount: buildProjectedPendingRequestCountSignature(session.pendingPermissionRequestCount),
        pendingRequestObservedAt: readProjectedPendingRequestObservedAt(session),
        pendingUserActionRequestCount: buildProjectedPendingRequestCountSignature(session.pendingUserActionRequestCount),
        sessionId: session.id,
    });
}
