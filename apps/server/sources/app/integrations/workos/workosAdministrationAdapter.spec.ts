import { describe, expect, it, vi } from "vitest";

import { createWorkosAdministrationAdapter } from "./workosAdministrationAdapter";

describe("WorkOS administration adapter", () => {
    it("keeps Home organization recovery distinct from every Team namespace", async () => {
        const getOrganizationByExternalId = vi.fn().mockResolvedValue({ id: "org_home", name: "Company" });
        const adapter = createWorkosAdministrationAdapter({ organizations: { getOrganizationByExternalId } } as never);
        await expect(adapter.ensureOrganization({
            homeServerIdentityId: "server_exact", teamId: null, teamName: "Company",
        })).resolves.toEqual({ id: "org_home", name: "Company" });
        expect(getOrganizationByExternalId).toHaveBeenCalledWith("happier:server_exact:home");
    });
    it("uses only verified domains from the exact live WorkOS Organization", async () => {
        const getOrganization = vi.fn().mockResolvedValue({
            id: "org_exact", name: "Acme", domains: [
                { domain: "Acme.Example", organizationId: "org_exact", state: "verified" },
                { domain: "pending.example", organizationId: "org_exact", state: "pending" },
                { domain: "failed.example", organizationId: "org_exact", state: "failed" },
                { domain: "unverified.example", organizationId: "org_exact" },
            ],
        });
        // WorkOS SDK is the external boundary; the adapter's validation stays real.
        const adapter = createWorkosAdministrationAdapter({ organizations: { getOrganization } } as never);
        await expect(adapter.getVerifiedOrganizationDomains("org_exact")).resolves.toEqual(["acme.example"]);
        getOrganization.mockResolvedValueOnce({ id: "org_other", name: "Other", domains: [] });
        await expect(adapter.getVerifiedOrganizationDomains("org_exact"))
            .rejects.toThrow("workos_organization_mismatch");
        getOrganization.mockResolvedValueOnce({ id: "org_exact", name: "Acme", domains: [
            { domain: "wrong.example", state: "verified", organizationId: "org_other" },
        ] });
        await expect(adapter.getVerifiedOrganizationDomains("org_exact"))
            .rejects.toThrow("workos_organization_mismatch");
        getOrganization.mockRejectedValueOnce({ status: 503 });
        await expect(adapter.getVerifiedOrganizationDomains("org_exact"))
            .rejects.toEqual({ status: 503 });
    });
    it("ensures the deterministic external organization and rereads after a create conflict", async () => {
        const getOrganizationByExternalId = vi.fn()
            .mockRejectedValueOnce({ status: 404 })
            .mockResolvedValueOnce({ id: "org_exact", name: "Acme" });
        const createOrganization = vi.fn().mockRejectedValue({ status: 409 });
        const adapter = createWorkosAdministrationAdapter({
            organizations: { getOrganizationByExternalId, createOrganization },
            adminPortal: { generateLink: vi.fn() },
            sso: { listConnections: vi.fn(), getConnection: vi.fn() },
        } as never);

        await expect(adapter.ensureOrganization({
            homeServerIdentityId: "srv_home",
            teamId: "team_acme",
            teamName: "Acme",
        })).resolves.toEqual({ id: "org_exact", name: "Acme" });
        expect(getOrganizationByExternalId).toHaveBeenNthCalledWith(
            1,
            "happier:srv_home:team:team_acme",
        );
        expect(createOrganization).toHaveBeenCalledWith(
            { name: "Acme", externalId: "happier:srv_home:team:team_acme" },
            { idempotencyKey: expect.any(String) },
        );
        expect(getOrganizationByExternalId).toHaveBeenCalledTimes(2);
    });

    it("creates an immediate portal link and bounds SSO candidates to the exact organization", async () => {
        const generateLink = vi.fn().mockResolvedValue({ link: "https://setup.workos.test/portal" });
        const listConnections = vi.fn().mockResolvedValue({
            data: [
                { id: "conn_1", organizationId: "org_exact", name: "Acme Okta", type: "OktaSAML", state: "active" },
                { id: "conn_wrong", organizationId: "org_other", name: "Wrong", type: "SAML", state: "active" },
            ],
            listMetadata: { after: null },
        });
        const adapter = createWorkosAdministrationAdapter({
            organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
            adminPortal: { generateLink },
            sso: { listConnections, getConnection: vi.fn() },
        } as never);

        await expect(adapter.createAdminPortalLink({
            organizationId: "org_exact",
            intent: "sso",
            returnUrl: "https://app.example.test/teams/team-1/authentication",
        })).resolves.toBe("https://setup.workos.test/portal");
        expect(generateLink).toHaveBeenCalledWith({
            organization: "org_exact",
            intent: "sso",
            returnUrl: "https://app.example.test/teams/team-1/authentication",
        });
        await expect(adapter.listSsoConnections("org_exact")).resolves.toEqual([{
            connectionId: "conn_1",
            displayName: "Acme Okta",
            strategy: "OktaSAML",
            status: "active",
        }]);
        expect(listConnections).toHaveBeenCalledWith({ organizationId: "org_exact", limit: 100 });
    });

    it("exhausts every WorkOS connection page without a local result ceiling", async () => {
        const firstPage = Array.from({ length: 100 }, (_, index) => ({
            id: `conn_${index}`,
            organizationId: "org_exact",
            name: `Connection ${index}`,
            type: "SAML",
            state: "active",
        }));
        const secondPage = Array.from({ length: 100 }, (_, index) => ({
            id: `conn_${index + 100}`,
            organizationId: "org_exact",
            name: `Connection ${index + 100}`,
            type: "SAML",
            state: "active",
        }));
        const listConnections = vi.fn()
            .mockResolvedValueOnce({ data: firstPage, listMetadata: { after: "page_2" } })
            .mockResolvedValueOnce({ data: secondPage, listMetadata: { after: "page_3" } })
            .mockResolvedValueOnce({
                data: Array.from({ length: 3 }, (_, index) => ({
                    id: `conn_${index + 200}`,
                    organizationId: "org_exact",
                    name: `Connection ${index + 200}`,
                    type: "SAML",
                    state: "active",
                })),
                listMetadata: {},
            });
        const adapter = createWorkosAdministrationAdapter({
            organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
            adminPortal: { generateLink: vi.fn() },
            sso: { listConnections, getConnection: vi.fn() },
        } as never);

        const result = await adapter.listSsoConnections("org_exact");

        expect(result).toHaveLength(203);
        expect(result.at(-1)).toMatchObject({ connectionId: "conn_202" });
        expect(listConnections).toHaveBeenNthCalledWith(1, {
            organizationId: "org_exact",
            limit: 100,
        });
        expect(listConnections).toHaveBeenNthCalledWith(2, {
            organizationId: "org_exact",
            limit: 100,
            after: "page_2",
        });
        expect(listConnections).toHaveBeenNthCalledWith(3, {
            organizationId: "org_exact",
            limit: 100,
            after: "page_3",
        });
    });

    it("rejects a WorkOS connection page without list metadata", async () => {
        const adapter = createWorkosAdministrationAdapter({
            organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
            adminPortal: { generateLink: vi.fn() },
            sso: { listConnections: vi.fn().mockResolvedValue({ data: [] }), getConnection: vi.fn() },
        } as never);

        await expect(adapter.listSsoConnections("org_exact")).rejects.toThrow("workos_invalid_response");
    });

    it.each([
        { label: "blank", after: "   " },
        { label: "non-string", after: 123 },
    ])("rejects a $label nonterminal WorkOS cursor", async ({ after }) => {
        const adapter = createWorkosAdministrationAdapter({
            organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
            adminPortal: { generateLink: vi.fn() },
            sso: {
                listConnections: vi.fn().mockResolvedValue({ data: [], listMetadata: { after } }),
                getConnection: vi.fn(),
            },
        } as never);

        await expect(adapter.listSsoConnections("org_exact")).rejects.toThrow("workos_invalid_response");
    });

    it("rejects a WorkOS cursor that repeats on the next page", async () => {
        const listConnections = vi.fn()
            .mockResolvedValueOnce({ data: [], listMetadata: { after: "page_2" } })
            .mockResolvedValueOnce({ data: [], listMetadata: { after: "page_2" } });
        const adapter = createWorkosAdministrationAdapter({
            organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
            adminPortal: { generateLink: vi.fn() },
            sso: { listConnections, getConnection: vi.fn() },
        } as never);

        await expect(adapter.listSsoConnections("org_exact")).rejects.toThrow("workos_invalid_response");
        expect(listConnections).toHaveBeenCalledTimes(2);
    });

    it("rejects a multi-page WorkOS cursor cycle", async () => {
        const listConnections = vi.fn()
            .mockResolvedValueOnce({ data: [], listMetadata: { after: "page_a" } })
            .mockResolvedValueOnce({ data: [], listMetadata: { after: "page_b" } })
            .mockResolvedValueOnce({ data: [], listMetadata: { after: "page_a" } });
        const adapter = createWorkosAdministrationAdapter({
            organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
            adminPortal: { generateLink: vi.fn() },
            sso: { listConnections, getConnection: vi.fn() },
        } as never);

        await expect(adapter.listSsoConnections("org_exact")).rejects.toThrow("workos_invalid_response");
        expect(listConnections).toHaveBeenCalledTimes(3);
    });

    it("rejects exact-connection selection when WorkOS returns a different organization", async () => {
        const getConnection = vi.fn().mockResolvedValue({
            id: "conn_1",
            organizationId: "org_other",
            name: "Wrong tenant",
            type: "SAML",
            state: "active",
        });
        const adapter = createWorkosAdministrationAdapter({
            organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
            adminPortal: { generateLink: vi.fn() },
            sso: { listConnections: vi.fn(), getConnection },
        } as never);
        await expect(adapter.getSsoConnection({
            organizationId: "org_exact",
            connectionId: "conn_1",
        })).rejects.toThrow("workos_organization_mismatch");
    });

    it("deletes only an exact same-organization SSO connection and treats exact 404 as already absent", async () => {
        const getConnection = vi.fn()
            .mockResolvedValueOnce({
                id: "conn_exact",
                organizationId: "org_exact",
                name: "Acme Okta",
                type: "OktaSAML",
                state: "active",
            })
            .mockRejectedValueOnce({ status: 404 });
        const deleteConnection = vi.fn().mockResolvedValue(undefined);
        const adapter = createWorkosAdministrationAdapter({
            organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
            adminPortal: { generateLink: vi.fn() },
            sso: { listConnections: vi.fn(), getConnection, deleteConnection },
        } as never);

        await expect(adapter.deleteSsoConnection({
            organizationId: "org_exact",
            connectionId: "conn_exact",
        })).resolves.toBe("deleted");
        expect(deleteConnection).toHaveBeenCalledWith("conn_exact");

        await expect(adapter.deleteSsoConnection({
            organizationId: "org_exact",
            connectionId: "conn_exact",
        })).resolves.toBe("already_absent");
        expect(deleteConnection).toHaveBeenCalledTimes(1);
    });

    it("preserves an SSO connection when the exact lookup resolves to another organization", async () => {
        const deleteConnection = vi.fn();
        const adapter = createWorkosAdministrationAdapter({
            organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
            adminPortal: { generateLink: vi.fn() },
            sso: {
                listConnections: vi.fn(),
                getConnection: vi.fn().mockResolvedValue({
                    id: "conn_exact",
                    organizationId: "org_other",
                    name: "Wrong tenant",
                    type: "SAML",
                    state: "active",
                }),
                deleteConnection,
            },
        } as never);

        await expect(adapter.deleteSsoConnection({
            organizationId: "org_exact",
            connectionId: "conn_exact",
        })).rejects.toThrow("workos_organization_mismatch");
        expect(deleteConnection).not.toHaveBeenCalled();
    });
});
