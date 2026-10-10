import type { ExternalActionExecutionAuthorizationBindingV1 } from "@happier-dev/protocol/actions";

import { ApiTokenOperationError } from "@/app/auth/auth";
import { verifyCurrentExternalActionPrincipalInTx } from "@/app/auth/externalActionExecutionAuthorization";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import type { Tx } from "@/storage/inTx";

/** Host-only proof carried from verified request admission, never a body field. */
export async function readSessionCreationApiTokenIdInTx(
    tx: Tx,
    accountId: string,
    authorization: ExternalActionExecutionAuthorizationBindingV1 | undefined,
): Promise<string | null> {
    if (authorization === undefined) return null;
    await acquireAccountSessionOwnerMetadataFenceInTx(tx, accountId);
    const principal = await verifyCurrentExternalActionPrincipalInTx(tx, authorization);
    if (authorization.accountId !== accountId || authorization.actionId !== "session.spawn_new" || !principal) {
        throw new ApiTokenOperationError("invalid_token");
    }
    return 'credentialId' in principal ? principal.credentialId : null;
}
