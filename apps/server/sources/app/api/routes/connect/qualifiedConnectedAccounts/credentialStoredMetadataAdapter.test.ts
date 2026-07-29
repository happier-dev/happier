import { describe, expect, it } from "vitest";

import { resolveQualifiedConnectedAccountStoredMetadata } from "./credentialStoredMetadataAdapter";

describe("qualified Connected Account stored metadata adapter", () => {
    it.each([
        {
            name: "V2",
            metadata: {
                v: 2,
                format: "account_scoped_v1",
                kind: "oauth",
                providerEmail: "operator@example.com",
                providerAccountId: "provider-account-1",
                health: {
                    v: 1,
                    status: "needs_reauth",
                    reconnectRequired: true,
                },
            },
        },
        {
            name: "V3",
            metadata: {
                v: 3,
                storage: "plain_json_v1",
                kind: "oauth",
                providerEmail: "operator@example.com",
                providerAccountId: "provider-account-1",
                health: {
                    v: 1,
                    status: "needs_reauth",
                    reconnectRequired: true,
                },
            },
        },
    ])("translates activated legacy $name identity into V4 presentation", ({
        metadata,
    }) => {
        expect(resolveQualifiedConnectedAccountStoredMetadata({
            rowId: "legacy-row",
            metadata,
        })).toMatchObject({
            kind: "oauth",
            status: "needs_reauth",
            presentation: {
                providerIdentity: {
                    email: "operator@example.com",
                    accountId: "provider-account-1",
                },
                scopes: [],
            },
        });
    });

    it("preserves strict V4 metadata and fails closed on malformed V4", () => {
        const metadata = {
            v: 4,
            storage: "stored_envelope_v1",
            credentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
            values: {
                providerIdentity: {
                    email: "operator@example.com",
                },
                displayName: "Primary",
                scopes: ["account.read"],
            },
            health: {
                v: 1,
                status: "refreshing",
                reconnectRequired: false,
            },
        };
        expect(resolveQualifiedConnectedAccountStoredMetadata({
            rowId: "v4-row",
            metadata,
        })).toMatchObject({
            format: "v4",
            credentialRevision: metadata.credentialRevision,
            status: "refreshing",
            presentation: metadata.values,
        });
        expect(() =>
            resolveQualifiedConnectedAccountStoredMetadata({
                rowId: "v4-row",
                metadata: {
                    ...metadata,
                    values: {
                        ...metadata.values,
                        accessToken: "must-not-be-clear",
                    },
                },
            }),
        ).toThrow();
    });
});
