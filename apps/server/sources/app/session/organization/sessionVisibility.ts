import type { Tx } from "@/storage/inTx";
import type { Prisma } from "@prisma/client";

import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";

/** Organization entries attach only to readable, unarchived Sessions. */
export function visibleUnarchivedOrganizationSessionWhere(readableSessionWhere: Prisma.SessionWhereInput): Prisma.SessionWhereInput {
    return { AND: [readableSessionWhere, { archivedAt: null }] };
}

export async function buildReadableOrganizationSessionWhere(tx: Tx, accountId: string, authentication: SessionAccessAuthentication): Promise<Prisma.SessionWhereInput> {
    return await buildSessionAccessWhere({ tx, accountId, capability: 'readTranscript', mode: 'effective_access_v1', authentication });
}

export async function createVisibleUnarchivedOrganizationSessionWhere(tx: Tx, accountId: string, authentication: SessionAccessAuthentication): Promise<Prisma.SessionWhereInput> {
    return visibleUnarchivedOrganizationSessionWhere(await buildReadableOrganizationSessionWhere(tx, accountId, authentication));
}
