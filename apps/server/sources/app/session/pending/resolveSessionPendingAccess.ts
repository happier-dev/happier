import { checkSessionAccess, requireAccessLevel, type AccessLevel } from "@/app/share/accessControl";

export type SessionPendingAccess =
    | { ok: true; isOwner: boolean; level: AccessLevel }
    | { ok: false; error: "session-not-found" | "forbidden" };

export async function resolveSessionPendingViewAccess(actorUserId: string, sessionId: string): Promise<SessionPendingAccess> {
    const access = await checkSessionAccess(actorUserId, sessionId);
    if (!access) return { ok: false, error: "session-not-found" };
    return { ok: true, isOwner: access.isOwner, level: access.level };
}

export async function resolveSessionPendingEditAccess(actorUserId: string, sessionId: string): Promise<SessionPendingAccess> {
    const access = await checkSessionAccess(actorUserId, sessionId);
    if (!access) return { ok: false, error: "session-not-found" };
    if (!requireAccessLevel(access, "edit")) return { ok: false, error: "forbidden" };
    return { ok: true, isOwner: access.isOwner, level: access.level };
}

export async function resolveSessionPendingOwnerAccess(actorUserId: string, sessionId: string): Promise<SessionPendingAccess> {
    const access = await checkSessionAccess(actorUserId, sessionId);
    if (!access) return { ok: false, error: "session-not-found" };
    if (!access.isOwner) return { ok: false, error: "forbidden" };
    return { ok: true, isOwner: true, level: access.level };
}
