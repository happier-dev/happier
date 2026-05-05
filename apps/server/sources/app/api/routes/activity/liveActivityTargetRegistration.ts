import { createHash } from "node:crypto";

import {
    HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
    LiveActivityRemoteTargetKindSchema,
    LiveActivityRemoteTransportModeSchema,
} from "@happier-dev/protocol";
import { z } from "zod";

export const LiveActivityTargetRegistrationSchema = z
    .object({
        deviceId: z.string().trim().min(1),
        serverId: z.string().trim().min(1),
        sessionId: z.string().trim().min(1),
        activityInstanceKey: z.string().trim().min(1),
        activityId: z.string().trim().min(1),
        activityName: z.literal(HAPPIER_FOCUS_LIVE_ACTIVITY_NAME),
        transportMode: LiveActivityRemoteTransportModeSchema,
        bundleId: z.string().trim().min(1).optional(),
        environment: z.enum(["sandbox", "production"]).optional(),
        tokenKind: LiveActivityRemoteTargetKindSchema,
        rawToken: z.string().trim().min(1).optional(),
        expoPushToken: z.string().trim().min(1).optional(),
        clientServerUrl: z.string().trim().min(1).optional(),
    })
    .strict();

export type LiveActivityTargetRegistration = z.infer<typeof LiveActivityTargetRegistrationSchema>;

export function buildLiveActivityTargetIdentityHash(
    accountId: string,
    input: LiveActivityTargetRegistration,
): string {
    return createHash("sha256")
        .update(JSON.stringify({
            accountId,
            deviceId: input.deviceId,
            serverId: input.serverId,
            sessionId: input.sessionId,
            activityInstanceKey: input.activityInstanceKey,
            activityId: input.activityId,
            activityName: input.activityName,
            transportMode: input.transportMode,
        }))
        .digest("hex");
}
