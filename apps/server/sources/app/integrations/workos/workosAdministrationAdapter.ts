import type { WorkOS } from "@workos-inc/node";
import { computeCanonicalDomainSeparatedDigest } from "@happier-dev/protocol/crypto/canonicalDigest";
import { normalizeVerifiedEmail } from "@happier-dev/protocol/auth/verifiedEmail";

export type WorkosSsoConnectionCandidate = Readonly<{
    connectionId: string;
    displayName: string;
    strategy: string;
    status: string;
}>;

type WorkosConnectionPage = Readonly<{
    data: readonly unknown[];
    nextCursor: string | null;
}>;

function normalizeConnectionPage(value: unknown): WorkosConnectionPage {
    if (
        !value
        || typeof value !== "object"
        || !("data" in value)
        || !Array.isArray(value.data)
        || !("listMetadata" in value)
        || !value.listMetadata
        || typeof value.listMetadata !== "object"
        || Array.isArray(value.listMetadata)
    ) {
        throw new Error("workos_invalid_response");
    }
    const after = "after" in value.listMetadata ? value.listMetadata.after : undefined;
    if (after !== undefined && after !== null && (typeof after !== "string" || after.trim().length === 0)) {
        throw new Error("workos_invalid_response");
    }
    return { data: value.data, nextCursor: after ?? null };
}

function errorStatus(error: unknown): number | null {
    if (!error || typeof error !== "object") return null;
    const status = "status" in error ? error.status : "statusCode" in error ? error.statusCode : null;
    return typeof status === "number" ? status : null;
}

function bounded(value: unknown, max: number): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized && normalized.length <= max ? normalized : null;
}

function normalizeOrganization(value: unknown): Readonly<{ id: string; name: string }> {
    if (!value || typeof value !== "object") throw new Error("workos_invalid_response");
    const id = bounded("id" in value ? value.id : null, 512);
    const name = bounded("name" in value ? value.name : null, 256);
    if (!id || !name) throw new Error("workos_invalid_response");
    return { id, name };
}

function normalizeConnection(value: unknown): Readonly<WorkosSsoConnectionCandidate & { organizationId: string }> {
    if (!value || typeof value !== "object") throw new Error("workos_invalid_response");
    const connectionId = bounded("id" in value ? value.id : null, 512);
    const organizationId = bounded("organizationId" in value ? value.organizationId : null, 512);
    const displayName = bounded("name" in value ? value.name : null, 256);
    const strategy = bounded("type" in value ? value.type : null, 256);
    const status = bounded("state" in value ? value.state : null, 256);
    if (!connectionId || !organizationId || !displayName || !strategy || !status) {
        throw new Error("workos_invalid_response");
    }
    return { connectionId, organizationId, displayName, strategy, status };
}

export function createWorkosAdministrationAdapter(client: WorkOS) {
    return Object.freeze({
        /** Live routing facts only; Organization/domain identity must match the exact binding. */
        async getVerifiedOrganizationDomains(organizationId: string): Promise<readonly string[]> {
            const organization = await client.organizations.getOrganization(organizationId);
            if (organization.id !== organizationId) throw new Error("workos_organization_mismatch");
            if (!Array.isArray(organization.domains)) throw new Error("workos_invalid_response");
            const domains = new Set<string>();
            for (const domain of organization.domains) {
                // WorkOS Node 10.13 OrganizationDomain.state is verified/pending/failed.
                // Only verified Organization domains can narrow Home sign-in choices.
                if (domain.state !== "verified") continue;
                if (domain.organizationId !== organizationId) throw new Error("workos_organization_mismatch");
                if (typeof domain.domain !== "string") throw new Error("workos_invalid_response");
                const normalized = normalizeVerifiedEmail(`routing@${domain.domain}`);
                if (!normalized) throw new Error("workos_invalid_response");
                domains.add(normalized.normalizedEmail.slice(normalized.normalizedEmail.lastIndexOf("@") + 1));
            }
            return [...domains];
        },

        async ensureOrganization(input: Readonly<{
            homeServerIdentityId: string;
            teamId: string | null;
            teamName: string;
        }>): Promise<Readonly<{ id: string; name: string }>> {
            const externalId = input.teamId === null
                ? `happier:${input.homeServerIdentityId}:home`
                : `happier:${input.homeServerIdentityId}:team:${input.teamId}`;
            try {
                return normalizeOrganization(await client.organizations.getOrganizationByExternalId(externalId));
            } catch (error) {
                if (errorStatus(error) !== 404) throw error;
            }
            try {
                return normalizeOrganization(await client.organizations.createOrganization(
                    { name: input.teamName, externalId },
                    {
                        idempotencyKey: computeCanonicalDomainSeparatedDigest(
                            "happier.workos.organization.create.v1",
                            [externalId],
                        ),
                    },
                ));
            } catch (error) {
                if (errorStatus(error) !== 409) throw error;
                return normalizeOrganization(await client.organizations.getOrganizationByExternalId(externalId));
            }
        },

        async createAdminPortalLink(input: Readonly<{
            organizationId: string;
            intent: "sso" | "dsync";
            returnUrl: string;
        }>): Promise<string> {
            const result = await client.adminPortal.generateLink({
                organization: input.organizationId,
                intent: input.intent,
                returnUrl: input.returnUrl,
            });
            const link = bounded(result.link, 4096);
            if (!link) throw new Error("workos_invalid_response");
            const parsed = new URL(link);
            if (parsed.protocol !== "https:") throw new Error("workos_invalid_response");
            return parsed.toString();
        },

        async listSsoConnections(organizationId: string): Promise<readonly WorkosSsoConnectionCandidate[]> {
            const candidates: WorkosSsoConnectionCandidate[] = [];
            const observedCursors = new Set<string>();
            let after: string | null = null;
            do {
                const result = normalizeConnectionPage(await client.sso.listConnections({
                    organizationId,
                    limit: 100,
                    ...(after === null ? {} : { after }),
                }));
                for (const raw of result.data) {
                    const connection = normalizeConnection(raw);
                    if (connection.organizationId !== organizationId) continue;
                    candidates.push({
                        connectionId: connection.connectionId,
                        displayName: connection.displayName,
                        strategy: connection.strategy,
                        status: connection.status,
                    });
                }
                const next = result.nextCursor;
                if (next !== null && observedCursors.has(next)) {
                    throw new Error("workos_invalid_response");
                }
                if (next !== null) observedCursors.add(next);
                after = next;
            } while (after !== null);
            return candidates;
        },

        async getSsoConnection(input: Readonly<{
            organizationId: string;
            connectionId: string;
        }>): Promise<WorkosSsoConnectionCandidate> {
            const connection = normalizeConnection(await client.sso.getConnection(input.connectionId));
            if (connection.organizationId !== input.organizationId) {
                throw new Error("workos_organization_mismatch");
            }
            return {
                connectionId: connection.connectionId,
                displayName: connection.displayName,
                strategy: connection.strategy,
                status: connection.status,
            };
        },

        async deleteSsoConnection(input: Readonly<{
            organizationId: string;
            connectionId: string;
        }>): Promise<"deleted" | "already_absent"> {
            try {
                const connection = normalizeConnection(await client.sso.getConnection(input.connectionId));
                if (connection.organizationId !== input.organizationId) {
                    throw new Error("workos_organization_mismatch");
                }
            } catch (error) {
                if (errorStatus(error) === 404) return "already_absent";
                throw error;
            }
            try {
                await client.sso.deleteConnection(input.connectionId);
                return "deleted";
            } catch (error) {
                if (errorStatus(error) === 404) return "already_absent";
                throw error;
            }
        },
    });
}
