import type { Session } from '@/sync/domains/state/storageTypes';

export type SessionTupleApplyCurrentness = Readonly<{
    metadataCurrent: boolean;
    agentStateCurrent: boolean;
    fullyCurrent: boolean;
}>;

type SessionTupleOrderingFields = Pick<
    Session,
    'accessLevel' | 'agentStateVersion' | 'metadataLayoutVersion' | 'metadataVersion'
>;

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
        return {
            metadataCurrent: true,
            agentStateCurrent: true,
            fullyCurrent: true,
        };
    }

    const previousLayoutVersion = normalizeOrderingNumber(previousSession.metadataLayoutVersion) ?? 0;
    const incomingLayoutVersion = normalizeOrderingNumber(incomingSession.metadataLayoutVersion) ?? 0;
    const isParticipantProjection =
        incomingSession.accessLevel === 'view'
        || incomingSession.accessLevel === 'edit'
        || incomingSession.accessLevel === 'admin';
    const isAuthoritativeParticipantPrivacyContraction =
        previousLayoutVersion === 0
        && incomingLayoutVersion === 1
        && isParticipantProjection;
    const metadataCurrent =
        isAuthoritativeParticipantPrivacyContraction
        || (
            incomingLayoutVersion >= previousLayoutVersion
            && isIncomingRevisionCurrent(incomingSession.metadataVersion, previousSession.metadataVersion)
        );
    const agentStateCurrent =
        isAuthoritativeParticipantPrivacyContraction
        || isIncomingRevisionCurrent(
            incomingSession.agentStateVersion,
            previousSession.agentStateVersion,
        );

    return {
        metadataCurrent,
        agentStateCurrent,
        fullyCurrent: metadataCurrent && agentStateCurrent,
    };
}
