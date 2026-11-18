import type { AccountPetListResponseV1, AccountPetSyncUnavailableResponseV1 } from '@happier-dev/protocol/pets/accountLibrary';

import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { inTx } from "@/storage/inTx";

import type {
    AccountPetAssetReadResult,
    ListAccountPetsForAccountParams,
    ReadAccountPetAssetForAccountParams,
} from "./accountPetLibraryService";
import { getDefaultAccountPetLibraryServices } from "./accountPetLibraryRuntime";

function customPetSyncUnavailableResponse(): AccountPetSyncUnavailableResponseV1 {
    return {
        ok: false,
        errorCode: "custom_pet_sync_unavailable",
        error: "custom_pet_sync_unavailable",
    };
}

/** Persisted Account mode decides which content representation the read may disclose. */
async function resolveAccountPetReadEncryptionMode(
    accountId: string,
): Promise<"plain" | "e2ee" | null> {
    const account = await inTx(tx => tx.account.findUnique({
        where: { id: accountId },
        select: {
            encryptionMode: true,
            publicKey: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    }), { readOnly: true });
    const accountCurrentness = account
        ? deriveAccountEncryptionCurrentnessFromRow(account)
        : null;
    if (!accountCurrentness || accountCurrentness.status !== "ready") {
        return null;
    }
    return accountCurrentness.currentness.encryptionMode;
}

export async function listAccountPetsForAccount(
    params: Pick<ListAccountPetsForAccountParams, "accountId">,
): Promise<AccountPetListResponseV1> {
    const accountEncryptionMode = await resolveAccountPetReadEncryptionMode(
        params.accountId,
    );
    if (!accountEncryptionMode) {
        return customPetSyncUnavailableResponse();
    }
    return await getDefaultAccountPetLibraryServices().listAccountPetsForAccount({
        ...params,
        accountEncryptionMode,
    });
}

export async function readAccountPetAssetForAccount(
    params: Omit<ReadAccountPetAssetForAccountParams, "accountEncryptionMode">,
): Promise<AccountPetAssetReadResult | null> {
    const accountEncryptionMode = await resolveAccountPetReadEncryptionMode(
        params.accountId,
    );
    if (!accountEncryptionMode) {
        return customPetSyncUnavailableResponse();
    }
    return await getDefaultAccountPetLibraryServices().readAccountPetAssetForAccount({
        ...params,
        accountEncryptionMode,
    });
}
