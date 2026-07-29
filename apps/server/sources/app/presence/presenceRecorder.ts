import { activityCache } from "./sessionCache";
import { shouldPublishPresenceToRedis } from "./presenceMode";
import { publishMachineAlive } from "./presenceRedisQueue";
import { log } from "@/utils/logging/log";
import { reassertSessionLatestTurnStatus } from "@/app/session/sessionWriteService";
import { publishSessionTurnMutationUpdate } from "@/app/session/turns/publishSessionTurnMutationUpdate";

type SessionAliveRecord = Readonly<{
    accountId: string;
    sessionId: string;
    timestamp: number;
    thinking?: boolean;
    latestTurnStatus?: unknown;
    latestTurnStatusObservedAt?: unknown;
}>;

export async function recordSessionAlive(params: SessionAliveRecord): Promise<void> {
    if (params.latestTurnStatus !== undefined && params.latestTurnStatusObservedAt !== undefined) {
        const result = await reassertSessionLatestTurnStatus({
            actorUserId: params.accountId,
            sessionId: params.sessionId,
            latestTurnStatus: params.latestTurnStatus,
            latestTurnStatusObservedAt: params.latestTurnStatusObservedAt,
        });
        if (result.ok) {
            await publishSessionTurnMutationUpdate({
                sessionId: params.sessionId,
                actorUserId: params.accountId,
                result,
            });
        }
    }
}

export async function recordMachineAlive(params: { accountId: string; machineId: string; timestamp: number }): Promise<void> {
    const shouldPersist = activityCache.queueMachineUpdate(params.machineId, params.timestamp);
    if (!shouldPersist) return;
    if (!shouldPublishPresenceToRedis(process.env)) return;
    try {
        await publishMachineAlive({ accountId: params.accountId, machineId: params.machineId, timestamp: params.timestamp });
        activityCache.markMachineUpdateSent(params.machineId, params.timestamp);
    } catch (e) {
        log({ module: "presence-recorder", level: "warn" }, `Failed to publish machine alive: ${e}`);
    }
}
