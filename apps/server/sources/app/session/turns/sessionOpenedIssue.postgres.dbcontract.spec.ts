import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDbPostgres } from '@/storage/db';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { applySessionTurnMutation } from '@/app/session/sessionWriteService';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('confirmed Session open issue projection (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); vi.unstubAllEnvs(); });

    it('clears only the current startup projection and keeps its failed turn and replay semantics', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        try {
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
            const authentication = createPresentUserSessionAccessAuthentication();
            const apply = (mutation: unknown) => applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation });
            const base = { v: 1, sessionId: session.id, turnId: 'startup-turn' };
            expect(await apply({ ...base, mutationId: randomUUID(), action: 'begin', observedAt: 100 })).toMatchObject({ ok: true, didApply: true });
            const issue = { v: 1, scope: 'primary_session', status: 'failed', code: 'native_agent_privileged_effect_authority_unavailable',
                source: 'agent_session_error', occurredAt: 101 };
            expect(await apply({ ...base, mutationId: randomUUID(), action: 'fail', observedAt: 101, issue })).toMatchObject({ ok: true, didApply: true });
            const opened = { v: 1, sessionId: session.id, mutationId: randomUUID(), action: 'session_opened', observedAt: 102 };
            expect(await apply(opened)).toMatchObject({ ok: true, didApply: true, lastRuntimeIssue: null, latestTurnStatusObservedAt: 102 });
            expect(await apply(opened)).toMatchObject({ ok: true, didApply: false, lastRuntimeIssue: null });
            const history = await db.sessionTurn.findMany({ where: { sessionId: session.id } });
            expect(history).toHaveLength(1);
            expect(history[0]).toMatchObject({ status: 'failed', updatedAt: 101n });
            expect(JSON.parse(history[0]!.lastRuntimeIssueJson!)).toMatchObject(issue);
            expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).lastRuntimeIssue).toBeNull();
        } finally {
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });
});
