import { canApprovePermissions } from "@/app/share/accessControl";
import { db } from "@/storage/db";

export type RpcCallTargetResolution =
    | Readonly<{
        type: "target";
        targetUserId: string;
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

    const lastColon = method.lastIndexOf(":");
    const suffix = lastColon >= 0 ? method.slice(lastColon + 1) : "";
    if (suffix === "permission") {
        const sessionId = lastColon >= 0 ? method.slice(0, lastColon) : "";
        if (sessionId && sessionId !== "permission") {
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
            }
        }
    }

    return {
        type: "target",
        targetUserId,
    };
}
