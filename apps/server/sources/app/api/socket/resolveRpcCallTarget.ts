import { Socket } from "socket.io";
import { db } from "@/storage/db";
import { canApprovePermissions } from "@/app/share/accessControl";
import { log } from "@/utils/logging/log";

export type RpcCallTargetResolution =
    | {
        type: "target";
        targetUserId: string;
        targetSocket: Socket | undefined;
      }
    | {
        type: "forbidden";
      };

export async function resolveRpcCallTarget(params: {
    callerUserId: string;
    method: string;
    allRpcListeners: Map<string, Map<string, Socket>>;
}): Promise<RpcCallTargetResolution> {
    const { callerUserId, method, allRpcListeners } = params;

    // Delegated permission approvals (cross-user forwarding) are allowed ONLY for `${sessionId}:permission`.
    // All other RPC methods are restricted to "same-user" forwarding.
    let targetUserId = callerUserId;
    let targetSocket: Socket | undefined = undefined;

    const lastColon = method.lastIndexOf(':');
    const suffix = lastColon >= 0 ? method.slice(lastColon + 1) : '';
    if (suffix === 'permission') {
        const sessionId = lastColon >= 0 ? method.slice(0, lastColon) : '';
        if (sessionId && sessionId !== 'permission') {
            const session = await db.session.findUnique({
                where: { id: sessionId },
                select: { accountId: true },
            });
            const ownerId = session?.accountId;
            if (ownerId && ownerId !== callerUserId) {
                const allowed = await canApprovePermissions(callerUserId, sessionId);
                if (!allowed) {
                    return { type: "forbidden" };
                }
                targetUserId = ownerId;
                const ownerListeners = allRpcListeners.get(ownerId);
                targetSocket = ownerListeners?.get(method);
                if (targetSocket) {
                    log({ module: 'websocket-rpc' }, `Delegated permission RPC: ${callerUserId} -> ${ownerId} (${sessionId})`);
                }
            }
        }
    }

    return {
        type: "target",
        targetUserId,
        targetSocket,
    };
}
