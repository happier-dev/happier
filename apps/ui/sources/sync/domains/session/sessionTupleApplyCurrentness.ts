import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { SESSION_OWNER_METADATA_PROJECTION } from './readSessionOwnerMetadataView';
import {
    SESSION_LIST_DOCUMENT_ADMISSION, admitOpenedSessionListAgentState,
    areSessionListDocumentAdmissionsEqual, mergeSessionListDocumentObservations,
} from './sessionDocumentAdmission';
import type { CollectionSessionRequestIdentity } from '@/components/ui/lists/collection/collectionRequestRef';

export type SessionTupleApplyCurrentness = Readonly<{
    metadataCurrent: boolean;
    agentStateCurrent: boolean;
    fullyCurrent: boolean;
}>;

type SessionTupleOrderingFields = Partial<Pick<
    Session,
    'agentStateVersion' | 'metadataLayoutVersion' | 'metadataVersion'
>>;

function normalizeOrderingNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : null;
}

function isIncomingRevisionCurrent(incoming: unknown, previous: unknown): boolean {
    const previousRevision = normalizeOrderingNumber(previous);
    if (previousRevision === null) return true;
    const incomingRevision = normalizeOrderingNumber(incoming);
    return incomingRevision !== null && incomingRevision >= previousRevision;
}

/**
 * Canonical admission decision for independently versioned Session tuple
 * fields. Async decryptors may finish out of order, so transport arrival order
 * never owns metadata, owner-view, or Agent-state currentness.
 */
export function classifySessionTupleApplyCurrentness(
    previousSession: SessionTupleOrderingFields | null | undefined,
    incomingSession: SessionTupleOrderingFields,
): SessionTupleApplyCurrentness {
    if (!previousSession) {
        const metadataCurrent =
            readSessionMetadataLayoutVersion(incomingSession.metadataLayoutVersion) >= 0;
        return {
            metadataCurrent,
            agentStateCurrent: true,
            fullyCurrent: metadataCurrent,
        };
    }

    const previousLayoutVersion = readSessionMetadataLayoutVersion(previousSession.metadataLayoutVersion);
    // Partial update-session publications need not assert a layout. Absence
    // preserves the retained layout; only an explicit value can regress it.
    const incomingLayoutVersion = incomingSession.metadataLayoutVersion === undefined
        ? previousLayoutVersion
        : readSessionMetadataLayoutVersion(incomingSession.metadataLayoutVersion);
    const metadataLayoutVersionsValid = previousLayoutVersion >= 0 && incomingLayoutVersion >= 0;
    // Layout-1 socket frames carry no access projection. The layout transition
    // itself is the privacy contraction, including when its tuple versions reset.
    const isAuthoritativePrivacyContraction =
        previousLayoutVersion === 0
        && incomingLayoutVersion === 1;
    const metadataCurrent =
        metadataLayoutVersionsValid
        && (
            isAuthoritativePrivacyContraction
            || (incomingLayoutVersion >= previousLayoutVersion
                && isIncomingRevisionCurrent(incomingSession.metadataVersion, previousSession.metadataVersion))
        );
    const agentStateCurrent =
        metadataLayoutVersionsValid
        && incomingLayoutVersion >= previousLayoutVersion
        && (isAuthoritativePrivacyContraction
            || isIncomingRevisionCurrent(
                incomingSession.agentStateVersion,
                previousSession.agentStateVersion,
            ));

    return {
        metadataCurrent,
        agentStateCurrent,
        fullyCurrent: metadataCurrent && agentStateCurrent,
    };
}

type SessionRequestProjection = SessionTupleOrderingFields & Partial<Pick<Session,
    'agentState' | 'pendingPermissionRequestCount' | 'pendingUserActionRequestCount' | 'pendingRequestObservedAt'
>> & {
    hasPendingPermissionRequests?: boolean;
    hasPendingUserActionRequests?: boolean;
    currentRequestRef?: CollectionSessionRequestIdentity | null;
};

export function shouldPreserveSessionRequestProjection(
    previous: SessionRequestProjection | undefined,
    incoming: SessionRequestProjection,
): boolean {
    if (!previous) return false;
    if (!classifySessionTupleApplyCurrentness(previous, incoming).agentStateCurrent) return true;
    // A newly admitted tuple (including a privacy contraction with reset versions)
    // owns its whole request projection, regardless of the request's creation time.
    if (previous.agentStateVersion !== incoming.agentStateVersion
        || (incoming.metadataLayoutVersion !== undefined
            && readSessionMetadataLayoutVersion(previous.metadataLayoutVersion)
                !== readSessionMetadataLayoutVersion(incoming.metadataLayoutVersion))) return false;
    const previousAt = normalizeOrderingNumber(previous.pendingRequestObservedAt);
    const incomingAt = normalizeOrderingNumber(incoming.pendingRequestObservedAt);
    return previousAt !== null && incomingAt !== null && incomingAt < previousAt;
}

/** Keep request content and its public pending projection on the same accepted tuple. */
export function reconcileSessionRequestProjection<T extends SessionRequestProjection>(
    previous: SessionRequestProjection | undefined,
    incoming: T,
): T {
    if (!previous || !shouldPreserveSessionRequestProjection(previous, incoming)) return incoming;
    let next = incoming;
    const preserve = (key: keyof SessionRequestProjection): void => {
        if ((key in previous || key in next) && next[key] !== previous[key]) {
            next = { ...next, [key]: previous[key] };
        }
    };
    if (!classifySessionTupleApplyCurrentness(previous, incoming).agentStateCurrent) {
        preserve('agentState');
        preserve('agentStateVersion');
    }
    for (const key of [
        'pendingPermissionRequestCount', 'pendingUserActionRequestCount',
        'hasPendingPermissionRequests', 'hasPendingUserActionRequests', 'pendingRequestObservedAt', 'currentRequestRef',
    ] as const) preserve(key);
    return next;
}

/** Tuple-owned facts retain their independent revision/layout admission in enclosing updates. */
export const sessionTupleProjectionFields = [
    'agentState', 'agentStateVersion', 'pendingPermissionRequestCount', 'pendingUserActionRequestCount',
    'pendingRequestObservedAt', 'hasPendingPermissionRequests', 'hasPendingUserActionRequests', 'currentRequestRef',
    'metadataLayoutVersion', 'metadataProjection', 'metadata', 'metadataVersion',
    'ownerMetadataView', SESSION_OWNER_METADATA_PROJECTION, 'composerOptionsInput',
] as const satisfies readonly (keyof SessionTupleProjection)[];

type SessionTupleProjection = SessionRequestProjection & Partial<Pick<Session,
    | 'metadataProjection' | 'ownerMetadataView' | 'composerOptionsInput'
    | typeof SESSION_OWNER_METADATA_PROJECTION | typeof SESSION_LIST_DOCUMENT_ADMISSION
>> & { metadata?: unknown };

/** Merge independently versioned tuple fields before any queue can discard a newer snapshot. */
export function reconcileSessionTupleProjection<T extends SessionTupleProjection>(
    previous: SessionTupleProjection | undefined,
    incoming: T,
): T {
    let next = reconcileSessionRequestProjection(previous, incoming);
    if (!previous) return next;
    const currentness = classifySessionTupleApplyCurrentness(previous, incoming);
    if (!currentness.metadataCurrent) {
        for (const key of [
            'metadataLayoutVersion', 'metadataProjection', 'metadata', 'metadataVersion',
            'ownerMetadataView', SESSION_OWNER_METADATA_PROJECTION, 'composerOptionsInput',
        ] as const) {
            if ((key in previous || key in next) && next[key] !== previous[key]) {
                next = { ...next, [key]: previous[key] };
            }
        }
    }
    const previousAdmission = previous[SESSION_LIST_DOCUMENT_ADMISSION];
    const incomingAdmission = incoming[SESSION_LIST_DOCUMENT_ADMISSION];
    if (previousAdmission && incomingAdmission
        && areSessionListDocumentAdmissionsEqual(previousAdmission, incomingAdmission)) {
        // Custody follows each selected document, independently of the enclosing response.
        let admission = mergeSessionListDocumentObservations(
            currentness.metadataCurrent ? incomingAdmission : previousAdmission,
            currentness.metadataCurrent ? previousAdmission : incomingAdmission,
        );
        const openedAgentStateVersion = (currentness.agentStateCurrent ? incomingAdmission : previousAdmission).openedAgentStateVersion;
        if (admission.openedAgentStateVersion !== openedAgentStateVersion) {
            admission = openedAgentStateVersion === undefined
                ? Object.freeze({ ...admission, openedAgentStateVersion })
                : admitOpenedSessionListAgentState(admission, openedAgentStateVersion);
        }
        if (next[SESSION_LIST_DOCUMENT_ADMISSION] !== admission) {
            next = { ...next, [SESSION_LIST_DOCUMENT_ADMISSION]: admission };
        }
    }
    return next;
}
