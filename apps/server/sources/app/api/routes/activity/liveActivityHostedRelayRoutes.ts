import { createHash, timingSafeEqual } from "node:crypto";

import {
    classifyLiveActivityApnsDeliveryResponse,
    HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
    LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES,
    LiveActivityRemoteUpdateRequestV1Schema,
} from "@happier-dev/protocol";
import { z } from "zod";

import { buildDirectApnsLiveActivityHttp2Request } from "@/app/activity/liveActivities/providers/directApnsLiveActivityProvider";
import {
    sendApnsLiveActivityHttp2Request,
    type ApnsLiveActivityHttp2Response,
} from "@/app/activity/liveActivities/providers/apnsLiveActivityHttp2Sender";
import { resolveLiveActivityRemoteTransportConfig } from "@/app/activity/liveActivities/resolveLiveActivityRemoteTransport";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { parseBooleanEnv, parseIntEnv } from "@/config/env";
import type { Fastify } from "../../types";

const HostedRelayRequestSchema = z
    .object({
        v: z.literal(1),
        requestId: z.string().trim().min(1).max(128),
        createdAt: z.number().int().nonnegative(),
        bundleId: z.string().trim().min(1),
        environment: z.enum(["sandbox", "production"]),
        activityName: z.literal(HAPPIER_FOCUS_LIVE_ACTIVITY_NAME),
        activityId: z.string().trim().min(1),
        activityKitUpdateToken: z.string().trim().min(1),
        update: LiveActivityRemoteUpdateRequestV1Schema,
    })
    .strict()
    .superRefine((request, ctx) => {
        if (request.update.transportMode !== "hosted_happier_relay") {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["update", "transportMode"],
                message: "Hosted relay only accepts hosted_happier_relay updates",
            });
        }
        if (request.update.requestId !== request.requestId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["update", "requestId"],
                message: "Hosted relay request id must match the update",
            });
        }
        if (request.update.createdAt !== request.createdAt) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["update", "createdAt"],
                message: "Hosted relay createdAt must match the update",
            });
        }
        if (request.update.activityKey.activityName !== request.activityName) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["update", "activityKey", "activityName"],
                message: "Hosted relay activity name must match the update",
            });
        }
    });

type HostedRelayRequest = z.infer<typeof HostedRelayRequestSchema>;

const DEFAULT_HOSTED_RELAY_MAX_SKEW_MS = 5 * 60_000;
const DEFAULT_HOSTED_RELAY_DUPLICATE_TTL_MS = 10 * 60_000;
const DEFAULT_HOSTED_RELAY_DUPLICATE_CACHE_MAX_ENTRIES = 10_000;
const HOSTED_RELAY_RATE_LIMIT_MAX_IP_KEY_LENGTH = 256;

type DuplicateRequestCacheEntry = Readonly<{
    expiresAt: number;
    requestHash: string;
}>;

const duplicateRequestCache = new Map<string, DuplicateRequestCacheEntry>();

function readCsv(env: NodeJS.ProcessEnv, key: string): string[] {
    const value = env[key];
    if (typeof value !== "string") return [];
    return value
        .split(/[,\n]+/g)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function readBearerToken(request: { headers?: Record<string, unknown> }): string | null {
    const raw = request.headers?.authorization;
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
    const token = trimmed.slice(7).trim();
    return token || null;
}

function timingSafeStringEqual(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left, "utf8");
    const rightBytes = Buffer.from(right, "utf8");
    const paddedLength = Math.max(leftBytes.length, rightBytes.length, 1);
    const leftPadded = Buffer.alloc(paddedLength);
    const rightPadded = Buffer.alloc(paddedLength);
    leftBytes.copy(leftPadded);
    rightBytes.copy(rightPadded);
    const equalBytes = timingSafeEqual(leftPadded, rightPadded);

    return leftBytes.length === rightBytes.length && equalBytes;
}

function hasRelayAccessKey(accessKeys: readonly string[], bearerToken: string): boolean {
    let matched = 0;
    for (const accessKey of accessKeys) {
        matched |= timingSafeStringEqual(accessKey, bearerToken) ? 1 : 0;
    }
    return matched === 1;
}

function hashString(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function tokenFingerprint(token: string): string {
    return `activitykit:${hashString(token).slice(0, 16)}`;
}

function hostedRelayRateLimitKey(request: { headers?: Record<string, unknown>; ip?: unknown }): string {
    const bearerToken = readBearerToken(request);
    if (bearerToken && hasRelayAccessKey(relayAccessKeys(process.env), bearerToken)) {
        return `relay:${hashString(bearerToken).slice(0, 16)}`;
    }

    const ip = typeof request.ip === "string" ? request.ip.trim() : "";
    const safeIp = ip.length > HOSTED_RELAY_RATE_LIMIT_MAX_IP_KEY_LENGTH
        ? ip.slice(0, HOSTED_RELAY_RATE_LIMIT_MAX_IP_KEY_LENGTH)
        : ip;
    return safeIp ? `ip:${safeIp}` : "ip:unknown";
}

function countJsonBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function cleanupDuplicateCache(nowMs: number, maxEntries: number): void {
    for (const [key, entry] of duplicateRequestCache.entries()) {
        if (entry.expiresAt <= nowMs) {
            duplicateRequestCache.delete(key);
        }
    }
    if (duplicateRequestCache.size <= maxEntries) return;
    duplicateRequestCache.clear();
}

function duplicateKey(request: HostedRelayRequest): string {
    return `${request.requestId}:${request.bundleId}:${request.activityName}:${request.activityId}:${hashString(request.activityKitUpdateToken)}`;
}

function duplicateRequestHash(request: HostedRelayRequest): string {
    return hashString(JSON.stringify(request));
}

function isAllowedActivityName(
    activityName: string,
    allowlist: readonly string[],
): boolean {
    return allowlist.length > 0
        ? allowlist.includes(activityName)
        : activityName === HAPPIER_FOCUS_LIVE_ACTIVITY_NAME;
}

function relayAccessKeys(env: NodeJS.ProcessEnv): string[] {
    return readCsv(env, "HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS");
}

function maxSkewMs(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(env.HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_MAX_SKEW_MS, DEFAULT_HOSTED_RELAY_MAX_SKEW_MS, { min: 1 });
}

function duplicateTtlMs(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(env.HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_TTL_MS, DEFAULT_HOSTED_RELAY_DUPLICATE_TTL_MS, { min: 1 });
}

function duplicateCacheMaxEntries(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(
        env.HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_CACHE_MAX_ENTRIES,
        DEFAULT_HOSTED_RELAY_DUPLICATE_CACHE_MAX_ENTRIES,
        { min: 1 },
    );
}

export function liveActivityHostedRelayRoutes(app: Fastify) {
    app.post("/v1/live-activity-hosted-relay", {
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "liveActivity.hostedRelay", {
                keyGenerator: hostedRelayRateLimitKey,
            }),
        },
    }, async (request, reply) => {
        if (!parseBooleanEnv(process.env.HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_SERVICE_ENABLED, false)) {
            return reply.code(404).send({ code: "live_activity_hosted_relay_disabled" });
        }

        const accessKeys = relayAccessKeys(process.env);
        const bearerToken = readBearerToken(request);
        if (accessKeys.length === 0 || !bearerToken || !hasRelayAccessKey(accessKeys, bearerToken)) {
            return reply.code(401).send({ code: "live_activity_hosted_relay_unauthorized" });
        }

        const parsed = HostedRelayRequestSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ code: "live_activity_hosted_relay_invalid" });
        }

        const relayRequest = parsed.data;
        const now = Date.now();
        if (Math.abs(now - relayRequest.createdAt) > maxSkewMs(process.env)) {
            return reply.code(409).send({ code: "live_activity_hosted_relay_stale" });
        }

        const config = resolveLiveActivityRemoteTransportConfig(process.env);
        if (!config.directApns.configured) {
            return reply.code(503).send({
                code: "live_activity_hosted_relay_apns_unavailable",
                diagnostics: config.directApns.diagnostics,
            });
        }
        if (relayRequest.environment !== config.directApns.environment) {
            return reply.code(403).send({ code: "live_activity_hosted_relay_environment_not_allowed" });
        }
        if (!config.directApns.bundleIds.includes(relayRequest.bundleId)) {
            return reply.code(403).send({ code: "live_activity_hosted_relay_bundle_not_allowed" });
        }
        if (!isAllowedActivityName(relayRequest.activityName, config.directApns.allowedActivityNames)) {
            return reply.code(403).send({ code: "live_activity_hosted_relay_activity_not_allowed" });
        }

        const cacheKey = duplicateKey(relayRequest);
        const requestHash = duplicateRequestHash(relayRequest);
        const ttlMs = duplicateTtlMs(process.env);
        cleanupDuplicateCache(now, duplicateCacheMaxEntries(process.env));
        const duplicateEntry = duplicateRequestCache.get(cacheKey);
        if (duplicateEntry) {
            if (duplicateEntry.requestHash !== requestHash) {
                return reply.code(409).send({
                    success: false,
                    status: "failed",
                    code: "live_activity_hosted_relay_replay_conflict",
                    tokenFingerprint: tokenFingerprint(relayRequest.activityKitUpdateToken),
                });
            }
            return reply.send({
                success: true,
                status: "coalesced",
                duplicate: true,
                tokenFingerprint: tokenFingerprint(relayRequest.activityKitUpdateToken),
            });
        }

        const apnsRequest = buildDirectApnsLiveActivityHttp2Request({
            target: {
                activityId: relayRequest.activityId,
                bundleId: relayRequest.bundleId,
            },
            request: relayRequest.update,
            config: config.directApns,
            now: new Date(now),
            deviceToken: relayRequest.activityKitUpdateToken,
        });
        if (countJsonBytes(apnsRequest.payload) > LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES) {
            return reply.code(413).send({ code: "live_activity_hosted_relay_payload_too_large" });
        }

        let apnsResponse: ApnsLiveActivityHttp2Response;
        try {
            apnsResponse = await sendApnsLiveActivityHttp2Request(apnsRequest);
        } catch {
            return reply.code(502).send({
                success: false,
                status: "failed",
                classification: {
                    action: "transient_retry",
                    reason: "apns_transport_error",
                },
                tokenFingerprint: tokenFingerprint(relayRequest.activityKitUpdateToken),
                code: "live_activity_hosted_relay_apns_transport_error",
            });
        }
        const classification = classifyLiveActivityApnsDeliveryResponse(apnsResponse);
        const fingerprint = tokenFingerprint(relayRequest.activityKitUpdateToken);
        if (classification.action === "success") {
            duplicateRequestCache.set(cacheKey, {
                expiresAt: now + ttlMs,
                requestHash,
            });
            return reply.send({
                success: true,
                status: "sent",
                classification,
                apnsId: apnsResponse.apnsId,
                tokenFingerprint: fingerprint,
            });
        }

        return reply.code(apnsResponse.status >= 500 ? 502 : 422).send({
            success: false,
            status: "failed",
            classification,
            apnsId: apnsResponse.apnsId,
            tokenFingerprint: fingerprint,
            code: classification.reason ?? `apns_status_${apnsResponse.status}`,
        });
    });
}
