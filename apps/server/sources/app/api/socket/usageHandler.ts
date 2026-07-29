import { Socket } from "socket.io";
import { AsyncLock } from "@/utils/runtime/lock";
import { log } from "@/utils/logging/log";
import { recordLegacyUsageReport } from "@/app/usage/usageWriteService";
import { LegacyUsageReportRouteBodySchema } from "@/app/usage/legacyUsageReportSchema";
import type { ClientConnection } from "@/app/events/eventPayloadTypes";
import { canTargetSessionFromSocket } from "./sessionScopedBinding";

export function usageHandler(userId: string, socket: Socket, connection: ClientConnection) {
    const receiveUsageLock = new AsyncLock();
    socket.on('usage-report', async (data: unknown, callback?: (response: any) => void) => {
        await receiveUsageLock.inLock(async () => {
            try {
                const parsed = LegacyUsageReportRouteBodySchema.safeParse(data);
                if (!parsed.success) {
                    if (callback) callback({ success: false, error: 'Invalid parameters' });
                    return;
                }
                const { key, sessionId, tokens, cost } = parsed.data;

                if (!canTargetSessionFromSocket({ socket, connection, sessionId })) {
                    if (callback) {
                        callback({ success: false, error: 'Forbidden' });
                    }
                    return;
                }

                try {
                    const result = await recordLegacyUsageReport({
                        accountId: userId,
                        key,
                        sessionId,
                        tokens,
                        cost,
                    });

                    if (!result.ok) {
                        if (callback) {
                            callback({
                                success: false,
                                error: result.error === 'session-not-found' ? 'Session not found' : 'Invalid parameters',
                            });
                        }
                        return;
                    }

                    if (result.changed) {
                        log({ module: 'websocket' }, `Usage report saved: key=${key}, sessionId=${sessionId}, userId=${userId}`);
                    }

                    if (callback) {
                        callback({
                            success: true,
                            reportId: result.report.id,
                            createdAt: result.report.createdAt.getTime(),
                            updatedAt: result.report.updatedAt.getTime(),
                        });
                    }
                } catch (error) {
                    log({ module: 'websocket', level: 'error' }, `Failed to save usage report: ${error}`);
                    if (callback) {
                        callback({ success: false, error: 'Failed to save usage report' });
                    }
                }
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in usage-report handler: ${error}`);
                if (callback) {
                    callback({ success: false, error: 'Internal error' });
                }
            }
        });
    });
}
