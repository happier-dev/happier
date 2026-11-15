import { Socket } from "socket.io";
import { UsageEventIngestRequestSchema } from "@happier-dev/protocol/usage/usageAnalyticsContracts";
import type { VerifiedEphemeralSessionRunnerPrincipal } from "@happier-dev/protocol/ephemeralRunner/principal";
import { AsyncLock } from "@/utils/runtime/lock";
import { log } from "@/utils/logging/log";
import { ingestUsageEvent } from "@/app/usage/ingestUsageEvent";
import { isEphemeralSessionRunnerBoundToSessionTarget } from "@/app/api/utils/apiTokenRouteAdmission";
import { verifyCurrentMaterializedRunnerPrincipal } from "@/app/ephemeralRunner/materializedRunnerPrincipalCurrentness";
import type { ClientConnection } from "@/app/events/eventPayloadTypes";
import { canTargetSessionFromSocket } from "./sessionScopedBinding";

/**
 * The v2 usage event on the admitted socket. It is the HTTP ingest route's
 * transport twin: the same request schema, ingest owner and Runner binding
 * (the Runner's own Session and Machine, and a current materialized principal,
 * as the HTTP bearer verification re-proves per request).
 */
export function usageHandler(
    userId: string,
    socket: Socket,
    connection: ClientConnection,
    sessionRuntimePrincipal: VerifiedEphemeralSessionRunnerPrincipal | null = null,
) {
    const receiveUsageLock = new AsyncLock();
    socket.on('usage-event', async (data: unknown, callback?: (response: unknown) => void) => {
        await receiveUsageLock.inLock(async () => {
            try {
                const parsed = UsageEventIngestRequestSchema.safeParse(data);
                if (!parsed.success) {
                    callback?.({ success: false, error: 'Invalid parameters' });
                    return;
                }
                const request = parsed.data;
                if (sessionRuntimePrincipal && (!isEphemeralSessionRunnerBoundToSessionTarget({
                    principal: sessionRuntimePrincipal,
                    sessionIds: request.sessionId ? [request.sessionId] : null,
                    machine: { declared: true, value: request.machineId, optional: true },
                }) || !await verifyCurrentMaterializedRunnerPrincipal(sessionRuntimePrincipal))) {
                    callback?.({ success: false, error: 'Forbidden' });
                    return;
                }
                if (request.sessionId && !canTargetSessionFromSocket({ socket, connection, sessionId: request.sessionId })) {
                    callback?.({ success: false, error: 'Forbidden' });
                    return;
                }
                const outcome = await ingestUsageEvent(userId, request);
                callback?.(outcome.status === 200 ? outcome.body : { success: false, error: outcome.body.error });
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in usage-event handler: ${error}`);
                callback?.({ success: false, error: 'Internal error' });
            }
        });
    });
}
