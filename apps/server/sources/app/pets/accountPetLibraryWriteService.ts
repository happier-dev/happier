import type { AccountPetCreateResponseV1, AccountPetDeleteResponseV1 } from "@happier-dev/protocol";

import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { db } from "@/storage/db";

import type { CreateAccountPetForAccountParams, DeleteAccountPetForAccountParams } from "./accountPetLibraryService";
import { getDefaultAccountPetLibraryServices } from "./accountPetLibraryRuntime";

export async function createAccountPetForAccount(
    params: CreateAccountPetForAccountParams,
): Promise<AccountPetCreateResponseV1> {
    const account = await db.account.findUnique({
        where: { id: params.accountId },
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    if (!account) {
        return {
            ok: false,
            errorCode: "invalid_request",
            error: "invalid_request",
        };
    }
    const currentness =
        deriveAccountEncryptionCurrentnessFromRow(account);
    if (currentness.status === "inconsistent") {
        return {
            ok: false,
            errorCode: "custom_pet_sync_requires_plaintext",
            error: "custom_pet_sync_requires_plaintext",
        };
    }
    const encryptionEnv = readEncryptionFeatureEnv(process.env);
    return await getDefaultAccountPetLibraryServices().createAccountPetForAccount({
        ...params,
        accountEncryptionMode:
            currentness.currentness.encryptionMode,
        storagePolicy: encryptionEnv.storagePolicy,
    });
}

export async function deleteAccountPetForAccount(
    params: DeleteAccountPetForAccountParams,
): Promise<AccountPetDeleteResponseV1> {
    return await getDefaultAccountPetLibraryServices().deleteAccountPetForAccount(params);
}
