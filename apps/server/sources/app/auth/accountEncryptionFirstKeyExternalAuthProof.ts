import type {
    AccountEncryptionMigrateExternalAuthProof,
    AccountEncryptionMigrateExternalAuthBindingDigestV1,
} from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";
import {
    consumeAccountEncryptionFirstKeyStepUpPendingInTx,
    type AccountEncryptionFirstKeyStepUpConsumeResult,
} from "@/app/api/routes/connect/connectRoutes.oauthPending";
import {
    consumeMtlsFirstKeyStepUpClaimInTx,
} from "./providers/mtls/mtlsClaimCode";

export async function consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        requestDigest:
            AccountEncryptionMigrateExternalAuthBindingDigestV1;
        externalAuthProof:
            AccountEncryptionMigrateExternalAuthProof;
    }>,
): Promise<AccountEncryptionFirstKeyStepUpConsumeResult> {
    if (params.externalAuthProof.provider === "mtls") {
        return await consumeMtlsFirstKeyStepUpClaimInTx(
            tx,
            {
                accountId: params.accountId,
                pending: params.externalAuthProof.pending,
                proof: params.externalAuthProof.proof,
                requestDigest: params.requestDigest,
            },
        );
    }
    return await consumeAccountEncryptionFirstKeyStepUpPendingInTx(
        tx,
        {
            accountId: params.accountId,
            provider: params.externalAuthProof.provider,
            pending: params.externalAuthProof.pending,
            proof: params.externalAuthProof.proof,
            requestDigest: params.requestDigest,
        },
    );
}
