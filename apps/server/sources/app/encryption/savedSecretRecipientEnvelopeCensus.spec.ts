import { describe, expect, it } from "vitest";
import { signAccountContentKeyBindingV1 } from "@happier-dev/protocol";
import { sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1";
import tweetnacl from "tweetnacl";

import { deriveAccountRecipientEnvelopeReadinessFromRow } from "./accountRecipientEnvelopeReadiness";
import {
    projectSavedSecretRecipientEnvelopeCensusRecipientsV1,
    resolveSavedSecretAudienceAccountIdsInTx,
    readRequiredResourceRecipientEnvelopeRejectionV1,
    readTargetOwnerRecipientEnvelopeRejectionV1,
    type ResourceRecipientAccountRow,
    type ResourceRecipientEnvelopeRow,
} from "./savedSecretRecipientEnvelopeCensus";

function recipient(id: string): ResourceRecipientAccountRow {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    return {
        id,
        name: id,
        firstName: null,
        lastName: null,
        username: null,
        avatar: null,
        publicKey: Buffer.from(signing.publicKey).toString("hex"),
        encryptionMode: "e2ee",
        contentPublicKey: new Uint8Array(content.publicKey),
        contentPublicKeySig: signAccountContentKeyBindingV1({
            accountSigningSecretKey: signing.secretKey,
            contentPublicKey: content.publicKey,
        }),
    };
}

function envelopeFor(account: ResourceRecipientAccountRow): ResourceRecipientEnvelopeRow {
    const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
    if (readiness.status !== "available") throw new Error("Expected test recipient to be ready");
    return {
        accountId: account.id,
        encryptedDataKey: sealEncryptedDataKeyEnvelopeV1({
            dataKey: tweetnacl.randomBytes(32),
            recipientPublicKey: readiness.binding.contentPublicKey,
            randomBytes: tweetnacl.randomBytes,
        }),
        recipientContentPublicKeyFingerprint: readiness.binding.contentPublicKeyFingerprint,
    };
}

describe("Saved Secret recipient envelope census", () => {
    it("supports a Team-only automated writer without inventing an author Account recipient", async () => {
        const tx = {
            teamMembership: {
                findMany: async () => [{ accountId: "team-member", role: "member" }],
            },
            teamGroupMembership: {
                findMany: async () => [],
            },
        };

        await expect(resolveSavedSecretAudienceAccountIdsInTx(tx as never, {
            ownerAccountId: undefined,
            accountIds: [],
            teamIds: ["team-1"],
            groupIds: [],
        })).resolves.toEqual(["team-member"]);
    });

    it("projects readiness and refuses a partial or stale required Team recipient set", () => {
        const owner = recipient("owner");
        const member = recipient("member");
        const ownerEnvelope = envelopeFor(owner);
        const memberEnvelope = envelopeFor(member);
        const recipientsById = new Map([
            [owner.id, owner],
            [member.id, member],
        ]);

        expect(projectSavedSecretRecipientEnvelopeCensusRecipientsV1({
            accounts: [owner, member],
            envelopes: [ownerEnvelope, memberEnvelope],
        }).map(({ account, readiness, envelopeStatus }) => ({
            accountId: account.accountId,
            readiness: readiness.status,
            envelopeStatus,
        }))).toEqual([
            { accountId: "owner", readiness: "available", envelopeStatus: "prepared" },
            { accountId: "member", readiness: "available", envelopeStatus: "prepared" },
        ]);

        expect(readRequiredResourceRecipientEnvelopeRejectionV1({
            expectedRecipientAccountIds: [owner.id, member.id],
            envelopes: [ownerEnvelope],
            recipientsById,
        })).toBe("recipient_set_mismatch");

        expect(readRequiredResourceRecipientEnvelopeRejectionV1({
            expectedRecipientAccountIds: [owner.id, member.id],
            envelopes: [ownerEnvelope, {
                ...memberEnvelope,
                recipientContentPublicKeyFingerprint: "content-public-key-sha256:stale",
            }],
            recipientsById,
        })).toBe("fingerprint_mismatch");
    });

    it("refuses a transition target envelope unless it is exactly the verified owner envelope", () => {
        const owner = recipient("owner");
        const other = recipient("other");
        const ownerEnvelope = envelopeFor(owner);
        const otherEnvelope = envelopeFor(other);

        expect(readTargetOwnerRecipientEnvelopeRejectionV1({
            ownerAccountId: owner.id,
            ownerContentPublicKeyFingerprint: ownerEnvelope.recipientContentPublicKeyFingerprint,
            envelopes: [ownerEnvelope],
        })).toBeNull();
        expect(readTargetOwnerRecipientEnvelopeRejectionV1({
            ownerAccountId: owner.id,
            ownerContentPublicKeyFingerprint: ownerEnvelope.recipientContentPublicKeyFingerprint,
            envelopes: [ownerEnvelope, otherEnvelope],
        })).toBe("recipient_set_mismatch");
        expect(readTargetOwnerRecipientEnvelopeRejectionV1({
            ownerAccountId: owner.id,
            ownerContentPublicKeyFingerprint: ownerEnvelope.recipientContentPublicKeyFingerprint,
            envelopes: [{ ...otherEnvelope, recipientContentPublicKeyFingerprint: ownerEnvelope.recipientContentPublicKeyFingerprint }],
        })).toBe("owner_recipient_mismatch");
        expect(readTargetOwnerRecipientEnvelopeRejectionV1({
            ownerAccountId: owner.id,
            ownerContentPublicKeyFingerprint: ownerEnvelope.recipientContentPublicKeyFingerprint,
            envelopes: [{ ...ownerEnvelope, recipientContentPublicKeyFingerprint: "content-public-key-sha256:stale" }],
        })).toBe("fingerprint_mismatch");
        expect(readTargetOwnerRecipientEnvelopeRejectionV1({
            ownerAccountId: owner.id,
            ownerContentPublicKeyFingerprint: ownerEnvelope.recipientContentPublicKeyFingerprint,
            envelopes: [{ ...ownerEnvelope, encryptedDataKey: new Uint8Array([1, 2, 3]) }],
        })).toBe("malformed_envelope");
    });
});
