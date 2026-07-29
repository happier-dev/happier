import { describe, expect, it } from "vitest";

import {
    projectSessionMetadataForRecipient,
    SessionMetadataPrivacyUpgradeRequiredError,
} from "./sessionMetadataRecipientProjection";

const OWNER_CIPHERTEXT =
    "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==";

const base = {
    accountId: "owner",
    metadata: "shared",
    metadataVersion: 3,
    metadataLayoutVersion: 1,
    ownerMetadata: OWNER_CIPHERTEXT,
    agentState: "full-owner-state",
    agentStateVersion: 7,
};

describe("projectSessionMetadataForRecipient", () => {
    it("projects full owner state only to the owner and publishes an authoritative tombstone to a shared recipient", () => {
        expect(projectSessionMetadataForRecipient({
            session: base,
            recipientAccountId: "owner",
        })).toEqual({
            metadata: "shared",
            metadataVersion: 3,
            metadataLayoutVersion: 1,
            ownerMetadata: OWNER_CIPHERTEXT,
            agentState: "full-owner-state",
            agentStateVersion: 7,
        });
        expect(projectSessionMetadataForRecipient({
            session: base,
            recipientAccountId: "recipient",
        })).toEqual({
            metadata: "shared",
            metadataVersion: 3,
            metadataLayoutVersion: 1,
            agentState: null,
            agentStateVersion: 7,
        });
        expect(projectSessionMetadataForRecipient({
            session: base,
            recipientAccountId: null,
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
        { metadataLayoutVersion: 1, ownerMetadata: "not-base64" },
        { metadataLayoutVersion: 1, ownerMetadata: "oQkBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==" },
        { metadataLayoutVersion: 2, ownerMetadata: OWNER_CIPHERTEXT },
    ])("fails a non-owner read closed for an incomplete/unsupported tuple %#", (override) => {
        expect(() => projectSessionMetadataForRecipient({
            session: { ...base, ...override },
            recipientAccountId: "recipient",
        })).toThrow(SessionMetadataPrivacyUpgradeRequiredError);
    });

    it("preserves the released layout-zero projection for owners, participants, and public readers", () => {
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
            recipientAccountId: "owner",
        })).toEqual(expected);
        expect(projectSessionMetadataForRecipient({
            session: legacy,
            recipientAccountId: "recipient",
        })).toEqual(expected);
        expect(projectSessionMetadataForRecipient({
            session: legacy,
            recipientAccountId: null,
        })).toEqual(expected);
    });

    it.each([
        {},
        { metadataLayoutVersion: null },
        { metadataLayoutVersion: 0 },
    ])("normalizes a missing/legacy layout marker for every released recipient %#", (override) => {
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
            recipientAccountId: "owner",
        })).toEqual(expected);
        expect(projectSessionMetadataForRecipient({
            session,
            recipientAccountId: "recipient",
        })).toEqual(expected);
        expect(projectSessionMetadataForRecipient({
            session,
            recipientAccountId: null,
        })).toEqual(expected);
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
                recipientAccountId,
            })).toThrow(SessionMetadataPrivacyUpgradeRequiredError);
        }
    });

    it("derives ownership only from the persisted owner account id", () => {
        expect(projectSessionMetadataForRecipient({
            session: {
                ...base,
                accountId: "actual-owner",
            },
            recipientAccountId: "claimed-owner",
        })).toEqual({
            metadata: "shared",
            metadataVersion: 3,
            metadataLayoutVersion: 1,
            agentState: null,
            agentStateVersion: 7,
        });
    });
});
