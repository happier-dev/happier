export type SessionDeleteTarget = Readonly<{
    id: string;
    accountId: string;
    shares: ReadonlyArray<Readonly<{ sharedWithUserId: string }>>;
}>;

export async function loadSessionDeleteRecipients(
    tx: {
        session: {
            findFirst: (args: unknown) => Promise<SessionDeleteTarget | null>;
        };
    },
    params: {
        sessionId: string;
        ownerAccountId?: string | null;
        sessionWhereGuard?: Record<string, unknown>;
    },
): Promise<SessionDeleteTarget | null> {
    const where = params.ownerAccountId
        ? { id: params.sessionId, accountId: params.ownerAccountId, ...(params.sessionWhereGuard ?? null) }
        : { id: params.sessionId, ...(params.sessionWhereGuard ?? null) };

    return await tx.session.findFirst({
        where,
        select: {
            id: true,
            accountId: true,
            shares: {
                select: {
                    sharedWithUserId: true,
                },
            },
        },
    });
}
