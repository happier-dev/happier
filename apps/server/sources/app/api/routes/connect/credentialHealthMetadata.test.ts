import { describe, expect, it } from "vitest";

import {
    deriveConnectedServiceCredentialStatus,
    parseQualifiedConnectedServiceCredentialStoredMetadataV4,
    withQualifiedConnectedServiceCredentialHealth,
} from "./credentialHealthMetadata";

const credentialRevision = "csr_abcdefghijklmnopqrstuvwxyz";

describe("qualified Connected Account credential health metadata", () => {
    it("stores health beside strict V4 presentation metadata without rotating the credential revision", () => {
        const current = parseQualifiedConnectedServiceCredentialStoredMetadataV4({
            v: 4,
            storage: "stored_envelope_v1",
            credentialRevision,
            values: {
                displayName: "Primary",
                scopes: ["account.read"],
            },
        });
        const next = withQualifiedConnectedServiceCredentialHealth(current, {
            v: 1,
            status: "needs_reauth",
            reconnectRequired: true,
            providerErrorCode: "invalid_grant",
        });

        expect(next).toEqual({
            ...current,
            health: {
                v: 1,
                status: "needs_reauth",
                reconnectRequired: true,
                providerErrorCode: "invalid_grant",
            },
        });
        expect(next.credentialRevision).toBe(credentialRevision);
        expect(deriveConnectedServiceCredentialStatus(next)).toBe(
            "needs_reauth",
        );
    });

    it("fails closed on unknown clear metadata and malformed health", () => {
        expect(() =>
            parseQualifiedConnectedServiceCredentialStoredMetadataV4({
                v: 4,
                storage: "stored_envelope_v1",
                credentialRevision,
                values: {
                    scopes: [],
                    accessToken: "must-not-be-clear",
                },
            }),
        ).toThrow();
        expect(() =>
            parseQualifiedConnectedServiceCredentialStoredMetadataV4({
                v: 4,
                storage: "stored_envelope_v1",
                credentialRevision,
                values: { scopes: [] },
                health: {
                    v: 1,
                    status: "unknown",
                },
            }),
        ).toThrow();
    });
});
