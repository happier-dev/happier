import { db } from "@/storage/db";
import { getPublicUrl } from "@/storage/blob/files";
import { fetchLinkedProvidersForAccount } from "@/app/auth/providers/linkedProviders";
import { type Fastify } from "../../types";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { ConnectedServiceIdSchema } from "@happier-dev/protocol";
import { isConnectedServiceCredentialMetadataV2 } from "../connect/connectedServicesV2/credentialMetadataV2";
import { resolveRouteRateLimit } from "@/app/api/utils/apiRateLimitPolicy";

export function registerAccountProfileRoute(app: Fastify): void {
    app.get('/v1/account/profile', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveRouteRateLimit(process.env, {
                maxEnvKey: "HAPPIER_ACCOUNT_PROFILE_RATE_LIMIT_MAX",
                windowEnvKey: "HAPPIER_ACCOUNT_PROFILE_RATE_LIMIT_WINDOW",
                defaultMax: 300,
                defaultWindow: "1 minute",
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const user = await db.account.findUniqueOrThrow({
            where: { id: userId },
            select: {
                firstName: true,
                lastName: true,
                username: true,
                avatar: true,
            }
        });

        const connectedServicesEnabled = isServerFeatureEnabledForRequest("connectedServices", process.env);

        const tokens = connectedServicesEnabled
            ? await db.serviceAccountToken.findMany({
                where: { accountId: userId },
                select: {
                    vendor: true,
                    profileId: true,
                    metadata: true,
                    expiresAt: true,
                    lastUsedAt: true,
                },
            })
            : [];

        const connectedVendors = connectedServicesEnabled
            ? new Set(
                tokens
                    .filter((t) => t.profileId === "default")
                    .map((t) => t.vendor)
                    .filter((vendor) => vendor === "openai" || vendor === "anthropic" || vendor === "gemini"),
            )
            : new Set<string>();

        const connectedServicesV2 = connectedServicesEnabled
            ? Array.from(
                tokens.reduce((acc, row) => {
                    const parsedServiceId = ConnectedServiceIdSchema.safeParse(row.vendor);
                    if (!parsedServiceId.success) {
                        return acc;
                    }
                    const serviceId = parsedServiceId.data;
                    const key = serviceId;
                    const list =
                        acc.get(key) ??
                        ([] as Array<{
                            profileId: string;
                            status: "connected" | "needs_reauth";
                            kind: "oauth" | "token" | null;
                            providerEmail: string | null;
                            providerAccountId: string | null;
                            expiresAt: number | null;
                            lastUsedAt: number | null;
                        }>);
                    const meta = isConnectedServiceCredentialMetadataV2(row.metadata) ? row.metadata : null;
                    list.push({
                        profileId: row.profileId,
                        status: meta ? "connected" : "needs_reauth",
                        kind: meta?.kind ?? null,
                        providerEmail: meta?.providerEmail ?? null,
                        providerAccountId: meta?.providerAccountId ?? null,
                        expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
                        lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
                    });
                    acc.set(key, list);
                    return acc;
                }, new Map<string, Array<{
                    profileId: string;
                    status: "connected" | "needs_reauth";
                    kind: "oauth" | "token" | null;
                    providerEmail: string | null;
                    providerAccountId: string | null;
                    expiresAt: number | null;
                    lastUsedAt: number | null;
                }>>()),
            ).map(([serviceId, profiles]) => ({
                serviceId,
                profiles,
            }))
            : [];
        const linkedProviders = await fetchLinkedProvidersForAccount({ tx: db as any, accountId: userId });
        return reply.send({
            id: userId,
            timestamp: Date.now(),
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            avatar: user.avatar ? { ...user.avatar, url: getPublicUrl(user.avatar.path) } : null,
            linkedProviders,
            connectedServices: connectedServicesEnabled ? Array.from(connectedVendors) : [],
            connectedServicesV2,
        });
    });
}
