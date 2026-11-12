import { describe, expect, it } from "vitest";

import {
    deriveConnectedServiceCredentialStatus,
    QualifiedConnectedServiceCredentialStoredMetadataV4Schema,
    parseQualifiedConnectedServiceCredentialStoredMetadataV4,
    withQualifiedConnectedServiceCredentialHealth,
} from "./credentialHealthMetadata";

const credentialRevision = "csr_abcdefghijklmnopqrstuvwxyz";

describe("qualified Connected Account credential health metadata", () => {
    it("publishes a source-owned export refusal independently of authentication and clears it after recovery", () => {
        const current = parseQualifiedConnectedServiceCredentialStoredMetadataV4({
            v: 4, storage: "stored_envelope_v1", credentialRevision, values: { scopes: [] },
        });
        const projection = {
            directExportContract: 'happier.team-credential-access-only-connected-account-direct.v1' as const,
            contributionContractVersion: 'test-contribution',
            directExportFailure: { code: 'access_only_expiry_unavailable' as const,
                message: "This imported Muse login doesn't report when it expires. Reconnect it with Meta sign-in to share it natively." },
        };
        const health = { v: 1 as const, status: 'connected' as const, reconnectRequired: false };
        const unavailable = withQualifiedConnectedServiceCredentialHealth(current, health, projection);
        expect(unavailable).toMatchObject({ directExportFailure: projection.directExportFailure });
        expect(deriveConnectedServiceCredentialStatus(unavailable)).toBe('connected');
        const { directExportFailure: _failure, ...recovered } = projection;
        expect(withQualifiedConnectedServiceCredentialHealth(unavailable, health, recovered))
            .not.toHaveProperty('directExportFailure');
    });
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
