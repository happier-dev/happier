import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageSessionTimingV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inReadSnapshot } from '@/storage/inTx';
import { prismaRuntime } from '@/storage/prisma';
import { readSessionEvidenceCandidateIdsInTx, selectSessionEvidenceSubjectsInTx } from './selectSessionEvidenceSubjects';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('persisted Usage timing on PostgreSQL', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Requires the disposable PostgreSQL DB-contract owner');
        initDbPostgres(); await db.$connect();
    });
    afterAll(async () => { await shutdownDbClient(); });

    it('bounds authorized candidate header rows to the named wake on PostgreSQL', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        try {
            const make = (accountId: string) => db.session.create({ data: { accountId, tag: randomUUID(),
                encryptionMode: 'plain', metadata: '{}', agentState: '{}' } });
            const candidate = await make(account.id);
            await make(account.id);
            const foreign = await make(other.id);
            const ids = await inReadSnapshot(tx => readSessionEvidenceCandidateIdsInTx(tx, {
                accountId: account.id, authentication: { env: process.env, authority: 'present_user', authenticationEvidence: undefined },
                candidateIds: [candidate.id, foreign.id],
            }));
            expect(ids).toEqual([candidate.id]);
        } finally {
            await db.session.deleteMany({ where: { accountId: { in: [account.id, other.id] } } });
            await db.account.deleteMany({ where: { id: { in: [account.id, other.id] } } });
        }
    });

    it('prunes both content modes by known bounds, retaining open waits, message timestamps and unknowns', async () => {
        const nowMs = Date.UTC(2026, 10, 5, 12), day = 86_400_000;
        const empty = { v: 1 as const, minMs: null, maxMs: null };
        const finite = (at: number) => ({ v: 1 as const, minMs: at, maxMs: at });
        const account = await db.account.create({ data: { encryptionMode: 'e2ee' } });
        const ids: string[] = [];
        // Raw JSON fixture writes avoid regenerating the shared default Prisma client.
        // The source selector still executes its actual SQL on PostgreSQL 17.
        const make = async (mode: 'plain' | 'e2ee', timing: UsageSessionTimingV1 | null, activityAt?: number) => {
            const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: mode,
                metadata: mode === 'plain' ? '{}' : 'sealed', agentState: mode === 'plain' ? '{}' : 'sealed',
                createdAt: new Date(nowMs - 400 * day), ...(activityAt === undefined ? {} : {
                    updatedAt: new Date(activityAt), lastActiveAt: new Date(activityAt),
                }) } });
            if (timing) await db.$executeRaw`UPDATE "Session" SET "usageTimingV1"=${JSON.stringify(timing)}::jsonb WHERE id=${session.id}`;
            ids.push(session.id); return session;
        };
        const outside: string[] = [], month: string[] = [], today: string[] = [];
        for (const mode of ['plain', 'e2ee'] as const) {
            outside.push((await make(mode, { v: 1, metadata: finite(nowMs - 400 * day), agentState: empty })).id);
            month.push((await make(mode, { v: 1, metadata: finite(nowMs - 10 * day), agentState: empty })).id);
            today.push((await make(mode, { v: 1, metadata: finite(nowMs - 3_600_000), agentState: empty })).id);
            await make(mode, { v: 1, metadata: empty, agentState: empty });
        }
        const legacy = await make('e2ee', null);
        const oldLegacy = await make('e2ee', null, nowMs - 400 * day);
        const wait = await make('e2ee', { v: 1, metadata: empty, agentState: { v: 1, minMs: nowMs - 400 * day, maxMs: null } });
        const embedded = await make('e2ee', { v: 1, metadata: empty, agentState: empty });
        const message = await db.sessionMessage.create({ data: { sessionId: embedded.id, seq: 1,
            createdAt: new Date(nowMs - 400 * day), content: { t: 'encrypted', c: 'sealed' } } });
        await db.$executeRaw`UPDATE "SessionMessage" SET "usageTimingV1"=${JSON.stringify(finite(nowMs - 3_600_000))}::jsonb WHERE id=${message.id}`;
        const base = [legacy.id, wait.id, embedded.id];
        const costs: Array<{ period: string; selectedSessions: number; returnedIdJsonBytes: number; elapsedMs: number }> = [];
        for (const [period, expected] of [['today', [...today, ...base]], ['90days', [...today, ...month, ...base]],
            ['all', [...today, ...month, ...outside, ...base, oldLegacy.id]]] as const) {
            const started = performance.now();
            const selected = await inReadSnapshot(tx => selectSessionEvidenceSubjectsInTx(tx, { accountId: account.id, candidateIds: ids,
                query: normalizeUsageQuery({ period: { relative: period } }), nowMs }));
            expect(selected.sort()).toEqual([...expected].sort());
            costs.push({ period, selectedSessions: selected.length, returnedIdJsonBytes: Buffer.byteLength(JSON.stringify(selected)),
                elapsedMs: performance.now() - started });
        }
        const largeOrdinary = await db.sessionMessage.create({ data: { sessionId: outside[0], seq: 1,
            createdAt: new Date(nowMs - 400 * day), content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'x'.repeat(500_000) } } } } });
        await db.$executeRaw`UPDATE "SessionMessage" SET "usageTimingV1"=${JSON.stringify(empty)}::jsonb WHERE id=${largeOrdinary.id}`;
        const afterPadding = await inReadSnapshot(tx => selectSessionEvidenceSubjectsInTx(tx, { accountId: account.id, candidateIds: ids,
            query: normalizeUsageQuery({ period: { relative: 'today' } }), nowMs }));
        expect(afterPadding.sort()).toEqual([...today, ...base].sort());
        expect(Buffer.byteLength(JSON.stringify(afterPadding))).toBe(costs[0].returnedIdJsonBytes);
        const [bytes] = await db.$queryRaw<Array<{ messages: number; contentBytes: string }>>(prismaRuntime.sql`
            SELECT count(*)::int AS messages, COALESCE(sum(octet_length(content::text)),0)::text AS "contentBytes"
            FROM "SessionMessage" WHERE "sessionId" IN (${prismaRuntime.join(afterPadding)})`);
        console.log(JSON.stringify({ boundary: 'postgresql-timing-demand', candidateSessions: ids.length, costs,
            selectedMessageRows: bytes.messages, selectedMessageContentBytes: bytes.contentBytes,
            unrelatedOrdinaryBodyBytes: 500_000 }));
    });
});
