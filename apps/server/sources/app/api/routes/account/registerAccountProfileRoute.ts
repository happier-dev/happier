import { db } from "@/storage/db";
import { ANTIGRAVITY_ACCOUNT_PROFILE_ACCEPT } from '@happier-dev/protocol';
import { getPublicUrl } from "@/storage/blob/files";
import { fetchLinkedProvidersForAccount } from "@/app/auth/providers/linkedProviders";
import { type Fastify } from "../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    buildAccountConnectedServicesProjection,
    type ConnectedServicesProjectionClient,
} from "./connectedServicesProfileProjection";

/** Recognizes explicit JSON-reader opt-in while preserving released clients' closed service list. */
function acceptsAntigravityProfile(accept: string | undefined): boolean {
    if (!accept) return false;
    const [expectedMediaType, expectedParameter] = ANTIGRAVITY_ACCOUNT_PROFILE_ACCEPT.split(';').map((part) => part.trim());
    const [expectedName, expectedValue] = expectedParameter.split('=');
    // Split media ranges and parameters outside quoted strings so a quoted note
    // cannot opt a reader into a service its account schema does not recognize.
    const ranges = accept.match(/(?:[^,"]|"(?:[^"\\]|\\.)*")+/g) ?? [];
    if (ranges.join(',') !== accept) return false;
    return ranges.some((range) => {
        const parts = range.match(/(?:[^;"]|"(?:[^"\\]|\\.)*")+/g) ?? [];
        if (parts.join(';') !== range) return false;
        if (parts.shift()?.trim().toLowerCase() !== expectedMediaType) return false;
        const parameters = new Map<string, string>();
        for (const part of parts) {
            const parameter = /^\s*([!#$%&'*+.^_`|~\w-]+)\s*=\s*([^\s"]+|"(?:[^"\\]|\\.)*")\s*$/.exec(part);
            if (!parameter) return false;
            const name = parameter[1].toLowerCase();
            if (parameters.has(name)) return false;
            const raw = parameter[2];
            parameters.set(name, raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw);
        }
        const quality = parameters.get('q');
        if (quality !== undefined && (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(quality) || Number(quality) === 0)) return false;
        return parameters.get(expectedName) === expectedValue;
    });
}

export function registerAccountProfileRoute(app: Fastify): void {
    app.get('/v1/account/profile', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.profile"),
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

        const connectedServicesProjection = await buildAccountConnectedServicesProjection({
            tx: db as unknown as ConnectedServicesProjectionClient,
            accountId: userId,
            includeAntigravity: acceptsAntigravityProfile(request.headers.accept),
        });
        const linkedProviders = await fetchLinkedProvidersForAccount({ tx: db as any, accountId: userId });
        return reply.send({
            id: userId,
            timestamp: Date.now(),
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            avatar: user.avatar ? { ...user.avatar, url: getPublicUrl(user.avatar.path) } : null,
            linkedProviders,
            connectedServices: connectedServicesProjection.connectedServices,
            connectedServicesV2: connectedServicesProjection.connectedServicesV2,
            connectedServiceCredentialRevisionsV1: connectedServicesProjection.connectedServiceCredentialRevisionsV1,
        });
    });
}
