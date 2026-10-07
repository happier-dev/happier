import type { Metadata, SessionCreationOutcome } from '@/api/types';

import type { createOnHappySessionWebhook } from '../sessions/onHappySessionWebhook';
import type { TrackedSession } from '../types';

/** The control acknowledgement owns custody and authority, not runner RPC follow-up. */
export function createSessionStartupReadinessHandler(params: Readonly<{
    onHappySessionWebhook: ReturnType<typeof createOnHappySessionWebhook>;
    reconcileCanonicalReadiness(tracked: TrackedSession): Promise<void>;
    reconcileFollowUp(sessionId: string, metadata: Metadata): Promise<void>;
    onFollowUpError(error: unknown, sessionId: string): void;
}>) {
    return async (
        sessionId: string,
        metadata: Metadata,
        _reconcileCanonicalReadiness?: (tracked: TrackedSession) => Promise<void>,
        sessionCreationOutcome?: SessionCreationOutcome,
    ): Promise<void> => {
        await params.onHappySessionWebhook(
            sessionId,
            metadata,
            params.reconcileCanonicalReadiness,
            sessionCreationOutcome,
        );
        // Runner RPC availability is a follow-up fact, not canonical custody.
        // Keep its failure observable without failing accepted readiness or
        // waiting behind unrelated runtime targets in the reconciliation queue.
        void Promise.resolve()
            .then(() => params.reconcileFollowUp(sessionId, metadata))
            .catch((error) => params.onFollowUpError(error, sessionId));
    };
}
