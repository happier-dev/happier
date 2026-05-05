import { z } from "zod";

import { resolveLiveActivityRemoteTransportConfig } from "@/app/activity/liveActivities/resolveLiveActivityRemoteTransport";
import { encryptLiveActivityTargetSecret } from "@/app/activity/liveActivities/providers/directApnsLiveActivityProvider";
import { db } from "@/storage/db";
import type { Fastify } from "../../types";
import {
    buildLiveActivityTargetIdentityHash,
    LiveActivityTargetRegistrationSchema,
    type LiveActivityTargetRegistration,
} from "./liveActivityTargetRegistration";
import { redactLiveActivityTarget } from "./redactLiveActivityTarget";

async function assertSessionBelongsToAccount(accountId: string, sessionId: string): Promise<boolean> {
    const session = await db.session.findFirst({
        where: {
            id: sessionId,
            accountId,
        },
        select: { id: true },
    });
    return Boolean(session);
}

async function registerDirectApnsTarget(accountId: string, input: LiveActivityTargetRegistration) {
    if (input.tokenKind !== "activitykit_update_token") {
        return {
            ok: false as const,
            status: 400,
            body: { code: "live_activity_invalid_target_kind" },
        };
    }
    const config = resolveLiveActivityRemoteTransportConfig(process.env);
    if (!config.directApns.configured) {
        return {
            ok: false as const,
            status: 409,
            body: {
                code: "live_activity_transport_unavailable",
                reasons: config.capabilityDiagnostics.modes.direct_apns.reasons,
                diagnostics: config.directApns.diagnostics,
            },
        };
    }
    if (config.modeResolution.mode !== "direct_apns") {
        return {
            ok: false as const,
            status: 409,
            body: {
                code: "live_activity_transport_unavailable",
                reasons: config.capabilityDiagnostics.modes.direct_apns.reasons,
                mode: config.modeResolution.mode,
                modeReason: config.modeResolution.reason,
            },
        };
    }
    if (!input.rawToken || !input.bundleId || !input.environment) {
        return {
            ok: false as const,
            status: 400,
            body: { code: "live_activity_target_invalid" },
        };
    }
    if (!config.directApns.bundleIds.includes(input.bundleId) || config.directApns.environment !== input.environment) {
        return {
            ok: false as const,
            status: 409,
            body: {
                code: "live_activity_transport_unavailable",
                reasons: ["direct_apns_not_configured"],
            },
        };
    }

    return {
        ok: true as const,
        data: {
            rawTokenEncrypted: encryptLiveActivityTargetSecret({
                accountId,
                serverId: input.serverId,
                sessionId: input.sessionId,
                activityId: input.activityId,
                field: "rawToken",
                value: input.rawToken,
            }),
            expoPushToken: null,
        },
    };
}

async function registerHostedRelayTarget(accountId: string, input: LiveActivityTargetRegistration) {
    if (input.tokenKind !== "activitykit_update_token") {
        return {
            ok: false as const,
            status: 400,
            body: { code: "live_activity_invalid_target_kind" },
        };
    }
    const config = resolveLiveActivityRemoteTransportConfig(process.env);
    const hostedDiagnostics = config.capabilityDiagnostics.modes.hosted_happier_relay;
    if (config.modeResolution.mode !== "hosted_happier_relay") {
        return {
            ok: false as const,
            status: 409,
            body: {
                code: "live_activity_transport_unavailable",
                reasons: hostedDiagnostics.reasons,
                mode: config.modeResolution.mode,
                modeReason: config.modeResolution.reason,
            },
        };
    }
    if (!hostedDiagnostics.available) {
        return {
            ok: false as const,
            status: 409,
            body: {
                code: "live_activity_transport_unavailable",
                reasons: hostedDiagnostics.reasons,
            },
        };
    }
    if (!input.rawToken || !input.bundleId || !input.environment) {
        return {
            ok: false as const,
            status: 400,
            body: { code: "live_activity_target_invalid" },
        };
    }

    return {
        ok: true as const,
        data: {
            rawTokenEncrypted: encryptLiveActivityTargetSecret({
                accountId,
                serverId: input.serverId,
                sessionId: input.sessionId,
                activityId: input.activityId,
                field: "rawToken",
                value: input.rawToken,
            }),
            expoPushToken: null,
        },
    };
}

async function registerBackgroundWakeTarget(accountId: string, input: LiveActivityTargetRegistration) {
    if (input.tokenKind !== "expo_push_token") {
        return {
            ok: false as const,
            status: 400,
            body: { code: "live_activity_invalid_target_kind" },
        };
    }
    const config = resolveLiveActivityRemoteTransportConfig(process.env);
    if (!config.backgroundWake.enabled) {
        return {
            ok: false as const,
            status: 409,
            body: {
                code: "live_activity_transport_unavailable",
                reasons: config.capabilityDiagnostics.modes.background_wake_best_effort.reasons,
            },
        };
    }
    if (config.modeResolution.mode !== "background_wake_best_effort") {
        return {
            ok: false as const,
            status: 409,
            body: {
                code: "live_activity_transport_unavailable",
                reasons: config.capabilityDiagnostics.modes.background_wake_best_effort.reasons,
                mode: config.modeResolution.mode,
                modeReason: config.modeResolution.reason,
            },
        };
    }
    if (!input.expoPushToken) {
        return {
            ok: false as const,
            status: 400,
            body: { code: "live_activity_target_invalid" },
        };
    }
    const regularPushToken = await db.accountPushToken.findUnique({
        where: {
            accountId_token: {
                accountId,
                token: input.expoPushToken,
            },
        },
        select: { token: true },
    });
    if (!regularPushToken) {
        return {
            ok: false as const,
            status: 409,
            body: { code: "live_activity_expo_push_token_not_registered" },
        };
    }

    return {
        ok: true as const,
        data: {
            rawTokenEncrypted: null,
            expoPushToken: input.expoPushToken,
        },
    };
}

export function liveActivityTargetsRoutes(app: Fastify) {
    app.post("/v1/live-activity-targets", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const parsed = LiveActivityTargetRegistrationSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ code: "live_activity_target_invalid" });
        }

        const input = parsed.data;
        const accountId = request.userId;
        const sessionBelongsToAccount = await assertSessionBelongsToAccount(accountId, input.sessionId);
        if (!sessionBelongsToAccount) {
            return reply.code(404).send({ code: "live_activity_session_not_found" });
        }

        const transportData =
            input.transportMode === "direct_apns"
                ? await registerDirectApnsTarget(accountId, input)
                : input.transportMode === "hosted_happier_relay"
                    ? await registerHostedRelayTarget(accountId, input)
                    : await registerBackgroundWakeTarget(accountId, input);
        if (!transportData.ok) {
            return reply.code(transportData.status).send(transportData.body);
        }

        const targetIdentityHash = buildLiveActivityTargetIdentityHash(accountId, input);
        const target = await db.accountLiveActivityTarget.upsert({
            where: {
                accountId_targetIdentityHash: {
                    accountId,
                    targetIdentityHash,
                },
            },
            update: {
                deviceId: input.deviceId,
                serverId: input.serverId,
                sessionId: input.sessionId,
                activityInstanceKey: input.activityInstanceKey,
                activityId: input.activityId,
                activityName: input.activityName,
                transportMode: input.transportMode,
                bundleId: input.bundleId ?? null,
                environment: input.environment ?? null,
                tokenKind: input.tokenKind,
                rawTokenEncrypted: transportData.data.rawTokenEncrypted,
                expoPushToken: transportData.data.expoPushToken,
                clientServerUrl: input.clientServerUrl ?? null,
                endedAt: null,
                lastFailureCode: null,
            },
            create: {
                accountId,
                deviceId: input.deviceId,
                serverId: input.serverId,
                sessionId: input.sessionId,
                activityInstanceKey: input.activityInstanceKey,
                activityId: input.activityId,
                activityName: input.activityName,
                targetIdentityHash,
                transportMode: input.transportMode,
                bundleId: input.bundleId ?? null,
                environment: input.environment ?? null,
                tokenKind: input.tokenKind,
                rawTokenEncrypted: transportData.data.rawTokenEncrypted,
                expoPushToken: transportData.data.expoPushToken,
                clientServerUrl: input.clientServerUrl ?? null,
            },
        });

        return reply.send({ success: true, target: redactLiveActivityTarget(target) });
    });

    app.get("/v1/live-activity-targets", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const targets = await db.accountLiveActivityTarget.findMany({
            where: { accountId: request.userId },
            orderBy: { updatedAt: "desc" },
        });
        return reply.send({ targets: targets.map(redactLiveActivityTarget) });
    });

    app.delete("/v1/live-activity-targets/:id", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string().trim().min(1) }),
        },
    }, async (request, reply) => {
        await db.accountLiveActivityTarget.updateMany({
            where: {
                id: request.params.id,
                accountId: request.userId,
            },
            data: {
                endedAt: new Date(),
            },
        });
        return reply.send({ success: true });
    });
}
