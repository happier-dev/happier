import {
    PrivateLabelStoredV1Schema,
    sealPrivateLabelV1,
    serializePrivateLabelStoredV1,
    type PrivateLabelBindingV1,
    type PrivateLabelStoredV1,
} from "@happier-dev/protocol/crypto/privateLabelV1";
import { prepareSavedSecretResourceRecipientEnvelopesV1 } from "@happier-dev/protocol/account/settings/savedSecretResourceContentV1";
import tweetnacl from "tweetnacl";

import { readSavedSecretAudienceRecipientEnvelopeCensusInTx } from "@/app/encryption/savedSecretRecipientEnvelopeCensus";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";

/** A protocol-shaped plain label for fixtures whose owner Account is explicitly plain. */
export function plainPrivateLabel(value: string): PrivateLabelStoredV1 {
    return PrivateLabelStoredV1Schema.parse({
        content: { t: "plain", v: value },
        recipients: [],
    });
}

/** Serialized Plain label for direct database fixtures. */
export function storedPlainPrivateLabel(value: string): string {
    return serializePrivateLabelStoredV1(plainPrivateLabel(value));
}

/**
 * Existing token fixtures that predate private labels use bare Accounts without
 * client content keys. Make that fixture state explicitly plain before using a
 * typed plain label; a keyed E2EE Account must instead exercise the real seal
 * path.
 */
export async function preparePlainAccountApiTokenLabel(accountId: string, value: string): Promise<PrivateLabelStoredV1> {
    const account = await db.account.findUniqueOrThrow({
        where: { id: accountId },
        select: { encryptionMode: true, contentPublicKey: true },
    });
    if (account.encryptionMode === "e2ee" && account.contentPublicKey !== null) {
        throw new Error("A keyed E2EE Account fixture must seal its API-token label");
    }
    if (account.encryptionMode !== "plain") {
        await db.account.update({ where: { id: accountId }, data: { encryptionMode: "plain" } });
    }
    return plainPrivateLabel(value);
}

/** Seals a token label exactly as an E2EE Account client does, using the server-owned recipient census. */
export async function prepareE2eePrivateLabelForAccount(
    accountId: string,
    binding: PrivateLabelBindingV1,
    value: string,
    audience: Pick<Parameters<typeof readSavedSecretAudienceRecipientEnvelopeCensusInTx>[1], "accountIds" | "teamIds" | "groupIds"> = {},
): Promise<PrivateLabelStoredV1> {
    const census = await inTx((tx) => readSavedSecretAudienceRecipientEnvelopeCensusInTx(tx, {
        ownerAccountId: accountId,
        ...audience,
    }), { readOnly: true });
    const dataKey = tweetnacl.randomBytes(32);
    return sealPrivateLabelV1({
        mode: "e2ee",
        binding,
        value,
        dataKey,
        recipients: prepareSavedSecretResourceRecipientEnvelopesV1({
            recipients: census.recipients,
            resourceDataKey: dataKey,
            randomBytes: tweetnacl.randomBytes,
        }).map((recipient) => ({
            accountId: recipient.recipientAccountId,
            envelope: {
                encryptedDataKey: recipient.encryptedDataKey,
                recipientContentPublicKeyFingerprint: recipient.recipientContentPublicKeyFingerprint,
            },
        })),
        randomBytes: tweetnacl.randomBytes,
    });
}

export function prepareE2eeAccountApiTokenLabel(
    accountId: string,
    tokenId: string,
    value: string,
): Promise<PrivateLabelStoredV1> {
    return prepareE2eePrivateLabelForAccount(accountId, {
        entity: "account_api_token",
        field: "label",
        id: tokenId,
    }, value);
}
