import type {
    AccountPetListResponseV1,
    AccountPetSyncUnavailableResponseV1,
} from "@happier-dev/protocol";

import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { db } from "@/storage/db";

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

async function resolvePlainAccountEncryptionMode(
    accountId: string,
): Promise<"plain" | null> {
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: {
            encryptionMode: true,
            publicKey: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    const accountCurrentness = account
        ? deriveAccountEncryptionCurrentnessFromRow(account)
        : null;
    if (
        !accountCurrentness
        || accountCurrentness.status !== "ready"
        || accountCurrentness.currentness.encryptionMode !== "plain"
    ) {
        return null;
    }
    return "plain";
}

export async function listAccountPetsForAccount(
    params: Pick<ListAccountPetsForAccountParams, "accountId">,
): Promise<AccountPetListResponseV1> {
    const accountEncryptionMode = await resolvePlainAccountEncryptionMode(
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
    const accountEncryptionMode = await resolvePlainAccountEncryptionMode(
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
