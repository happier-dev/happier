import { describe, expect, it } from "vitest";
import { QualifiedConnectedAccountCredentialMetadataV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { CONNECTED_ACCOUNT_ACCESS_ONLY_EXPORT_CONTRACT_V1 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';

import { resolveQualifiedConnectedAccountStoredMetadata } from "./credentialStoredMetadataAdapter";

describe("qualified Connected Account stored metadata adapter", () => {
    it("preserves the declared access-only contract on stored OAuth credentials", () => {
        expect(resolveQualifiedConnectedAccountStoredMetadata({
            rowId: "access-only-row",
            metadata: {
                v: 4,
                storage: "stored_envelope_v1",
                credentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
                directExportContract: CONNECTED_ACCOUNT_ACCESS_ONLY_EXPORT_CONTRACT_V1,
                contributionContractVersion: "artifact-access-only",
                values: { kind: "oauth", scopes: [] },
            },
        })).toMatchObject({
            kind: "oauth",
            directExportContract: CONNECTED_ACCOUNT_ACCESS_ONLY_EXPORT_CONTRACT_V1,
            contributionContractVersion: "artifact-access-only",
        });
    });

    it.each([
        {
            name: "raw",
            metadata: null,
            expected: {
                format: "legacy_unknown",
                kind: null,
                status: "needs_reauth",
                presentation: { scopes: [] },
            },
        },
        {
            name: "V2",
            metadata: {
                v: 2,
                format: "account_scoped_v1",
                kind: "oauth",
                providerEmail: "operator@example.com",
                providerAccountId: "provider-account-1",
                providerOrganizationId: "org-predecessor",
                health: {
                    v: 1,
                    status: "needs_reauth",
                    reconnectRequired: true,
                },
            },
            expected: {
                format: "legacy_v2",
                kind: "oauth",
                status: "needs_reauth",
                presentation: {
                    providerIdentity: {
                        email: "operator@example.com",
                        accountId: "provider-account-1",
                        organizationId: "org-predecessor",
                    },
                    scopes: [],
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
                providerOrganizationId: "org-predecessor",
                health: {
                    v: 1,
                    status: "needs_reauth",
                    reconnectRequired: true,
                },
            },
            expected: {
                format: "legacy_v3",
                kind: "oauth",
                status: "needs_reauth",
                presentation: {
                    providerIdentity: {
                        email: "operator@example.com",
                        accountId: "provider-account-1",
                        organizationId: "org-predecessor",
                    },
                    scopes: [],
                },
            },
        },
    ])("keeps an unfenced legacy $name row readable without fabricating a revision", ({
        metadata,
        expected,
    }) => {
        expect(resolveQualifiedConnectedAccountStoredMetadata({
            rowId: "legacy-row",
            metadata,
        })).toMatchObject({
            revisionSemantics: "legacy_unfenced",
            credentialRevision: null,
            ...expected,
        });
    });

    it("retains an explicit legacy revision as the guarded compatibility path", () => {
        const credentialRevision = "csr_abcdefghijklmnopqrstuvwxyz";
        expect(resolveQualifiedConnectedAccountStoredMetadata({
            rowId: "revisioned-v3-row",
            metadata: {
                v: 3,
                storage: "plain_json_v1",
                kind: "oauth",
                credentialRevision,
                providerEmail: null,
                providerAccountId: null,
            },
        })).toMatchObject({
            revisionSemantics: "revisioned",
            credentialRevision,
        });
    });

    it("keeps V4 writes strict while projecting stored fields and rejecting malformed known values", () => {
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
            revisionSemantics: "revisioned",
            credentialRevision: metadata.credentialRevision,
            status: "refreshing",
            presentation: metadata.values,
        });
        const valuesWithUnknownSecret = { ...metadata.values, accessToken: "must-not-be-clear" };
        expect(QualifiedConnectedAccountCredentialMetadataV4Schema.safeParse(valuesWithUnknownSecret).success).toBe(false);
        expect(resolveQualifiedConnectedAccountStoredMetadata({ rowId: "v4-row",
            metadata: { ...metadata, values: valuesWithUnknownSecret },
        }).presentation).toEqual(metadata.values);
        expect(() => resolveQualifiedConnectedAccountStoredMetadata({ rowId: "v4-row",
            metadata: { ...metadata, values: { ...metadata.values, scopes: [123] } },
        })).toThrow();
    });
});
