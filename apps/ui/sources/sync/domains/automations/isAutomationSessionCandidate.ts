import { evaluateExistingSessionAutomationEligibility } from '@happier-dev/agents';

import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export type AutomationSessionCandidate = Readonly<{
    metadata?: unknown;
    metadataLayoutVersion?: number;
    ownerMetadataView?: unknown;
    accessLevel?: unknown;
    metadataUnavailable?: boolean;
}>;

/**
 * Canonical UI admission predicate for every Session offered to Automation.
 * Visibility is deliberately generic: hidden system Sessions never acquire a
 * Voice-specific exception, and the Agent policy remains the execution truth.
 */
export function isAutomationSessionCandidate(
    session: AutomationSessionCandidate,
    accountSettings?: Record<string, unknown> | null,
): boolean {
    if (!isUserFacingSession(session)) return false;
    return evaluateExistingSessionAutomationEligibility({
        metadata: readSessionOwnerMetadataView({
            metadataLayoutVersion: session.metadataLayoutVersion,
            metadata: session.metadata ?? null,
            ownerMetadataView: session.ownerMetadataView,
        }),
        accountSettings: accountSettings ?? null,
    }).eligible;
}
