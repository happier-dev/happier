import { db } from "@/storage/db";
import { createV2SessionListVisibilityWhere } from "@/app/api/routes/session/v2SessionListRows";
import { createVisibleUnarchivedOrganizationSessionWhere } from "./sessionVisibility";

export async function canAccessSyncedSessionForOrganization(params: Readonly<{
    accountId: string;
    sessionId: string;
}>): Promise<boolean> {
    const row = await db.session.findFirst({
        where: {
            id: params.sessionId,
            ...createV2SessionListVisibilityWhere({ userId: params.accountId }),
        },
        select: { id: true },
    });
    return Boolean(row);
}

export async function canAccessVisibleUnarchivedSessionForOrganization(params: Readonly<{
    accountId: string;
    sessionId: string;
}>): Promise<boolean> {
    const row = await db.session.findFirst({
        where: {
            id: params.sessionId,
            ...createVisibleUnarchivedOrganizationSessionWhere(params.accountId),
        },
        select: { id: true },
    });
    return Boolean(row);
}
