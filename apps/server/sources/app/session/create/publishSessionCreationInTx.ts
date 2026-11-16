import { decodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { buildNewSessionUpdate, eventRouter } from "@/app/events/eventRouter";
import { projectSessionMetadataForRecipient } from "@/app/session/metadata/sessionMetadataRecipientProjection";
import { QUIET_SESSION_PERSONAL_DISCUSSION_FACTS } from "@/app/session/personal/discussionFacts";
import { createSessionPersonalProjectionSelect, projectSessionViewer } from "@/app/session/personal/projection";
import {
    createSessionDataKeyEnvelopeViewerSelect,
    projectViewerSessionDataKey,
} from "@/app/session/encryption/sessionDataKeyEnvelopePersistence";
import { afterTx, type Tx } from "@/storage/inTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

import type { CreatedSessionRow } from "./layout1SessionRowWrite";

/** Commit discovery with the Session; only transport wakes run after commit. */
export async function publishSessionCreationInTx(
    tx: Tx,
    params: Readonly<{
        session: CreatedSessionRow;
        ownerAccountMode: "e2ee" | "plain";
    }>,
): Promise<void> {
    const { session, ownerAccountMode } = params;
    const projection = projectSessionMetadataForRecipient({
        session,
        recipient: { type: "owner", accountId: session.accountId, accountMode: ownerAccountMode },
    });
    const personalRow = await tx.session.findUniqueOrThrow({
        where: { id: session.id },
        select: withSessionContentSelect({
            ...createSessionPersonalProjectionSelect(session.accountId),
            ...createSessionDataKeyEnvelopeViewerSelect({ viewerAccountId: session.accountId }),
        }),
    }).then(decodeSessionStoredContent);
    const viewer = projectSessionViewer({
        row: personalRow,
        latestFailureSeq: null,
        viewerAccountId: session.accountId,
        // A Session that is being created in this transaction has no
        // conversation yet, so there is nothing to load or to claim.
        discussion: QUIET_SESSION_PERSONAL_DISCUSSION_FACTS,
    });
    // The owner tuple was written earlier in this same transaction, so the
    // creating client receives its key with the Session rather than needing a
    // follow-up fetch.
    const dataEncryptionKey = projectViewerSessionDataKey(personalRow);
    const publication = await markAccountChanged(tx, {
        accountId: session.accountId,
        kind: "session",
        entityId: session.id,
    });
    afterTx(tx, () => {
        eventRouter.emitUpdate({
            userId: session.accountId,
            payload: buildNewSessionUpdate(
                { ...session, dataEncryptionKey },
                publication.resolveCursor(),
                randomKeyNaked(12),
                projection,
                viewer,
            ),
            recipientFilter: { type: "user-scoped-only" },
        });
    });
}
