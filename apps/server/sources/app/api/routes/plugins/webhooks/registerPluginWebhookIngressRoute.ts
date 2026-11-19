import { createHash, randomBytes } from "node:crypto";

import { PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1 } from '@happier-dev/protocol/plugins/webhooks/deliveryV1';
import { z } from "zod/mini";

import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import {
    createPluginWebhookProcessAdmissionV1,
    createPluginWebhookRedisAdmissionV1,
    type PluginWebhookDistributedScopeV1,
} from "@/app/plugins/webhooks/admission";
import {
    admitVerifiedPluginWebhookV1,
    ingestPluginWebhookV1,
    preparePluginWebhookSignatureVerifierV1,
    type PreparedPluginWebhookSignatureVerifierV1,
} from "@/app/plugins/webhooks/ingest";
import { recordPluginWebhookHeartbeatReceiptV1 } from "@/app/plugins/webhooks/heartbeat";
import {
    PLUGIN_WEBHOOK_INGRESS_DEADLINE_MS_V1,
    resolvePluginWebhookIngressPolicyV1,
    type WebhookIngressPolicyV1,
} from "@/app/plugins/webhooks/policy";
import {
    readWebhookDeclaredContentLengthV1,
    readWebhookRawBodyV1,
    WebhookRawBodyReadError,
} from "@/app/plugins/webhooks/rawBody";
import type { ActivePluginWebhookEndpointV1 } from "@/app/plugins/webhooks/routeStore";
import type { PluginWebhookCommittedDeliveryWakeV1 } from "@/app/plugins/webhooks/wake";
import { getRedisClient } from "@/storage/redis/redis";

import type { Fastify } from "../../../types";

const ROUTE_ID_PATTERN_V1 = /^[A-Za-z0-9_-]{1,256}$/u;
const MAX_HEADER_COUNT_V1 = 64;
const MAX_HEADER_NAME_BYTES_V1 = 128;
const MAX_HEADER_VALUE_BYTES_V1 = 8 * 1024;
const MAX_HEADER_BYTES_V1 = 32 * 1024;
const DISTRIBUTED_RESERVATION_TTL_MS_V1 = PLUGIN_WEBHOOK_INGRESS_DEADLINE_MS_V1;
const UNSUPPORTED_INGRESS_METHODS_V1 = [
    "DELETE",
    "HEAD",
    "OPTIONS",
    "PATCH",
    "PUT",
    "TRACE",
] as const;

type ProcessAdmissionV1 = Readonly<{
    acquire(bytes: number): Readonly<{ release(): void }> | null;
}>;

type DistributedAdmissionV1 = Readonly<{
    acquire(
        scopes: readonly PluginWebhookDistributedScopeV1[],
        options: Readonly<{ nowMs: number; ttlMs: number; ownerToken: string }>,
    ): Promise<
        | Readonly<{ ok: true; release(): void | Promise<void> }>
        | Readonly<{ ok: false; code: "rate" | "concurrency" | "unavailable"; retryAfterMs: number }>
    >;
}>;

type IngestV1 = typeof ingestPluginWebhookV1;

export type RegisterPluginWebhookIngressRouteOptions = Readonly<{
    env?: NodeJS.ProcessEnv;
    ingest?: IngestV1;
    onCommittedWake?: (wake: PluginWebhookCommittedDeliveryWakeV1) => void;
    processAdmission?: ProcessAdmissionV1;
    distributedAdmission?: DistributedAdmissionV1 | null;
}>;

type RequestReservationV1 = {
    declaredBytes: number | null;
    deadlineAtMs: number;
    ownerToken: string;
    localRelease: () => void;
    distributedReleases: Array<() => void | Promise<void>>;
    deadlineController: AbortController;
    deadlineTimer: ReturnType<typeof setTimeout>;
    /**
     * The post-buffer operation this request started, while it is still
     * running. It owns the raw body plus its database/envelope work, so the
     * request keeps its admission until this settles.
     */
    custody: Promise<unknown> | null;
    releasing: boolean;
};

function publicEmpty(reply: any, statusCode: number, retryAfterSeconds?: number) {
    reply.header("Cache-Control", "no-store");
    if (retryAfterSeconds !== undefined) reply.header("Retry-After", String(retryAfterSeconds));
    return reply.code(statusCode).send();
}

function readHeaderBoundsV1(headers: Readonly<Record<string, unknown>>): boolean {
    const entries = Object.entries(headers);
    if (entries.length > MAX_HEADER_COUNT_V1) return false;
    let aggregateBytes = 0;
    for (const [name, rawValue] of entries) {
        if (!/^[\x21-\x7e]+$/u.test(name) || Buffer.byteLength(name) > MAX_HEADER_NAME_BYTES_V1) return false;
        const values = Array.isArray(rawValue) ? rawValue : [rawValue];
        for (const value of values) {
            if (typeof value !== "string" && typeof value !== "number") return false;
            const valueBytes = Buffer.byteLength(String(value));
            if (valueBytes > MAX_HEADER_VALUE_BYTES_V1) return false;
            aggregateBytes += Buffer.byteLength(name) + valueBytes;
            if (aggregateBytes > MAX_HEADER_BYTES_V1) return false;
        }
    }
    return true;
}

function scopeIdentityV1(kind: "public-ingress" | "route" | "endpoint" | "account", value: string): string {
    return `${kind}:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function publicIngressScopeV1(policy: WebhookIngressPolicyV1): PluginWebhookDistributedScopeV1 {
    return {
        key: scopeIdentityV1("public-ingress", "public-ingress"),
        ratePerMinute: policy.route.ratePerMinute,
        concurrency: policy.route.concurrency,
    };
}

function routeScopeV1(
    opaqueRouteId: string,
    policy: WebhookIngressPolicyV1,
): PluginWebhookDistributedScopeV1 {
    return {
        key: scopeIdentityV1("route", opaqueRouteId),
        ratePerMinute: policy.route.ratePerMinute,
        concurrency: policy.route.concurrency,
    };
}

function endpointScopesV1(
    endpoint: ActivePluginWebhookEndpointV1,
    policy: WebhookIngressPolicyV1,
): readonly PluginWebhookDistributedScopeV1[] {
    return [
        {
            key: scopeIdentityV1("endpoint", endpoint.endpointId),
            ratePerMinute: policy.endpoint.ratePerMinute,
            concurrency: policy.endpoint.concurrency,
        },
        {
            key: scopeIdentityV1("account", endpoint.accountId),
            ratePerMinute: policy.account.ratePerMinute,
            concurrency: policy.account.concurrency,
        },
    ];
}

function resolveDistributedAdmissionV1(
    env: NodeJS.ProcessEnv,
    supplied: DistributedAdmissionV1 | null | undefined,
): DistributedAdmissionV1 | null {
    if (supplied !== undefined) return supplied;
    return env.REDIS_URL?.trim()
        ? createPluginWebhookRedisAdmissionV1(getRedisClient())
        : null;
}

/**
 * Admission bounds the work this process is doing, so it is returned when that
 * work settles rather than when the public response is written. The ingress
 * deadline answers the caller with a bounded 503; the ingestion it abandoned
 * still holds the raw body and its database/envelope work, and handing that
 * capacity to another request while it runs would defeat the very concurrency
 * bound this admission exists to enforce.
 */
async function releaseReservationV1(reservation: RequestReservationV1 | undefined): Promise<void> {
    if (!reservation || reservation.releasing) return;
    reservation.releasing = true;
    clearTimeout(reservation.deadlineTimer);
    if (reservation.custody) {
        try {
            await reservation.custody;
        } catch {
            // Custody ends when the operation settles, however it settles.
        }
    }
    reservation.localRelease();
    await Promise.all(reservation.distributedReleases.splice(0).map(async (release) => {
        try {
            await release();
        } catch {
            // Distributed reservations have a bounded TTL as the final cleanup owner.
        }
    }));
}

async function awaitUntilAbortedV1<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason;
    let rejectForAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectForAbort = () => reject(signal.reason ?? new Error("plugin_webhook_ingress_deadline_exceeded"));
        signal.addEventListener("abort", rejectForAbort, { once: true });
    });
    try {
        return await Promise.race([operation, aborted]);
    } finally {
        if (rejectForAbort) signal.removeEventListener("abort", rejectForAbort);
    }
}

export function registerPluginWebhookIngressRoute(
    app: Fastify,
    options: RegisterPluginWebhookIngressRouteOptions = {},
): void {
    const env = options.env ?? process.env;
    const suppliedIngest = options.ingest;
    const policy = resolvePluginWebhookIngressPolicyV1(env);
    const processAdmission = options.processAdmission ?? createPluginWebhookProcessAdmissionV1({
        maxRequests: policy.process.maxRequests,
        maxWorkingBytes: policy.process.maxWorkingBytes,
    });
    const distributedAdmission = resolveDistributedAdmissionV1(env, options.distributedAdmission);
    const reservations = new WeakMap<object, RequestReservationV1>();
    const releaseTrackedReservation = async (request: object): Promise<void> => {
        const reservation = reservations.get(request);
        if (!reservation) return;
        reservations.delete(request);
        await releaseReservationV1(reservation);
    };
    const abortTrackedReservation = async (request: object): Promise<void> => {
        const reservation = reservations.get(request);
        if (!reservation) return;
        reservation.deadlineController.abort(new Error("plugin_webhook_ingress_client_aborted"));
        await releaseTrackedReservation(request);
    };

    app.register(async (scoped) => {
        scoped.removeContentTypeParser(["application/json", "text/plain"]);
        scoped.addContentTypeParser(
            "*",
            { bodyLimit: PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1 },
            (_request, payload, done) => done(null, payload),
        );

        scoped.route({
            method: ["POST", "GET"],
            exposeHeadRoute: false,
            url: "/v1/plugins/webhooks/:opaqueRouteId",
            schema: {
                params: z.strictObject({ opaqueRouteId: z.string().check(z.regex(ROUTE_ID_PATTERN_V1)) }),
            },
            onRequest: async (request, reply) => {
                if (!await isServerFeatureEnabledForHome("plugins.webhooks", { env, request })) {
                    return publicEmpty(reply, 404);
                }
                if (request.headers["transfer-encoding"] !== undefined) {
                    return publicEmpty(reply, 415);
                }
                if (
                    Object.keys(request.query as object).length > 0
                    || !readHeaderBoundsV1(request.headers)
                ) {
                    return publicEmpty(reply, 400);
                }
                const declared = readWebhookDeclaredContentLengthV1(request.headers["content-length"]);
                if (!declared.ok && declared.code !== "missing") {
                    return publicEmpty(reply, declared.code === "tooLarge" ? 413 : 411);
                }
                const declaredBytes = declared.ok ? declared.bytes : null;
                const deadlineAtMs = Date.now() + PLUGIN_WEBHOOK_INGRESS_DEADLINE_MS_V1;
                // Bodyless capabilities still pay request admission; signed handlers require a length below.
                const local = processAdmission.acquire(declaredBytes ?? 0);
                if (!local) return publicEmpty(reply, 503, 5);
                const deadlineController = new AbortController();
                let localReleased = false;
                const releaseLocal = () => {
                    if (localReleased) return;
                    localReleased = true;
                    local.release();
                };
                let reservation: RequestReservationV1 | undefined;
                const deadlineTimer = setTimeout(() => {
                    deadlineController.abort(new Error("plugin_webhook_ingress_deadline_exceeded"));
                    if (reservation) {
                        void releaseReservationV1(reservation);
                    } else {
                        releaseLocal();
                    }
                    if (!reply.sent) publicEmpty(reply, 503, 5);
                    const rawRequest = request.raw as Readonly<{
                        complete?: boolean;
                        destroy?(): void;
                    }>;
                    if (!rawRequest.complete) {
                        rawRequest.destroy?.();
                    }
                }, Math.max(0, deadlineAtMs - Date.now()));
                const requestReservation: RequestReservationV1 = {
                    declaredBytes,
                    deadlineAtMs,
                    ownerToken: `wh_req_${randomBytes(16).toString("base64url")}`,
                    localRelease: releaseLocal,
                    distributedReleases: [],
                    deadlineController,
                    deadlineTimer,
                    custody: null,
                    releasing: false,
                };
                reservation = requestReservation;
                reservations.set(request, requestReservation);

                const opaqueRouteId = (request.params as { opaqueRouteId: string }).opaqueRouteId;
                if (distributedAdmission) {
                    // The approved r0.20 order admits the public route by its
                    // opaque URL identity before any database or credential
                    // work: no route lookup may precede or gate this
                    // acquisition, and an unknown route id pays the same shared
                    // public-ingress plus per-route pressure scopes instead of a
                    // cheaper database probe. These scopes protect the shared route
                    // and this replica only —
                    // charging an endpoint's or an Account's tenant budget here
                    // would let anyone who learns a public URL exhaust that one
                    // customer's admission budget without ever producing a
                    // valid signature, so tenant sublimits are acquired at the
                    // first authenticated routing point below, and signature
                    // verifier preparation owns the sole route and credential
                    // resolution.
                    const acquireDistributed = distributedAdmission.acquire([
                        publicIngressScopeV1(policy),
                        routeScopeV1(opaqueRouteId, policy),
                    ], {
                        nowMs: Date.now(),
                        ttlMs: DISTRIBUTED_RESERVATION_TTL_MS_V1,
                        ownerToken: requestReservation.ownerToken,
                    });
                    let acquired: Awaited<ReturnType<DistributedAdmissionV1["acquire"]>>;
                    try {
                        acquired = await awaitUntilAbortedV1(acquireDistributed, deadlineController.signal);
                    } catch {
                        void acquireDistributed.then(async (eventual) => {
                            if (eventual.ok) await eventual.release();
                        }).catch(() => undefined);
                        await releaseReservationV1(requestReservation);
                        if (reply.sent) return;
                        return publicEmpty(reply, 503, 5);
                    }
                    if (!acquired.ok) {
                        await releaseReservationV1(requestReservation);
                        return publicEmpty(
                            reply,
                            acquired.code === "rate" ? 429 : 503,
                            Math.max(1, Math.ceil(acquired.retryAfterMs / 1_000)),
                        );
                    }
                    if (deadlineController.signal.aborted) {
                        await acquired.release();
                        await releaseReservationV1(requestReservation);
                        if (reply.sent) return;
                        return publicEmpty(reply, 503, 5);
                    }
                    requestReservation.distributedReleases.push(() => acquired.release());
                }
                return undefined;
            },
            onRequestAbort: async (request) => {
                await abortTrackedReservation(request);
            },
            onResponse: async (request) => {
                await releaseTrackedReservation(request);
            },
        handler: async (request, reply) => {
            const reservation = reservations.get(request);
            if (!reservation) return publicEmpty(reply, 503, 5);
            try {
                if (reservation.deadlineController.signal.aborted) {
                    return reply.sent ? reply : publicEmpty(reply, 503, 5);
                }
                const resolvedAdmissionFailure: {
                    current: Readonly<{ statusCode: 429 | 503; retryAfterMs: number }> | null;
                } = { current: null };
                // The one tenant-admission seam, for both routing kinds: the
                // ingest owner resolves the endpoint from the verified request
                // and calls this before it builds an envelope or commits.
                const reserveResolvedEndpoint = !distributedAdmission
                    ? undefined
                    : async (endpoint: ActivePluginWebhookEndpointV1) => {
                        if (reservation.deadlineController.signal.aborted) return null;
                        const acquired = await distributedAdmission.acquire(endpointScopesV1(endpoint, policy), {
                            nowMs: Date.now(),
                            ttlMs: DISTRIBUTED_RESERVATION_TTL_MS_V1,
                            ownerToken: reservation.ownerToken,
                        });
                        if (!acquired.ok) {
                            resolvedAdmissionFailure.current = {
                                statusCode: acquired.code === "rate" ? 429 : 503,
                                retryAfterMs: acquired.retryAfterMs,
                            };
                            return null;
                        }
                        if (reservation.deadlineController.signal.aborted) {
                            await acquired.release();
                            return null;
                        }
                        return { release: () => acquired.release() };
                    };

                let streamingVerifier: PreparedPluginWebhookSignatureVerifierV1["verifier"] | undefined;
                if (!suppliedIngest) {
                    const prepared = await awaitUntilAbortedV1(
                        preparePluginWebhookSignatureVerifierV1({
                            opaqueRouteId: (request.params as { opaqueRouteId: string }).opaqueRouteId,
                            method: request.method,
                            headers: request.headers,
                            signal: reservation.deadlineController.signal,
                        }),
                        reservation.deadlineController.signal,
                    );
                    if (prepared.kind === "recordReceiptOnly") {
                        const receipt = recordPluginWebhookHeartbeatReceiptV1({ routeId: prepared.route.routeId, deadlineAtMs: reservation.deadlineAtMs });
                        reservation.custody = receipt;
                        const accepted = await awaitUntilAbortedV1(receipt, reservation.deadlineController.signal);
                        return publicEmpty(reply, accepted ? 202 : 404);
                    }
                    if (prepared.kind !== "ready") {
                        if (prepared.statusCode === 405) reply.header("Allow", "POST");
                        // Close after the reply if the refused request still has an unread body.
                        if (!request.raw.complete) reply.header("Connection", "close");
                        return publicEmpty(
                            reply,
                            prepared.statusCode,
                            prepared.statusCode === 503 ? 5 : undefined,
                        );
                    }
                    streamingVerifier = prepared.verifier;
                }

                // Signed webhook handlers remain POST-only; capability receipts need no body.
                if (request.method === "GET") {
                    reply.header("Allow", "POST");
                    return publicEmpty(reply, 405);
                }
                if (reservation.declaredBytes === null) return publicEmpty(reply, 411);
                const body = request.body as unknown as AsyncIterable<Uint8Array> | null;
                if (!body || typeof body[Symbol.asyncIterator] !== "function") return publicEmpty(reply, 400);
                let rawBody: Uint8Array;
                try {
                    rawBody = await awaitUntilAbortedV1(readWebhookRawBodyV1({
                        body,
                        declaredBytes: reservation.declaredBytes,
                        signal: reservation.deadlineController.signal,
                        ...(streamingVerifier ? { onChunk: (chunk) => streamingVerifier.update(chunk) } : {}),
                    }), reservation.deadlineController.signal);
                } catch (error) {
                    if (
                        reservation.deadlineController.signal.aborted
                        || (error instanceof WebhookRawBodyReadError && error.code === "aborted")
                    ) return reply.sent ? reply : publicEmpty(reply, 503, 5);
                    return publicEmpty(
                        reply,
                        error instanceof WebhookRawBodyReadError && error.code === "tooLarge" ? 413 : 400,
                    );
                }

                const ingestPromise = streamingVerifier
                    ? (() => {
                        const verification = streamingVerifier.verify();
                        return verification
                            ? admitVerifiedPluginWebhookV1({
                                verification,
                                rawBody,
                                headers: request.headers,
                                signal: reservation.deadlineController.signal,
                                deadlineAtMs: reservation.deadlineAtMs,
                                ...(options.onCommittedWake ? { onCommittedWake: options.onCommittedWake } : {}),
                                ...(reserveResolvedEndpoint ? { reserveResolvedEndpoint } : {}),
                            })
                            : Promise.resolve({ kind: "rejected" as const, statusCode: 401 as const, code: "unauthorized" as const });
                    })()
                    : suppliedIngest!({
                        opaqueRouteId: (request.params as { opaqueRouteId: string }).opaqueRouteId,
                        rawBody,
                        headers: request.headers,
                        signal: reservation.deadlineController.signal,
                        deadlineAtMs: reservation.deadlineAtMs,
                        ...(options.onCommittedWake ? { onCommittedWake: options.onCommittedWake } : {}),
                        ...(reserveResolvedEndpoint ? { reserveResolvedEndpoint } : {}),
                    });
                reservation.custody = ingestPromise;
                const result = await awaitUntilAbortedV1(ingestPromise, reservation.deadlineController.signal);
                if (result.kind === "accepted" || result.kind === "receiptAccepted") return publicEmpty(reply, 202);
                if (resolvedAdmissionFailure.current) {
                    return publicEmpty(
                        reply,
                        resolvedAdmissionFailure.current.statusCode,
                        Math.max(1, Math.ceil(resolvedAdmissionFailure.current.retryAfterMs / 1_000)),
                    );
                }
                return publicEmpty(reply, result.statusCode, result.statusCode === 503 ? 5 : undefined);
            } catch {
                return reply.sent ? reply : publicEmpty(reply, 503, 5);
            } finally {
                await releaseTrackedReservation(request);
            }
        },
        });
        scoped.route({
            method: [...UNSUPPORTED_INGRESS_METHODS_V1],
            url: "/v1/plugins/webhooks/:opaqueRouteId",
            handler: async (request, reply) => {
                if (!await isServerFeatureEnabledForHome("plugins.webhooks", { env, request })) {
                    return publicEmpty(reply, 404);
                }
                reply.header("Allow", "POST");
                return publicEmpty(reply, 405);
            },
        });
    });
}
