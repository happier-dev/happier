import type { AccountPetCreateResponseV1, AccountPetDeleteResponseV1 } from "@happier-dev/protocol";

import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { db } from "@/storage/db";

import type { CreateAccountPetForAccountParams, DeleteAccountPetForAccountParams } from "./accountPetLibraryService";
import { getDefaultAccountPetLibraryServices } from "./accountPetLibraryRuntime";

function internalCreateResponse(): AccountPetCreateResponseV1 {
    return {
        ok: false,
        errorCode: "internal_error",
        error: "internal_error",
    };
}

export async function createAccountPetForAccount(
    params: CreateAccountPetForAccountParams,
): Promise<AccountPetCreateResponseV1> {
    try {
        const account = await db.account.findUnique({
            where: { id: params.accountId },
            select: { publicKey: true, encryptionMode: true },
        });
        if (!account) {
            return internalCreateResponse();
        }

        const encryptionEnv = readEncryptionFeatureEnv(process.env);
        return await getDefaultAccountPetLibraryServices().createAccountPetForAccount({
            ...params,
            accountEncryptionMode: resolveEffectiveAccountEncryptionModeFromAccountRow(account),
            storagePolicy: encryptionEnv.storagePolicy,
        });
    } catch {
        return internalCreateResponse();
    }
}

export async function deleteAccountPetForAccount(
    params: DeleteAccountPetForAccountParams,
): Promise<AccountPetDeleteResponseV1> {
    return await getDefaultAccountPetLibraryServices().deleteAccountPetForAccount(params);
}
