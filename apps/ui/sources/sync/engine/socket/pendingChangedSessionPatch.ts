import type { Session } from '@/sync/domains/state/storageTypes';

export type PendingChangedSessionPatch = Pick<Session, 'pendingCount' | 'pendingVersion'>
    & Pick<Partial<Session>, 'pendingBlockedCount' | 'meaningfulActivityAt' | 'pendingActivationAuthorization'>;

export function buildPendingChangedSessionPatch(body: Readonly<{
    pendingCount: number;
    pendingVersion: number;
    pendingBlockedCount?: number;
    meaningfulActivityAt?: number;
    pendingActivationAuthorization?: Session['pendingActivationAuthorization'];
}>): PendingChangedSessionPatch {
    return {
        pendingCount: body.pendingCount,
        pendingVersion: body.pendingVersion,
        ...(typeof body.pendingBlockedCount === 'number' && Number.isFinite(body.pendingBlockedCount)
            ? { pendingBlockedCount: Math.max(0, Math.trunc(body.pendingBlockedCount)) }
            : {}),
        ...(typeof body.meaningfulActivityAt === 'number' && Number.isFinite(body.meaningfulActivityAt)
            ? { meaningfulActivityAt: body.meaningfulActivityAt }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'pendingActivationAuthorization')
            ? { pendingActivationAuthorization: body.pendingActivationAuthorization ?? null }
            : {}),
    };
}
