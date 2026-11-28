import type { Prisma } from '@prisma/client';

export type RetentionSessionWhere = Prisma.SessionWhereInput;

export function cloudTranscriptSessionWhere() {
    return {
        cloudCopyLeftAt: null,
        NOT: { tag: { startsWith: 'direct:v1:' }, seq: 0 },
    } satisfies RetentionSessionWhere;
}

export function retentionEligibleSessionWhere(cutoff: Date, tierWhere?: RetentionSessionWhere): RetentionSessionWhere {
    return {
        active: false,
        updatedAt: { lt: cutoff },
        lastActiveAt: { lt: cutoff },
        sessionPins: { none: {} },
        ...cloudTranscriptSessionWhere(),
        ...(tierWhere ? { AND: [tierWhere] } : {}),
    };
}
