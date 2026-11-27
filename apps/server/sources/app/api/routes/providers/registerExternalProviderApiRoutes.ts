import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import * as privacyKit from "privacy-kit";

import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_API_BASE_PATH_V1, TEAM_CREDENTIAL_EXTERNAL_PROVIDER_HTTP_ROUTES_V1, TeamCredentialExternalProviderApplicationRequestV1Schema, TeamCredentialExternalProviderErrorV1Schema, TeamCredentialExternalProviderRequestHeadersV1Schema, type TeamCredentialExternalProviderApplicationRequestV1, type TeamCredentialExternalProviderErrorCodeV1 } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import { resolveTeamCredentialExternalApiAvailability } from '@happier-dev/protocol/features/payload/capabilities/teamCredentialCapabilities';
import type { Fastify } from "@/app/api/types";
import { readHomeEffectiveEnv, resolveServerFeaturesForGating } from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { inTx } from "@/storage/inTx";
import { getMachineDaemonPresenceInventory } from "@/app/machines/machineDaemonPresence";
import {
    readTeamCredentialExternalBrokerOpenInTx,
    resolveTeamCredentialExternalBrokerPlacement,
    type ExternalBrokerPoolSourceEligibilityReader,
} from "@/app/teams/credentials/externalBrokerPlacement";
import { createTeamCredentialPoolSourceEligibilityReader } from "@/app/teams/credentials/poolSourceEligibility";

type HeaderValue = string | readonly string[] | undefined;

export function readExternalProviderApiCredential(
    headers: Readonly<Record<string, HeaderValue>>,
    rawHeaders: readonly string[] = [],
): string | null {
    const credentialHeaderCounts = new Map<string, number>();
    for (let index = 0; index < rawHeaders.length; index += 2) {
        const name = rawHeaders[index]?.toLowerCase();
        if (name === "authorization" || name === "x-api-key") {
            credentialHeaderCounts.set(name, (credentialHeaderCounts.get(name) ?? 0) + 1);
        }
    }
    if ([...credentialHeaderCounts.values()].some((count) => count > 1)) return null;
    const authorization = headers.authorization;
    const secondary = headers["x-api-key"];
    if ((authorization !== undefined && typeof authorization !== "string")
        || (secondary !== undefined && typeof secondary !== "string")) return null;
    let bearer: string | null = null;
    if (typeof authorization === "string") {
        const match = /^Bearer ([^\s]+)$/u.exec(authorization.trim());
        if (!match) return null;
        bearer = match[1] ?? null;
    }
    const explicit = typeof secondary === "string" ? secondary.trim() : null;
    if (secondary !== undefined && !explicit) return null;
    if (bearer && explicit && bearer !== explicit) return null;
    return bearer ?? explicit;
}

export type ExternalProviderBrokerDispatchResult =
    | Readonly<{
        ok: true;
        statusCode: number;
        headers: Readonly<Record<string, string>>;
        body: AsyncIterable<Uint8Array>;
    }>
    | Readonly<{ ok: false; error: TeamCredentialExternalProviderErrorCodeV1; retryAtMs?: number }>;

export type ExternalProviderBrokerDispatch = (input: Readonly<{
    request: TeamCredentialExternalProviderApplicationRequestV1;
    target: Readonly<{ custodianAccountId: string; brokerMachineId: string; operationId: string | null; brokerPlacementFingerprint: string }>;
    signal: AbortSignal;
}>) => Promise<ExternalProviderBrokerDispatchResult>;

function errorStatus(code: TeamCredentialExternalProviderErrorCodeV1): number {
    if (code === "invalid_api_key") return 401;
    if (code === "invalid_request") return 400;
    if (code === "policy_denied") return 403;
    if (code === 'connected_service_credential_reconnect_required') return 403;
    if (code === "team_credential_usage_limit") return 429;
    if (code === "request_cancelled") return 499;
    return 503;
}

function sendError(
    reply: { header(name: string, value: string): unknown; code(status: number): { send(body: unknown): unknown } },
    code: TeamCredentialExternalProviderErrorCodeV1,
    retryAtMs?: number,
    nowMs = Date.now(),
) {
    if (code === 'team_credential_usage_limit' && retryAtMs !== undefined && retryAtMs > nowMs) {
        reply.header('Retry-After', String(Math.ceil((retryAtMs - nowMs) / 1_000)));
    }
    return reply.code(errorStatus(code)).send(TeamCredentialExternalProviderErrorV1Schema.parse({
        error: {
            type: "happier_provider_broker_error",
            code,
            message: code === "invalid_api_key" ? "Invalid API key." : "Provider request failed.",
        },
    }));
}

const FORWARDED_REQUEST_HEADERS = new Set([
    "accept",
    "anthropic-beta",
    "anthropic-version",
    "content-type",
    "openai-beta",
    "openai-organization",
    "user-agent",
]);

/**
 * Caller headers that must never reach a broker request.
 *
 * Reverse-proxy forwarding headers are deliberately absent: the documented
 * self-hosted deployment puts Nginx in front of this route and adds
 * `Forwarded`/`X-Forwarded-*`/`X-Real-IP`, and `trustProxy` already owns the
 * client address they carry. The forward allowlist above is what keeps proxy
 * metadata out of the broker DTO, so rejecting the request would only make the
 * public API unusable on its own documented deployment.
 */
function isRejectedCallerHeader(name: string): boolean {
    return name.startsWith("x-happier-")
        || name === "cookie"
        || name === "set-cookie"
        || name === "proxy-authorization";
}

function forwardHeaders(
    headers: Readonly<Record<string, HeaderValue>>,
    rawHeaders: readonly string[] = [],
): Readonly<Record<string, string>> | null {
    const selected: Record<string, string> = {};
    const forwardedCounts = new Map<string, number>();
    for (let index = 0; index < rawHeaders.length; index += 2) {
        const name = rawHeaders[index]?.toLowerCase();
        if (name && (FORWARDED_REQUEST_HEADERS.has(name) || isRejectedCallerHeader(name))) {
            forwardedCounts.set(name, (forwardedCounts.get(name) ?? 0) + 1);
        }
    }
    if ([...forwardedCounts.values()].some((count) => count > 1)) return null;
    for (const [rawName, value] of Object.entries(headers)) {
        const name = rawName.toLowerCase();
        if (isRejectedCallerHeader(name)) return null;
        if (!FORWARDED_REQUEST_HEADERS.has(name)) continue;
        if (typeof value !== "string") return null;
        selected[name] = value;
    }
    const parsed = TeamCredentialExternalProviderRequestHeadersV1Schema.safeParse(selected);
    return parsed.success ? parsed.data : null;
}

async function* streamWithCancellation(
    body: AsyncIterable<Uint8Array>,
    cancellation: AbortController,
    cleanup: () => void,
): AsyncGenerator<Uint8Array> {
    try {
        for await (const chunk of body) yield chunk;
    } finally {
        cancellation.abort();
        cleanup();
    }
}

export function registerExternalProviderApiRoutes(
    app: Fastify,
    dependencies: Readonly<{
        dispatch?: ExternalProviderBrokerDispatch;
        env?: NodeJS.ProcessEnv;
        readCurrentBrokerPresence?: Parameters<typeof resolveTeamCredentialExternalBrokerPlacement>[0]["readCurrentPresence"];
        readPoolSourceEligibility?: ExternalBrokerPoolSourceEligibilityReader;
        nowMs?: () => number;
    }> = {},
): void {
    const env = dependencies.env ?? process.env;
    const operationGate = async (request: FastifyRequest, reply: FastifyReply) => {
        const availability = resolveTeamCredentialExternalApiAvailability(
            resolveServerFeaturesForGating(await readHomeEffectiveEnv({ env, request })),
        );
        if (!availability.available) return reply.code(404).send({ error: "not_found" });
    };
    const rateLimit = resolveApiHotEndpointRateLimit(env, "providerBroker.externalApi");
    const readCurrentBrokerPresence = dependencies.readCurrentBrokerPresence ?? ((custodianAccountId, machineIds) => (
        getMachineDaemonPresenceInventory({ accountId: custodianAccountId, io: app.machineDaemonPresence, machineIds })
    ));
    const canonicalPoolSourceEligibility = createTeamCredentialPoolSourceEligibilityReader(
        (params) => app.forwardRpcForUser(params),
    );
    // An external key's protocol and model are known only per request, so its
    // Pool members are asked for any application of the source.
    const readPoolSourceEligibility: ExternalBrokerPoolSourceEligibilityReader = dependencies.readPoolSourceEligibility
        ?? ((input) => canonicalPoolSourceEligibility({ ...input, scope: "source_any" }));

    for (const [route, descriptor] of Object.entries(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_HTTP_ROUTES_V1)) {
        app.route({
            method: descriptor.method,
            url: `${TEAM_CREDENTIAL_EXTERNAL_PROVIDER_API_BASE_PATH_V1}${descriptor.publicPath}`,
            // Broker JSON and event streams must deliver chunks before EOF.
            compress: false,
            config: { cors: false, rateLimit },
            preHandler: operationGate,
            handler: async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
                reply.header("cache-control", "no-store");
                const token = readExternalProviderApiCredential(request.headers, request.raw.rawHeaders);
                if (!token) return sendError(reply, "invalid_api_key");
                const verified = await inTx(tx => readTeamCredentialExternalBrokerOpenInTx(tx, token));
                if (!verified.ok) return sendError(reply, "invalid_api_key");
                const { authority } = verified;
                const headers = forwardHeaders(request.headers, request.raw.rawHeaders);
                if (!headers || request.url.includes("?")) return sendError(reply, "invalid_request");
                const bodyBase64 = descriptor.method === "GET"
                    ? null
                    : request.body === undefined
                        ? null
                        : privacyKit.encodeBase64(new TextEncoder().encode(JSON.stringify(request.body)));
                const applicationRequest = TeamCredentialExternalProviderApplicationRequestV1Schema.safeParse({
                    v: 1,
                    requestId: randomUUID(),
                    teamId: authority.teamId,
                    resourceId: authority.resourceId,
                    caller: {
                        kind: "external_api_key",
                        keyId: authority.keyId,
                        assignedAccountId: authority.assignedAccountId,
                        assignedTeamMembershipId: authority.assignedTeamMembershipId,
                    },
                    route,
                    method: descriptor.method,
                    pathAndQuery: descriptor.providerPath,
                    headers,
                    bodyBase64,
                });
                if (!applicationRequest.success) return sendError(reply, "invalid_request");
                const dispatch = dependencies.dispatch ?? app.forwardExternalProviderBrokerRequest;
                if (!dispatch) return sendError(reply, "broker_unavailable");
                const cancellation = new AbortController();
                function cleanup() {
                    request.raw.off("aborted", abort);
                    reply.raw.off("close", abort);
                }
                function abort() {
                    cancellation.abort();
                    cleanup();
                }
                request.raw.once("aborted", abort);
                reply.raw.once("close", abort);
                const placement = await resolveTeamCredentialExternalBrokerPlacement({
                    open: verified,
                    catalogOnly: route === "models",
                    signal: cancellation.signal,
                    readCurrentPresence: readCurrentBrokerPresence,
                    readPoolSourceEligibility,
                }).catch(() => ({ ok: false as const, error: "broker_unavailable" as const }));
                if (!placement.ok) {
                    cleanup();
                    return sendError(reply, placement.error);
                }
                const target = {
                    custodianAccountId: placement.custodianAccountId,
                    brokerMachineId: placement.brokerMachineId,
                    operationId: placement.operationId,
                    brokerPlacementFingerprint: placement.brokerPlacementFingerprint,
                };
                let result: ExternalProviderBrokerDispatchResult;
                try {
                    result = await dispatch({
                        request: applicationRequest.data,
                        target,
                        signal: cancellation.signal,
                    });
                } catch {
                    cleanup();
                    return sendError(reply, cancellation.signal.aborted ? "request_cancelled" : "broker_unavailable");
                }
                if (cancellation.signal.aborted) {
                    cleanup();
                    return sendError(reply, "request_cancelled");
                }
                if (!result.ok) {
                    cleanup();
                    return sendError(reply, result.error, result.retryAtMs, dependencies.nowMs?.() ?? Date.now());
                }
                for (const [name, value] of Object.entries(result.headers)) {
                    const normalized = name.toLowerCase();
                    if (["content-type", "content-encoding", "x-request-id", "retry-after"].includes(normalized)) {
                        reply.header(normalized, value);
                    }
                }
                reply.code(result.statusCode);
                return reply.send(Readable.from(
                    streamWithCancellation(result.body, cancellation, cleanup),
                    { objectMode: false, highWaterMark: 1 },
                ));
            },
        });
    }
}
