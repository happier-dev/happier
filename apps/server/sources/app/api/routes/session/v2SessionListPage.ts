import type { Prisma } from "@prisma/client";

import {
    decodeV2SessionListCursorV1,
    encodeV2SessionListCursorV1,
} from "@happier-dev/protocol";
import { db } from "@/storage/db";
import {
    createV2SessionListRowSelect,
    createV2SessionListVisibilityWhere,
    mapV2SessionListRow,
    type V2SessionListRow,
} from "./v2SessionListRows";

export async function findV2SessionListRows(params: Readonly<{
    userId: string;
    orderBy: Prisma.SessionOrderByWithRelationInput;
    take: number;
    where?: Prisma.SessionWhereInput;
}>): Promise<V2SessionListRow[]> {
    const { userId, orderBy, take, where } = params;

    return await db.session.findMany({
        where: {
            ...createV2SessionListVisibilityWhere({ userId }),
            ...(where ?? {}),
        },
        orderBy,
        take,
        select: createV2SessionListRowSelect({ userId }),
    });
}

export function mapV2SessionListRows(params: Readonly<{ rows: ReadonlyArray<V2SessionListRow>; userId: string }>) {
    return params.rows.map((row) => mapV2SessionListRow({ row, userId: params.userId }));
}

export function createV2SessionListPage(params: Readonly<{
    rows: ReadonlyArray<V2SessionListRow>;
    userId: string;
    limit: number;
}>) {
    const { rows, userId, limit } = params;
    const hasNext = rows.length > limit;
    const resultRows = hasNext ? rows.slice(0, limit) : rows;
    const lastRow = resultRows[resultRows.length - 1] ?? null;

    return {
        sessions: mapV2SessionListRows({ rows: resultRows, userId }),
        nextCursor: hasNext && lastRow ? encodeV2SessionListCursorV1(lastRow.id) : null,
        hasNext,
    };
}

export function decodeV2SessionListCursor(cursor: string | null | undefined): string | null | undefined {
    if (!cursor) return undefined;
    return decodeV2SessionListCursorV1(cursor) ?? null;
}
