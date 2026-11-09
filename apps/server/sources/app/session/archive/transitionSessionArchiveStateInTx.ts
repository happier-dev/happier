import { applyManagedCreationScopeEndInTx } from '@/app/machines/managed/managedCreationBirth';
import { applySessionArchiveTransitionToFollowsInTx } from "@/app/session/follow/lifecycle";
import { applySessionArchiveTransitionToManagerInTx } from "@/app/session/follow/sessionManagerService";
import type { Tx } from "@/storage/inTx";
import { admitSessionLifecycleAutomationRunsTx } from "@/app/automations/automationSessionLifecycleAdmission";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { publishSessionProviderBrokerConsumersChangedInTx } from '@/app/providers/brokerConsumerChanges';

/** The canonical transactional Session archive-state write and its Follow lifecycle. */
export async function transitionSessionArchiveStateInTx(params: Readonly<{
    tx: Tx;
    sessionId: string;
    wasArchived: boolean;
    archivedAt: Date | null;
    meaningfulActivityAt?: Date;
    /** The HTTP owner has already verified this exact Run's Machine publisher. */
    originRunId?: string;
}>) {
    if (params.wasArchived === (params.archivedAt !== null) && params.meaningfulActivityAt === undefined) {
        return {
            session: await params.tx.session.findUniqueOrThrow({ where: { id: params.sessionId } }),
            didWrite: false as const,
        };
    }
    await acquireSessionAccountCursorLocksInTx(params.tx, [params.sessionId], [], {
        includeLifecyclePublications: !params.wasArchived && params.archivedAt !== null,
    });
    const session = await params.tx.session.update({
        where: { id: params.sessionId },
        data: {
            archivedAt: params.archivedAt,
            ...(params.meaningfulActivityAt
                ? { meaningfulActivityAt: params.meaningfulActivityAt }
                : {}),
        },
    });
    await applySessionArchiveTransitionToFollowsInTx({
        tx: params.tx,
        sessionId: params.sessionId,
        wasArchived: params.wasArchived,
        isArchived: params.archivedAt !== null,
    });
    await applySessionArchiveTransitionToManagerInTx(params.tx, {
        sessionId: params.sessionId, wasArchived: params.wasArchived, isArchived: params.archivedAt !== null,
    });
    if (params.wasArchived !== (params.archivedAt !== null)) {
        await applyManagedCreationScopeEndInTx(params.tx, { managedId: session.managedCreationId, accountId: session.accountId,
            source: { kind: 'session', sessionId: session.id }, endedAt: params.archivedAt?.getTime() ?? null });
    }
    if (!params.wasArchived && params.archivedAt !== null) {
        await publishSessionProviderBrokerConsumersChangedInTx(params.tx, params.sessionId);
        await admitSessionLifecycleAutomationRunsTx({
            tx: params.tx,
            accountId: session.accountId,
            occurrence: {
                v: 1, kind: "sessionLifecycle", event: "sessionArchived",
                sourceSessionId: session.id, occurredAt: params.archivedAt.getTime(),
                ...(params.originRunId !== undefined ? { originRunId: params.originRunId } : {}),
            },
        });
    }
    return { session, didWrite: true as const };
}
