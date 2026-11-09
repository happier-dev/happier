import * as privacyKit from "privacy-kit";

import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { db } from "@/storage/db";
import {
    assertAccountJsonKvMutationStoredContent,
    isAccountJsonKvKey,
    AccountJsonKvStoredContentModeMismatchError,
} from "./accountJsonKvStoredContent";

/** Account JSON reads, including fresh conflict snapshots, share mode/codec admission. */
export async function assertAccountJsonKvReadStoredContentMatchesAccount(
    accountId: string,
    items: ReadonlyArray<Readonly<{ key: string; value: string | Uint8Array }>>,
    supportsCurrentProtocol = true,
): Promise<void> {
    const accountJsonItems = items.filter((item) => isAccountJsonKvKey(item.key));
    if (accountJsonItems.length === 0) return;

    const account = await db.account.findUnique({
        where: { id: accountId },
        select: {
            encryptionMode: true,
            publicKey: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    const currentness = account ? deriveAccountEncryptionCurrentnessFromRow(account) : null;
    if (!currentness || currentness.status !== "ready") {
        throw new AccountJsonKvStoredContentModeMismatchError();
    }
    for (const item of accountJsonItems) {
        // A read has no replacement. Reuse the same persisted representation
        // admission as mutation conflicts, including the incumbent 426 contract.
        assertAccountJsonKvMutationStoredContent({
            key: item.key,
            persistedValue: typeof item.value === "string" ? privacyKit.decodeBase64(item.value) : item.value,
            nextValue: null,
            accountMode: currentness.currentness.encryptionMode,
            supportsCurrentProtocol,
        });
    }
}
