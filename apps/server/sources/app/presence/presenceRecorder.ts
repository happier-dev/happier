import { activityCache } from "./sessionCache";
import { shouldPublishPresenceToRedis } from "./presenceMode";
import { publishMachineAlive, publishSessionAlive } from "./presenceRedisQueue";
import { log } from "@/utils/log";

export async function recordSessionAlive(params: { accountId: string; sessionId: string; timestamp: number }): Promise<void> {
    const shouldPersist = activityCache.queueSessionUpdate(params.sessionId, params.accountId, params.timestamp);
    if (!shouldPersist) return;
    if (!shouldPublishPresenceToRedis(process.env)) return;
    try {
        await publishSessionAlive({ sessionId: params.sessionId, timestamp: params.timestamp, accountId: params.accountId });
        activityCache.markSessionUpdateSent(params.sessionId, params.accountId, params.timestamp);
    } catch (e) {
        // Best-effort: do not advance "lastUpdateSent" when publishing fails, so we can retry on a later ping.
        log({ module: "presence-recorder", level: "warn" }, `Failed to publish session alive: ${e}`);
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
