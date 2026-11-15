import type { Tx } from '@/storage/inTx';
import type { SessionMessagePageActivityV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { PENDING_DELIVERY_BLOCKED_REASONS } from '@happier-dev/protocol/sessions/messages/pendingDeliveryBlockedReason';
import { doesPendingDeliveryOwnTranscriptV1, isPendingDeliveryProviderEffectPossibleV1, normalizePendingDeliveryStatusV1 } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import { parseStoredSessionLatestTurnStatus } from '@/app/session/listing/rows';

/** Activity and page-local crossover witnesses belong to the caller's transcript snapshot. */
export async function readSessionMessagePageActivity(tx: Tx, input: Readonly<{
    sessionId: string;
    includeActivity: boolean;
    messages: readonly Readonly<{ localId: string | null }>[];
}>): Promise<Readonly<{
    activity: SessionMessagePageActivityV1 | undefined;
    pendingOwnsTranscriptLocalIds: ReadonlySet<string>;
}>> {
    const session = input.includeActivity ? await tx.session.findUniqueOrThrow({
        where: { id: input.sessionId },
        select: {
            pendingCount: true,
            pendingBlockedCount: true,
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
            latestTurnStatus: true,
            _count: { select: { pendingMessages: { where: {
                // Prisma may aggregate before joining Session; scope that work to this key too.
                sessionId: input.sessionId,
                targetExecutionRunId: null,
                status: 'queued',
                deliveryState: 'blocked',
                deliveryBlockedReason: { in: PENDING_DELIVERY_BLOCKED_REASONS.filter(reason =>
                    !isPendingDeliveryProviderEffectPossibleV1({ status: 'blocked', reason })) },
            } } } },
        },
    }) : null;
    const localIds = input.messages.flatMap(message => message.localId ? [message.localId] : []);
    // The page is the demand boundary: never read the queue inventory or its content.
    const twins = localIds.length === 0 ? [] : await tx.sessionPendingMessage.findMany({
        where: { sessionId: input.sessionId, targetExecutionRunId: null, localId: { in: localIds } },
        select: { localId: true, status: true, deliveryState: true, deliveryBlockedReason: true, discardedReason: true },
    });
    return {
        activity: session ? {
            pendingCount: session.pendingCount,
            pendingBlockedCount: session.pendingBlockedCount,
            pendingBlockedNoEffectCount: session._count.pendingMessages,
            pendingPermissionRequestCount: session.pendingPermissionRequestCount,
            pendingUserActionRequestCount: session.pendingUserActionRequestCount,
            latestTurnStatus: parseStoredSessionLatestTurnStatus(session.latestTurnStatus) ?? null,
        } : undefined,
        pendingOwnsTranscriptLocalIds: new Set(twins
            .filter(twin => doesPendingDeliveryOwnTranscriptV1(normalizePendingDeliveryStatusV1(twin)))
            .map(twin => twin.localId)),
    };
}
