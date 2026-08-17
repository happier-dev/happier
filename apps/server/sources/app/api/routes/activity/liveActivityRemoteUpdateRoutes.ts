import { LiveActivityRemoteUpdateRequestV1Schema } from "@happier-dev/protocol";

import { resolveLiveActivityRemoteTransportConfig } from "@/app/activity/liveActivities/resolveLiveActivityRemoteTransport";
import { sendDirectApnsLiveActivityUpdate } from "@/app/activity/liveActivities/providers/directApnsLiveActivityProvider";
import { sendExpoBackgroundWakeLiveActivityUpdate } from "@/app/activity/liveActivities/providers/expoBackgroundWakeProvider";
import { sendHostedRelayLiveActivityUpdate } from "@/app/activity/liveActivities/providers/hostedRelayLiveActivityProvider";
import { parseIntEnv } from "@/config/env";
import { db, getActivePrismaRuntime } from "@/storage/db";
import type { AccountLiveActivityTarget } from "@prisma/client";
import type { Fastify } from "../../types";

const DEFAULT_REMOTE_UPDATE_DEDUPE_WINDOW_MS = 30_000;
const MAX_REMOTE_UPDATE_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BACKGROUND_WAKE_MIN_INTERVAL_MS = 60_000;
const MAX_BACKGROUND_WAKE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

type CoalescedRemoteUpdateDelivery = Readonly<{
    targetId: string;
    status: "coalesced";
    duplicate: true;
    reason: "duplicate_payload";
}>;

type ThrottledBackgroundWakeDelivery = Readonly<{
    targetId: string;
    status: "throttled";
    throttled: true;
    reason: "background_wake_min_interval";
}>;

function resolveRemoteUpdateDedupeWindowMs(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(
        env.HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_DEDUPE_WINDOW_MS,
        DEFAULT_REMOTE_UPDATE_DEDUPE_WINDOW_MS,
        { min: 0, max: MAX_REMOTE_UPDATE_DEDUPE_WINDOW_MS },
    );
}

function resolveBackgroundWakeMinIntervalMs(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(
        env.HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_MIN_INTERVAL_MS,
        DEFAULT_BACKGROUND_WAKE_MIN_INTERVAL_MS,
        { min: 0, max: MAX_BACKGROUND_WAKE_MIN_INTERVAL_MS },
    );
}

function shouldCoalesceRemoteUpdate(params: Readonly<{
    target: AccountLiveActivityTarget;
    snapshotFingerprint: string;
    now: Date;
    dedupeWindowMs: number;
}>): boolean {
    if (params.dedupeWindowMs <= 0) return false;
    if (params.target.lastPayloadHash !== params.snapshotFingerprint) return false;
    if (!params.target.lastPushedAt) return false;

    const ageMs = params.now.getTime() - params.target.lastPushedAt.getTime();
    return ageMs >= 0 && ageMs <= params.dedupeWindowMs;
}

function buildCoalescedDelivery(target: AccountLiveActivityTarget): CoalescedRemoteUpdateDelivery {
    return {
        targetId: target.id,
        status: "coalesced",
        duplicate: true,
        reason: "duplicate_payload",
    };
}

function shouldThrottleBackgroundWake(params: Readonly<{
    target: AccountLiveActivityTarget;
    now: Date;
    minIntervalMs: number;
}>): boolean {
    if (params.minIntervalMs <= 0) return false;
    if (!params.target.lastPushedAt) return false;

    const ageMs = params.now.getTime() - params.target.lastPushedAt.getTime();
    return ageMs >= 0 && ageMs < params.minIntervalMs;
}

function buildThrottledBackgroundWakeDelivery(target: AccountLiveActivityTarget): ThrottledBackgroundWakeDelivery {
    return {
        targetId: target.id,
        status: "throttled",
        throttled: true,
        reason: "background_wake_min_interval",
    };
}

async function recordBackgroundWakeDeliveryResult(params: Readonly<{
    targetId: string;
    snapshotFingerprint: string;
    now: Date;
    result: Awaited<ReturnType<typeof sendExpoBackgroundWakeLiveActivityUpdate>>;
}>): Promise<void> {
    if (params.result.status === "sent_best_effort") {
        await db.accountLiveActivityTarget.update({
            where: { id: params.targetId },
            data: {
                lastPushedAt: params.now,
                lastPayloadHash: params.snapshotFingerprint,
                failureCount: 0,
                lastFailureCode: null,
                diagnostics: getActivePrismaRuntime().DbNull,
            },
        });
        return;
    }

    await db.accountLiveActivityTarget.update({
        where: { id: params.targetId },
        data: {
            failureCount: { increment: 1 },
            lastFailureCode: params.result.reason,
            diagnostics: {
                backgroundWake: {
                    status: "failed",
                    reason: params.result.reason,
                },
            },
        },
    });
}

export function liveActivityRemoteUpdateRoutes(app: Fastify) {
    app.post("/v1/live-activity-remote-updates", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const parsed = LiveActivityRemoteUpdateRequestV1Schema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ code: "live_activity_remote_update_invalid" });
        }

        const updateRequest = parsed.data;
        const targets = await db.accountLiveActivityTarget.findMany({
            where: {
                accountId: request.userId,
                serverId: updateRequest.activityKey.serverId,
                sessionId: updateRequest.activityKey.sessionId,
                activityName: updateRequest.activityKey.activityName,
                transportMode: updateRequest.transportMode,
                endedAt: null,
            },
        });
        const config = resolveLiveActivityRemoteTransportConfig(process.env);
        const deliveries = [];
        const dedupeWindowMs = resolveRemoteUpdateDedupeWindowMs(process.env);
        const backgroundWakeMinIntervalMs = resolveBackgroundWakeMinIntervalMs(process.env);

        for (const target of targets) {
            if (updateRequest.transportMode === "direct_apns") {
                if (config.modeResolution.mode !== "direct_apns") {
                    deliveries.push({
                        targetId: target.id,
                        status: "failed",
                        code: "live_activity_transport_unavailable",
                        reasons: config.capabilityDiagnostics.modes.direct_apns.reasons,
                        mode: config.modeResolution.mode,
                        modeReason: config.modeResolution.reason,
                    });
                    continue;
                }
                if (!config.directApns.configured) {
                    deliveries.push({
                        targetId: target.id,
                        status: "failed",
                        code: "live_activity_transport_unavailable",
                        reasons: config.capabilityDiagnostics.modes.direct_apns.reasons,
                    });
                    continue;
                }
                const now = new Date();
                if (shouldCoalesceRemoteUpdate({
                    target,
                    snapshotFingerprint: updateRequest.snapshotFingerprint,
                    now,
                    dedupeWindowMs,
                })) {
                    deliveries.push(buildCoalescedDelivery(target));
                    continue;
                }
                deliveries.push(await sendDirectApnsLiveActivityUpdate({
                    target,
                    request: updateRequest,
                    config: config.directApns,
                    now,
                }));
                continue;
            }

            if (updateRequest.transportMode === "background_wake_best_effort") {
                if (config.modeResolution.mode !== "background_wake_best_effort") {
                    deliveries.push({
                        targetId: target.id,
                        status: "failed",
                        code: "live_activity_transport_unavailable",
                        reasons: config.capabilityDiagnostics.modes.background_wake_best_effort.reasons,
                        mode: config.modeResolution.mode,
                        modeReason: config.modeResolution.reason,
                    });
                    continue;
                }
                if (!target.expoPushToken) {
                    deliveries.push({
                        targetId: target.id,
                        status: "failed",
                        code: "live_activity_expo_push_token_missing",
                    });
                    continue;
                }
                const now = new Date();
                if (shouldCoalesceRemoteUpdate({
                    target,
                    snapshotFingerprint: updateRequest.snapshotFingerprint,
                    now,
                    dedupeWindowMs,
                })) {
                    deliveries.push(buildCoalescedDelivery(target));
                    continue;
                }
                if (shouldThrottleBackgroundWake({
                    target,
                    now,
                    minIntervalMs: backgroundWakeMinIntervalMs,
                })) {
                    deliveries.push(buildThrottledBackgroundWakeDelivery(target));
                    continue;
                }
                const result = await sendExpoBackgroundWakeLiveActivityUpdate({
                    expoPushToken: target.expoPushToken,
                    request: updateRequest,
                });
                await recordBackgroundWakeDeliveryResult({
                    targetId: target.id,
                    snapshotFingerprint: updateRequest.snapshotFingerprint,
                    now,
                    result,
                });
                deliveries.push({
                    targetId: target.id,
                    ...result,
                });
                continue;
            }

            if (updateRequest.transportMode === "hosted_happier_relay") {
                if (config.modeResolution.mode !== "hosted_happier_relay") {
                    deliveries.push({
                        targetId: target.id,
                        status: "failed",
                        code: "live_activity_transport_unavailable",
                        reasons: config.capabilityDiagnostics.modes.hosted_happier_relay.reasons,
                        mode: config.modeResolution.mode,
                        modeReason: config.modeResolution.reason,
                    });
                    continue;
                }
                const now = new Date();
                if (shouldCoalesceRemoteUpdate({
                    target,
                    snapshotFingerprint: updateRequest.snapshotFingerprint,
                    now,
                    dedupeWindowMs,
                })) {
                    deliveries.push(buildCoalescedDelivery(target));
                    continue;
                }
                deliveries.push(await sendHostedRelayLiveActivityUpdate({
                    target,
                    request: updateRequest,
                    config: config.hostedRelay,
                    now,
                }));
            }
        }

        return reply.send({ success: true, deliveries });
    });
}
