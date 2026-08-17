import { canApprovePermissions } from "@/app/share/accessControl";
import { db } from "@/storage/db";
import {
    resolveSocketRpcSessionPermissionDecisionAuthorizationMethod,
    type SocketRpcSessionPermissionRespondAuthorizationContext,
} from "@happier-dev/protocol/rpc";

export type RpcCallTargetResolution =
    | Readonly<{
        type: "target";
        targetUserId: string;
        permissionRespondAuthorization?: SocketRpcSessionPermissionRespondAuthorizationContext;
    }>
    | Readonly<{
        type: "forbidden";
    }>;

export async function resolveRpcCallTarget(params: Readonly<{
    callerUserId: string;
    method: string;
}>): Promise<RpcCallTargetResolution> {
    const { callerUserId, method } = params;

    let targetUserId = callerUserId;
    let permissionRespondAuthorization: SocketRpcSessionPermissionRespondAuthorizationContext | undefined;

    const lastColon = method.lastIndexOf(":");
    const permissionDecisionMethod = resolveSocketRpcSessionPermissionDecisionAuthorizationMethod(method);
    if (permissionDecisionMethod) {
        const sessionId = lastColon >= 0 ? method.slice(0, lastColon) : "";
        if (sessionId && sessionId !== "permission") {
            const session = await db.session.findUnique({
                where: { id: sessionId },
                select: { accountId: true },
            });
            const ownerId = session?.accountId;
            if (ownerId) {
                const relationship = ownerId === callerUserId
                    ? "owner"
                    : "sharedApprover";
                if (relationship === "sharedApprover") {
                    const allowed = await canApprovePermissions(callerUserId, sessionId);
                    if (!allowed) {
                        return { type: "forbidden" };
                    }
                    targetUserId = ownerId;
                }
                permissionRespondAuthorization = {
                    kind: "session.permission.respond",
                    sessionId,
                    actor: {
                        kind: "accountUser",
                        accountId: callerUserId,
                        relationship,
                    },
                };
            }
        }
    }

    return {
        type: "target",
        targetUserId,
        ...(permissionRespondAuthorization ? { permissionRespondAuthorization } : {}),
    };
}
