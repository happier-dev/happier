import type { Prisma } from "@prisma/client";

import { createV2SessionListVisibilityWhere } from "@/app/api/routes/session/v2SessionListRows";

export function createVisibleUnarchivedOrganizationSessionWhere(accountId: string): Prisma.SessionWhereInput {
    return {
        ...createV2SessionListVisibilityWhere({ userId: accountId }),
        archivedAt: null,
    };
}
