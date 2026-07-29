import { describe, expect, it } from "vitest";

import { settleQualifiedConnectedAccountCredentialMetadata } from "./credentialMetadataSettlement";

const current = {
    providerIdentity: {
        accountId: "provider-account-1",
        email: "operator@example.com",
    },
    displayName: "Old name",
    scopes: ["account.read"],
};

describe("qualified Connected Account credential metadata settlement", () => {
    it("preserves established provider identity when reconnect omits it", () => {
        expect(settleQualifiedConnectedAccountCredentialMetadata({
            current,
            incoming: {
                displayName: "New name",
                scopes: ["account.read", "account.write"],
            },
            allowProviderIdentityChange: false,
        })).toEqual({
            status: "settled",
            metadata: {
                providerIdentity: current.providerIdentity,
                displayName: "New name",
                scopes: ["account.read", "account.write"],
            },
        });
    });

    it("requires confirmation for explicit identity replacement or loss", () => {
        for (const providerIdentity of [
            { accountId: "provider-account-2" },
            { accountId: null },
            { email: "other@example.com" },
            { email: null },
        ] as const) {
            expect(settleQualifiedConnectedAccountCredentialMetadata({
                current,
                incoming: { providerIdentity, scopes: [] },
                allowProviderIdentityChange: false,
            })).toEqual({ status: "provider_identity_mismatch" });
        }

        expect(settleQualifiedConnectedAccountCredentialMetadata({
            current,
            incoming: {
                providerIdentity: { accountId: "provider-account-2" },
                scopes: [],
            },
            allowProviderIdentityChange: true,
        })).toEqual({
            status: "settled",
            metadata: {
                providerIdentity: {
                    accountId: "provider-account-2",
                    email: "operator@example.com",
                },
                scopes: [],
            },
        });
        expect(settleQualifiedConnectedAccountCredentialMetadata({
            current,
            incoming: {
                providerIdentity: {
                    accountId: null,
                    email: null,
                },
                scopes: [],
            },
            allowProviderIdentityChange: true,
        })).toEqual({
            status: "settled",
            metadata: {
                providerIdentity: {
                    accountId: null,
                    email: null,
                },
                scopes: [],
            },
        });
    });
});
