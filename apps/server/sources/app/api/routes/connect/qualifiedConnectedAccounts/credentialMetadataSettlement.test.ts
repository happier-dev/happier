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
    it('clears the previous sign-in provenance when re-authentication omits provenance', () => {
        const result = settleQualifiedConnectedAccountCredentialMetadata({
            current: { ...current, authenticationProvenance: {
                authenticatedAt: 1_000, machine: { serverId: 'home-a', machineId: 'machine-a' },
            } },
            incoming: current,
            allowProviderIdentityChange: false,
        });
        expect(result).toEqual({ status: 'settled', metadata: current });
    });

    it('records fresh re-authentication provenance for the same provider identity', () => {
        const authenticationProvenance = {
            authenticatedAt: 2_000, machine: { serverId: 'home-b', machineId: 'machine-b' },
        };
        expect(settleQualifiedConnectedAccountCredentialMetadata({
            current: { ...current, authenticationProvenance: {
                authenticatedAt: 1_000, machine: { serverId: 'home-a', machineId: 'machine-a' },
            } },
            incoming: { ...current, authenticationProvenance },
            allowProviderIdentityChange: false,
        })).toEqual({ status: 'settled', metadata: { ...current, authenticationProvenance } });
    });

    it('preserves refresh history without manufacturing or replacing sign-in provenance', () => {
        const authenticationProvenance = { authenticatedAt: 1_000, machine: { serverId: 'home-a', machineId: 'machine-a' } };
        const known = { ...current, authenticationProvenance };
        expect(settleQualifiedConnectedAccountCredentialMetadata({ current: known, incoming: current,
            allowProviderIdentityChange: false, preserveAuthenticationProvenance: true }))
            .toMatchObject({ status: 'settled', metadata: { authenticationProvenance } });
        const refresh = { current: known, incoming: { ...current,
            authenticationProvenance: { authenticatedAt: 2_000, machine: { serverId: 'other-home', machineId: 'other-machine' } } },
            allowProviderIdentityChange: false, preserveAuthenticationProvenance: true };
        expect(settleQualifiedConnectedAccountCredentialMetadata(refresh))
            .toMatchObject({ status: 'settled', metadata: { authenticationProvenance } });
        expect(settleQualifiedConnectedAccountCredentialMetadata({ ...refresh, current, incoming: refresh.incoming }))
            .toEqual({ status: 'settled', metadata: current });
        expect(settleQualifiedConnectedAccountCredentialMetadata({ ...refresh, preserveAuthenticationProvenance: false }))
            .toMatchObject({ status: 'settled', metadata: { authenticationProvenance: refresh.incoming.authenticationProvenance } });
        const replacement = settleQualifiedConnectedAccountCredentialMetadata({ current: known,
            incoming: { scopes: [], providerIdentity: { accountId: 'different-provider-account' } }, allowProviderIdentityChange: true });
        expect(replacement.status).toBe('settled');
        if (replacement.status !== 'settled') throw new Error('Expected explicit identity replacement');
        expect(replacement.metadata).not.toHaveProperty('authenticationProvenance');
    });

    it('admits fresh identity attestation after explicitly unknown identity', () => {
        expect(settleQualifiedConnectedAccountCredentialMetadata({
            current: { scopes: [], providerIdentity: { accountId: null, email: null, organizationId: null } },
            incoming: { ...current, providerIdentity: { ...current.providerIdentity, organizationId: 'org-a' } },
            allowProviderIdentityChange: false,
        })).toEqual({ status: 'settled', metadata: { ...current,
            providerIdentity: { ...current.providerIdentity, organizationId: 'org-a' } } });
    });

    it('preserves omitted organization context and replaces explicit context without inheriting an old organization', () => {
        const known = { ...current, providerIdentity: { ...current.providerIdentity, organizationId: 'org-a' } };
        for (const [incomingIdentity, expectedOrganization] of [
            [undefined, 'org-a'],
            [{ accountId: current.providerIdentity.accountId, organizationId: 'org-b' }, 'org-b'],
            [{ accountId: current.providerIdentity.accountId }, undefined],
        ] as const) {
            const result = settleQualifiedConnectedAccountCredentialMetadata({
                current: known,
                incoming: { scopes: [], ...(incomingIdentity ? { providerIdentity: incomingIdentity } : {}) },
                allowProviderIdentityChange: false,
            });
            expect(result.status).toBe('settled');
            if (result.status !== 'settled') throw new Error('Expected metadata settlement');
            expect(result.metadata.providerIdentity).toEqual({
                ...current.providerIdentity,
                ...(expectedOrganization ? { organizationId: expectedOrganization } : {}),
            });
        }
    });

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
