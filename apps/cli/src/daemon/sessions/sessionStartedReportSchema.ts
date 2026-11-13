import { z } from 'zod/mini';
import type { Metadata } from '@/api/types';
import { SessionCreationOutcomeSchema } from '@/session/shared/spawnSessionContract';
import { SessionMetadataPublisherPreconditionV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';

// Keep the established report's permissive API metadata bag. Its correlation
// owner validates the process and placement fields it consumes.
export const SessionStartedSuccessReportSchema = z.strictObject({
    sessionId: z.string(),
    metadata: z.custom<Metadata>(),
    sessionCreationOutcome: z.optional(SessionCreationOutcomeSchema),
    /** The tracking key its daemon spawn handed the Session; correlates a Session hosted with others. */
    trackingKey: z.optional(z.string().check(z.minLength(1), z.maxLength(200))),
    persistedTakeoverAdmission: z.optional(z.strictObject({
        mode: z.enum(['persisted', 'external_linked']),
        operationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
        attemptId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
        phase: z.optional(z.enum(['admit', 'runtime_bound'])),
        publisherPrecondition: SessionMetadataPublisherPreconditionV1Schema,
    })),
});
