import { describe, expect, it } from "vitest";

import {
    deriveConnectedServiceCredentialStatus,
    QualifiedConnectedServiceCredentialStoredMetadataV4Schema,
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

    it("drops unknown stored metadata recursively without echoing clear credential fields", () => {
        const raw = {
                v: 4,
                storage: "stored_envelope_v1",
                credentialRevision,
                values: {
                    scopes: [],
                    accessToken: "must-not-be-clear",
                    providerIdentity: { email: "operator@example.test", future: true },
                },
                future: true,
                health: { v: 1, status: "connected", reconnectRequired: false, future: true },
        };
        const parsed = parseQualifiedConnectedServiceCredentialStoredMetadataV4(raw);
        expect(parsed).toEqual({ v: 4, storage: "stored_envelope_v1", credentialRevision,
            values: { scopes: [], providerIdentity: { email: "operator@example.test" } },
            health: { v: 1, status: "connected", reconnectRequired: false } });
        expect(() => QualifiedConnectedServiceCredentialStoredMetadataV4Schema.parse(raw)).toThrow();
        expect(withQualifiedConnectedServiceCredentialHealth(parsed, { v: 1, status: "needs_reauth", reconnectRequired: true }))
            .not.toHaveProperty("future");
    });

    it("fails closed on malformed known health", () => {
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
