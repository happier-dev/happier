import { ParticipantExecutionRunRecipientRoutingIdentityV1Schema } from '@happier-dev/protocol/messages/structured/participantMessageV1';

import type { PendingMessage, Session } from '@/sync/domains/state/storageTypes';

export type PendingChangedSessionPatch = Pick<Session, 'pendingCount' | 'pendingVersion'>
    & Pick<Partial<Session>, 'pendingBlockedCount' | 'meaningfulActivityAt' | 'pendingActivationAuthorization'>;

export function buildPendingChangedSessionPatch(body: Readonly<{
    pendingCount: number;
    pendingVersion: number;
    pendingBlockedCount?: unknown;
    meaningfulActivityAt?: unknown;
    pendingActivationAuthorization?: Session['pendingActivationAuthorization'];
}>): PendingChangedSessionPatch {
    const pendingBlockedCount = typeof body.pendingBlockedCount === 'number' && Number.isFinite(body.pendingBlockedCount)
        ? Math.max(0, Math.trunc(body.pendingBlockedCount))
        : undefined;
    const meaningfulActivityAt = typeof body.meaningfulActivityAt === 'number' && Number.isFinite(body.meaningfulActivityAt)
        ? body.meaningfulActivityAt
        : undefined;
    return {
        pendingCount: body.pendingCount,
        pendingVersion: body.pendingVersion,
        ...(pendingBlockedCount === undefined ? {} : { pendingBlockedCount }),
        ...(meaningfulActivityAt === undefined ? {} : { meaningfulActivityAt }),
        ...(Object.prototype.hasOwnProperty.call(body, 'pendingActivationAuthorization')
            ? { pendingActivationAuthorization: body.pendingActivationAuthorization ?? null }
            : {}),
    };
}

/**
 * The exact Run target a `pending-changed` body speaks for. `pendingCount` above counts the MAIN
 * queue only (server pending state I08), so a targeted mutation publishes the target here and the
 * receipt for that target is its own snapshot refresh — never the main count.
 */
export function readPendingChangedRecipient(
    body: Readonly<{ recipient?: unknown }>,
): NonNullable<PendingMessage['recipient']> | null {
    const parsed = ParticipantExecutionRunRecipientRoutingIdentityV1Schema.safeParse(body.recipient);
    return parsed.success ? { kind: 'execution_run', runId: parsed.data.runId } : null;
}
