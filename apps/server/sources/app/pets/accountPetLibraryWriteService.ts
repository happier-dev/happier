import type { AccountPetCreateResponseV1, AccountPetDeleteResponseV1 } from "@happier-dev/protocol";

import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { db } from "@/storage/db";

import type { CreateAccountPetForAccountParams, DeleteAccountPetForAccountParams } from "./accountPetLibraryService";
import { getDefaultAccountPetLibraryServices } from "./accountPetLibraryRuntime";

export async function createAccountPetForAccount(
    params: CreateAccountPetForAccountParams,
): Promise<AccountPetCreateResponseV1> {
    const account = await db.account.findUnique({
        where: { id: params.accountId },
        select: { publicKey: true, encryptionMode: true },
    });
    if (!account) {
        return {
            ok: false,
            errorCode: "invalid_request",
            error: "invalid_request",
        };
    }
    const encryptionEnv = readEncryptionFeatureEnv(process.env);
    return await getDefaultAccountPetLibraryServices().createAccountPetForAccount({
        ...params,
        accountEncryptionMode: resolveEffectiveAccountEncryptionModeFromAccountRow(account),
        storagePolicy: encryptionEnv.storagePolicy,
    });
}

export async function deleteAccountPetForAccount(
    params: DeleteAccountPetForAccountParams,
): Promise<AccountPetDeleteResponseV1> {
    return await getDefaultAccountPetLibraryServices().deleteAccountPetForAccount(params);
}
