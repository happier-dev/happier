import type { Message } from '@happier-dev/session-core/messages';
import { readStoredSessionMessages } from '@happier-dev/session-core/messages';
import type { AgentState } from '@happier-dev/session-core/state';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { buildStableJsonSignature } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { readSessionPresentationCompletedRequests } from '@/sync/domains/session/presentation/readSessionPresentationCompletedRequests';
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
    type PendingRequestFacts,
    type PendingRequestFlags,
    type SessionPendingRequest,
    type SessionPendingRequestLists,
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

export function readPendingRequestFactsFromSession(session: Session): PendingRequestFacts {
    return {
        sessionId: session.id,
        active: session.active === true,
        agentState: session.agentState ?? null,
        actionConfirmations: readSharedMetadataActionConfirmationState(session.metadata, session.metadataLayoutVersion),
        presentationCompletedRequests: readSessionPresentationCompletedRequests(session),
        projected: {
            permissionCount: session.pendingPermissionRequestCount ?? null,
            userActionCount: session.pendingUserActionRequestCount ?? null,
            observedAt: readProjectedPendingRequestObservedAt(session),
            referenceAt: Number.isFinite(session.updatedAt) ? Math.trunc(session.updatedAt) : null,
        },
    };
}

function readTranscriptMessages(
    session: Session,
    messages?: ReadonlyArray<Message>,
    statesCache?: TranscriptRequestStatesCache,
): ReadonlyArray<Message> | undefined {
    if (messages || statesCache?.states) return messages;
    const storageState = readRegisteredStorageState();
    return storageState ? readStoredSessionMessages(storageState, session.id) ?? [] : [];
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
    return listPendingRequests(facts, readTranscript ? readTranscriptMessages(session, messages, statesCache) : messages, statesCache);
}

export function listPendingTranscriptRequests(session: Session, messages?: ReadonlyArray<Message>): SessionPendingRequest[] {
    return listCorePendingTranscriptRequests(readPendingRequestFactsFromSession(session), readTranscriptMessages(session, messages));
}

export function listPendingPermissionRequestsFromSession(session: Session, messages?: ReadonlyArray<Message>): SessionPendingRequest[] {
    const facts = readPendingRequestFactsFromSession(session);
    return listPendingPermissionRequests(facts, shouldReadTranscriptForPendingRequestList(facts) ? readTranscriptMessages(session, messages) : messages);
}

export function listPendingUserActionRequestsFromSession(session: Session, messages?: ReadonlyArray<Message>): SessionPendingRequest[] {
    const facts = readPendingRequestFactsFromSession(session);
    return listPendingUserActionRequests(facts, shouldReadTranscriptForPendingRequestList(facts) ? readTranscriptMessages(session, messages) : messages);
}

export function listPendingRequestListsFromSession(session: Session, messages?: ReadonlyArray<Message>): SessionPendingRequestLists {
    const facts = readPendingRequestFactsFromSession(session);
    const readTranscript = shouldReadTranscriptForPendingRequestList(facts);
    return listPendingRequestLists(facts, readTranscript ? readTranscriptMessages(session, messages) : messages);
}

export function derivePendingRequestFlagsFromSession(
    session: Session,
    messages?: ReadonlyArray<Message>,
    statesCache?: TranscriptRequestStatesCache,
): PendingRequestFlags {
    return derivePendingRequestFlags(readPendingRequestFactsFromSession(session), session.active ? readTranscriptMessages(session, messages, statesCache) : messages, statesCache);
}

export function deriveLatestPendingRequestObservedAtFromSession(
    session: Session,
    messages?: ReadonlyArray<Message>,
    statesCache?: TranscriptRequestStatesCache,
): number | null {
    return deriveLatestPendingRequestObservedAt(readPendingRequestFactsFromSession(session), session.active ? readTranscriptMessages(session, messages, statesCache) : messages, statesCache);
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
        presentationCompletedRequests: readSessionPresentationCompletedRequests(session),
        agentStateRequests: session.agentState?.requests ?? null,
        sharedActionRequests: sharedActionState?.requests ?? null,
        pendingPermissionRequestCount: buildProjectedPendingRequestCountSignature(session.pendingPermissionRequestCount),
        pendingRequestObservedAt: readProjectedPendingRequestObservedAt(session),
        pendingUserActionRequestCount: buildProjectedPendingRequestCountSignature(session.pendingUserActionRequestCount),
        sessionId: session.id,
    });
}
