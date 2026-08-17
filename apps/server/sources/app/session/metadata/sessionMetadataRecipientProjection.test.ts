import { describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";

import {
    projectSessionMetadataForRecipient,
    readSessionMetadataOwnerAccountMode,
    readSessionMetadataOwnerAccountModes,
    SessionMetadataPrivacyUpgradeRequiredError,
} from "./sessionMetadataRecipientProjection";
import {
    parsePersistedSessionOwnerMetadataEnvelopeV1,
} from "./sessionOwnerMetadataPersistence";

const OWNER_CIPHERTEXT =
    "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==";
const OWNER_ENVELOPE = {
    t: "encrypted",
    c: OWNER_CIPHERTEXT,
} as const;
const STORED_OWNER_ENVELOPE = JSON.stringify(OWNER_ENVELOPE);

const base = {
    accountId: "owner",
    encryptionMode: "e2ee",
    metadata: "shared",
    metadataVersion: 3,
    metadataLayoutVersion: 1,
    ownerMetadata: STORED_OWNER_ENVELOPE,
    agentState: "full-owner-state",
    agentStateVersion: 7,
};

describe("projectSessionMetadataForRecipient", () => {
    it("projects strict plaintext shared metadata without changing its stored bytes", () => {
        const metadata = JSON.stringify({ v: 1 });
        const session = {
            ...base,
            encryptionMode: "plain",
            metadata,
        };

        expect(projectSessionMetadataForRecipient({
            session,
            recipient: {
                type: "owner",
                accountId: "owner",
                accountMode: "e2ee",
            },
        })).toMatchObject({ metadata });
        expect(projectSessionMetadataForRecipient({
            session,
            recipient: {
                type: "shared",
                accountId: "recipient",
                ownerAccountMode: "e2ee",
            },
        })).toMatchObject({ metadata });
    });

    it.each([
        {
            name: "malformed JSON",
            metadata: "owner-private-path=/Users/alice/secret-project",
        },
        {
            name: "strict-unknown owner fields",
            metadata: JSON.stringify({
                v: 1,
                path: "/Users/alice/secret-project",
                machineId: "owner-private-machine",
                operationClaimId: "owner-private-claim",
            }),
        },
    ])("fails $name plaintext shared metadata closed for owner and shared recipients", ({ metadata }) => {
        const session = {
            ...base,
            encryptionMode: "plain",
            metadata,
        };

        expect(() => projectSessionMetadataForRecipient({
            session,
            recipient: {
                type: "owner",
                accountId: "owner",
                accountMode: "e2ee",
            },
        })).toThrow(SessionMetadataPrivacyUpgradeRequiredError);
        expect(() => projectSessionMetadataForRecipient({
            session,
            recipient: {
                type: "shared",
                accountId: "recipient",
                ownerAccountMode: "e2ee",
            },
        })).toThrow(SessionMetadataPrivacyUpgradeRequiredError);
    });

    it.each([
        {
            accountMode: "plain" as const,
            sessionEncryptionMode: "e2ee",
            metadata: "shared",
            ownerMetadata: JSON.stringify({
                t: "plain",
                v: { v: 1 },
            }),
        },
        {
            accountMode: "e2ee" as const,
            sessionEncryptionMode: "plain",
            metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: STORED_OWNER_ENVELOPE,
        },
    ])("projects an owner envelope from Account mode, independently of Session $sessionEncryptionMode storage", ({
        accountMode,
        sessionEncryptionMode,
        metadata,
        ownerMetadata,
    }) => {
        expect(projectSessionMetadataForRecipient({
            session: {
                ...base,
                encryptionMode: sessionEncryptionMode,
                metadata,
                ownerMetadata,
            },
            recipient: {
                type: "owner",
                accountId: "owner",
                accountMode,
            },
        })).toMatchObject({
            ownerMetadata: JSON.parse(ownerMetadata),
        });
    });

    it("normalizes the retained canonical ciphertext only for its E2EE Account owner", () => {
        expect(projectSessionMetadataForRecipient({
            session: {
                ...base,
                ownerMetadata: OWNER_CIPHERTEXT,
            },
            recipient: {
                type: "owner",
                accountId: "owner",
                accountMode: "e2ee",
            },
        })).toMatchObject({ ownerMetadata: OWNER_ENVELOPE });
    });

    it("admits the retained development ciphertext only at the explicit layout-1 E2EE repair boundary", () => {
        expect(parsePersistedSessionOwnerMetadataEnvelopeV1({
            metadataLayoutVersion: 1,
            accountMode: "e2ee",
            ownerMetadata: OWNER_CIPHERTEXT,
            allowRetainedDevelopmentCiphertext: true,
        })).toEqual(OWNER_ENVELOPE);
        expect(parsePersistedSessionOwnerMetadataEnvelopeV1({
            metadataLayoutVersion: 1,
            accountMode: "e2ee",
            ownerMetadata: STORED_OWNER_ENVELOPE,
            allowRetainedDevelopmentCiphertext: false,
        })).toEqual(OWNER_ENVELOPE);

        for (const input of [
            {
                metadataLayoutVersion: 1,
                accountMode: "e2ee" as const,
                ownerMetadata: OWNER_CIPHERTEXT,
                allowRetainedDevelopmentCiphertext: false,
            },
            {
                metadataLayoutVersion: 1,
                accountMode: "plain" as const,
                ownerMetadata: OWNER_CIPHERTEXT,
                allowRetainedDevelopmentCiphertext: true,
            },
            {
                metadataLayoutVersion: 2,
                accountMode: "e2ee" as const,
                ownerMetadata: OWNER_CIPHERTEXT,
                allowRetainedDevelopmentCiphertext: true,
            },
            {
                metadataLayoutVersion: 1,
                accountMode: "e2ee" as const,
                ownerMetadata: "not-owner-metadata",
                allowRetainedDevelopmentCiphertext: true,
            },
        ]) {
            expect(parsePersistedSessionOwnerMetadataEnvelopeV1(input))
                .toBeNull();
        }
    });

    it.each([
        {
            accountMode: "plain" as const,
            ownerMetadata: STORED_OWNER_ENVELOPE,
        },
        {
            accountMode: "plain" as const,
            ownerMetadata: OWNER_CIPHERTEXT,
        },
        {
            accountMode: "e2ee" as const,
            ownerMetadata: JSON.stringify({
                t: "plain",
                v: { v: 1 },
            }),
        },
    ])("fails owner disclosure closed when the $accountMode Account and owner envelope disagree", ({
        accountMode,
        ownerMetadata,
    }) => {
        expect(() => projectSessionMetadataForRecipient({
            session: {
                ...base,
                ownerMetadata,
            },
            recipient: {
                type: "owner",
                accountId: "owner",
                accountMode,
            },
        })).toThrow(SessionMetadataPrivacyUpgradeRequiredError);
    });

    it.each([
        {
            ownerAccountMode: "plain" as const,
            ownerMetadata: STORED_OWNER_ENVELOPE,
        },
        {
            ownerAccountMode: "e2ee" as const,
            ownerMetadata: JSON.stringify({
                t: "plain",
                v: { v: 1 },
            }),
        },
    ])("fails shared and public disclosure closed when the $ownerAccountMode owning Account and owner envelope disagree", ({
        ownerAccountMode,
        ownerMetadata,
    }) => {
        for (const accountId of ["recipient", null]) {
            expect(() => projectSessionMetadataForRecipient({
                session: {
                    ...base,
                    ownerMetadata,
                },
                recipient: {
                    type: "shared",
                    accountId,
                    ownerAccountMode,
                },
            })).toThrow(SessionMetadataPrivacyUpgradeRequiredError);
        }
    });

    it.each([
        {
            ownerAccountMode: "plain" as const,
            ownerMetadata: JSON.stringify({
                t: "plain",
                v: { v: 1 },
            }),
        },
        {
            ownerAccountMode: "e2ee" as const,
            ownerMetadata: STORED_OWNER_ENVELOPE,
        },
    ])("projects shared and public metadata for a valid $ownerAccountMode owning Account envelope", ({
        ownerAccountMode,
        ownerMetadata,
    }) => {
        for (const accountId of ["recipient", null]) {
            expect(projectSessionMetadataForRecipient({
                session: {
                    ...base,
                    ownerMetadata,
                },
                recipient: {
                    type: "shared",
                    accountId,
                    ownerAccountMode,
                },
            })).toEqual({
                metadata: "shared",
                metadataVersion: 3,
                metadataLayoutVersion: 1,
                agentState: null,
                agentStateVersion: 7,
            });
        }
    });

    it("projects full owner state only to the owner and publishes an authoritative tombstone to a shared recipient", () => {
        expect(projectSessionMetadataForRecipient({
            session: base,
            recipient: {
                type: "owner",
                accountId: "owner",
                accountMode: "e2ee",
            },
        })).toEqual({
            metadata: "shared",
            metadataVersion: 3,
            metadataLayoutVersion: 1,
            ownerMetadata: OWNER_ENVELOPE,
            agentState: "full-owner-state",
            agentStateVersion: 7,
        });
        expect(projectSessionMetadataForRecipient({
            session: base,
            recipient: {
                type: "shared",
                accountId: "recipient",
                ownerAccountMode: "e2ee",
            },
        })).toEqual({
            metadata: "shared",
            metadataVersion: 3,
            metadataLayoutVersion: 1,
            agentState: null,
            agentStateVersion: 7,
        });
        expect(projectSessionMetadataForRecipient({
            session: base,
            recipient: {
                type: "shared",
                accountId: null,
                ownerAccountMode: "e2ee",
            },
        })).toEqual({
            metadata: "shared",
            metadataVersion: 3,
            metadataLayoutVersion: 1,
            agentState: null,
            agentStateVersion: 7,
        });
    });

    it.each([
        { metadataLayoutVersion: 1, ownerMetadata: "" },
        { metadataLayoutVersion: 1, ownerMetadata: "not-json" },
        { metadataLayoutVersion: 1, ownerMetadata: JSON.stringify({ t: "encrypted", c: "not-base64" }) },
        { metadataLayoutVersion: 2, ownerMetadata: STORED_OWNER_ENVELOPE },
    ])("fails a non-owner read closed for an incomplete/unsupported tuple %#", (override) => {
        expect(() => projectSessionMetadataForRecipient({
            session: { ...base, ...override },
            recipient: {
                type: "shared",
                accountId: "recipient",
                ownerAccountMode: "e2ee",
            },
        })).toThrow(SessionMetadataPrivacyUpgradeRequiredError);
    });

    it("preserves layout-zero only for the owner and fails non-owner/public reads closed", () => {
        const legacy = {
            ...base,
            metadata: "legacy-whole-bag",
            metadataLayoutVersion: 0,
            ownerMetadata: null,
            agentState: "legacy-agent-state",
        };
        const expected = {
            metadata: "legacy-whole-bag",
            metadataVersion: 3,
            metadataLayoutVersion: 0,
            agentState: "legacy-agent-state",
            agentStateVersion: 7,
        };

        expect(projectSessionMetadataForRecipient({
            session: legacy,
            recipient: {
                type: "legacy_owner",
                accountId: "owner",
            },
        })).toEqual(expected);
        expect(() => projectSessionMetadataForRecipient({
            session: legacy,
            recipient: {
                type: "shared",
                accountId: "recipient",
                ownerAccountMode: "e2ee",
            },
        })).toThrow(SessionMetadataPrivacyUpgradeRequiredError);
        expect(() => projectSessionMetadataForRecipient({
            session: legacy,
            recipient: {
                type: "shared",
                accountId: null,
                ownerAccountMode: "e2ee",
            },
        })).toThrow(SessionMetadataPrivacyUpgradeRequiredError);
    });

    it.each([
        {},
        { metadataLayoutVersion: null },
        { metadataLayoutVersion: 0 },
    ])("normalizes a missing/legacy layout marker for the owner only %#", (override) => {
        const session = {
            ...base,
            ownerMetadata: null,
            ...override,
        };
        if (!("metadataLayoutVersion" in override)) {
            delete (session as { metadataLayoutVersion?: number | null }).metadataLayoutVersion;
        }

        const expected = {
            metadata: "shared",
            metadataVersion: 3,
            metadataLayoutVersion: 0,
            agentState: "full-owner-state",
            agentStateVersion: 7,
        };
        expect(projectSessionMetadataForRecipient({
            session,
            recipient: {
                type: "owner",
                accountId: "owner",
                accountMode: "e2ee",
            },
        })).toEqual(expected);
        expect(() => projectSessionMetadataForRecipient({
            session,
            recipient: {
                type: "shared",
                accountId: "recipient",
                ownerAccountMode: "e2ee",
            },
        })).toThrow(SessionMetadataPrivacyUpgradeRequiredError);
        expect(() => projectSessionMetadataForRecipient({
            session,
            recipient: {
                type: "shared",
                accountId: null,
                ownerAccountMode: "e2ee",
            },
        })).toThrow(SessionMetadataPrivacyUpgradeRequiredError);
    });

    it.each([
        {},
        { metadataLayoutVersion: null },
        { metadataLayoutVersion: 0 },
    ])("rejects a partial split row with a missing/legacy layout marker %#", (override) => {
        const session = {
            ...base,
            ...override,
        };
        if (!("metadataLayoutVersion" in override)) {
            delete (session as { metadataLayoutVersion?: number | null }).metadataLayoutVersion;
        }

        for (const recipientAccountId of ["owner", "recipient", null]) {
            expect(() => projectSessionMetadataForRecipient({
                session,
                recipient: recipientAccountId === null
                    ? {
                        type: "shared",
                        accountId: null,
                        ownerAccountMode: "e2ee",
                      }
                    : recipientAccountId === "owner"
                        ? {
                            type: "owner",
                            accountId: recipientAccountId,
                            accountMode: "e2ee",
                        }
                        : {
                            type: "shared",
                            accountId: recipientAccountId,
                            ownerAccountMode: "e2ee",
                        },
            })).toThrow(SessionMetadataPrivacyUpgradeRequiredError);
        }
    });

    it("derives ownership only from the persisted owner account id", () => {
        expect(projectSessionMetadataForRecipient({
            session: {
                ...base,
                accountId: "actual-owner",
            },
            recipient: {
                type: "owner",
                accountId: "claimed-owner",
                accountMode: "e2ee",
            },
        })).toEqual({
            metadata: "shared",
            metadataVersion: 3,
            metadataLayoutVersion: 1,
            agentState: null,
            agentStateVersion: 7,
        });
    });
});

describe("readSessionMetadataOwnerAccountMode", () => {
    it("batches distinct layout-one owners into one validated Account snapshot", async () => {
        const findMany = vi.fn().mockResolvedValue([
            {
                id: "plain-owner",
                publicKey: null,
                encryptionMode: "plain",
                contentPublicKey: null,
                contentPublicKeySig: null,
            },
            {
                id: "second-plain-owner",
                publicKey: null,
                encryptionMode: "plain",
                contentPublicKey: null,
                contentPublicKeySig: null,
            },
        ]);
        const client = {
            account: { findMany },
        } as unknown as Pick<Tx, "account">;

        await expect(readSessionMetadataOwnerAccountModes(client, [
            "plain-owner",
            "second-plain-owner",
            "plain-owner",
        ])).resolves.toEqual(new Map([
            ["plain-owner", "plain"],
            ["second-plain-owner", "plain"],
        ]));
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                id: {
                    in: ["plain-owner", "second-plain-owner"],
                },
            },
        }));
    });

    it.each([
        {
            name: "missing content-key binding",
            row: {
                publicKey: "00".repeat(32),
                encryptionMode: "e2ee",
                contentPublicKey: null,
                contentPublicKeySig: null,
            },
        },
        {
            name: "missing signing-key binding",
            row: {
                publicKey: null,
                encryptionMode: "e2ee",
                contentPublicKey: new Uint8Array(32),
                contentPublicKeySig: new Uint8Array(64),
            },
        },
    ])("fails $name closed before projection", async ({ row }) => {
        const client = {
            account: {
                findUnique: vi.fn().mockResolvedValue(row),
            },
        } as unknown as Pick<Tx, "account">;

        await expect(readSessionMetadataOwnerAccountMode(client, "owner"))
            .rejects.toBeInstanceOf(
                SessionMetadataPrivacyUpgradeRequiredError,
            );
    });
});
