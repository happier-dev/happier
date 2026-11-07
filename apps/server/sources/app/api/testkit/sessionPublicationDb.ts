import { createDbTransactionMock, inTxPostgresControlStatementMock } from './dbMocks';

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
}

/** Prisma relation/transaction boundary for publication payload tests, with the real audience owner beneath it. */
type SessionPublicationDbParams = Readonly<{
    sessionId: string;
    readSession: (...args: unknown[]) => Promise<unknown>;
}>;

export function createSessionPublicationDbFixture(params: SessionPublicationDbParams) {
    const tables = () => {
        let session: Record<string, unknown> | null = null;
        return {
            ...inTxPostgresControlStatementMock,
            session: { findMany: async () => {
                const row = record(await params.readSession({ where: { id: params.sessionId } }));
                session = row && { id: params.sessionId, account: { status: 'active' }, ...row };
                return session ? [session] : [];
            } },
            sessionShare: { findMany: async () => Array.isArray(session?.shares)
                ? session.shares.map(value => ({ sessionId: params.sessionId, ...record(value) })) : [] },
            sessionTeamGrant: { findMany: async () => [] },
            sessionGroupGrant: { findMany: async () => [] },
        };
    };
    const transaction = createDbTransactionMock(tables);
    return { db: transaction.wrapDb(tables()), readSnapshot: transaction.readSnapshot };
}

export function createSessionPublicationDbMock(params: SessionPublicationDbParams) {
    return createSessionPublicationDbFixture(params).db;
}
