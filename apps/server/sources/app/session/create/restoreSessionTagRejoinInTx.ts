import { didSessionActivityBadgeSignalChange } from "@/app/activity/accountActivityBadge";
import {
    type SessionArchiveTransitionPublication,
} from "@/app/session/archive/publishSessionArchiveTransition";
import { transitionSessionArchiveStateInTx } from "@/app/session/archive/transitionSessionArchiveStateInTx";
import { markSessionProjectionRecipientsChanged } from "@/app/session/changeTracking/markSessionProjectionRecipientsChanged";
import { transactionResult, type TransactionResult, type Tx } from "@/storage/inTx";
import { resolveSessionAccountChangePublications } from "@/app/session/changeTracking/markAccountChangesForSessionAccounts";

import type { CreatedSessionRow } from "./layout1SessionRowWrite";

export type RestoredSessionTagRejoin = Readonly<{
    session: CreatedSessionRow;
    publication: SessionArchiveTransitionPublication | null;
}>;

/**
 * Applies the released ordinary tag-rejoin lifecycle without changing Session
 * content, pending state, placement or runtime activity.
 */
export async function restoreSessionTagRejoinInTx(
    tx: Tx,
    existing: CreatedSessionRow,
): Promise<TransactionResult<RestoredSessionTagRejoin> & Pick<RestoredSessionTagRejoin, "session">> {
    if (existing.active && existing.archivedAt === null) {
        return { ...transactionResult(() => ({ session: existing, publication: null })), session: existing };
    }

    const meaningfulActivityAtDate = new Date();
    const meaningfulActivityAt = meaningfulActivityAtDate.getTime();
    const wasArchived = existing.archivedAt !== null;
    const { session } = await transitionSessionArchiveStateInTx({
        tx,
        sessionId: existing.id,
        wasArchived,
        archivedAt: null,
        meaningfulActivityAt: meaningfulActivityAtDate,
    });
    const projection = {
        sessionStart: true as const,
        meaningfulActivityAt,
        ...(wasArchived ? { archivedAt: null } : {}),
    };
    const recipientCursors = await markSessionProjectionRecipientsChanged({
        tx,
        sessionId: existing.id,
        hint: projection,
    });
    return {
        ...transactionResult(() => ({
            session,
            publication: {
                sessionId: existing.id,
                projection,
                recipientCursors: resolveSessionAccountChangePublications(recipientCursors),
                badgeAttentionChanged: didSessionActivityBadgeSignalChange(existing, session),
            },
        })),
        session,
    };
}
