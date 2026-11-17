import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { PendingResetStartsReadResultV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createDbMaintenanceClient, db, getActivePrismaRuntime, getDbProviderFromEnv, initDbPostgres, type PrismaClientType } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { enqueuePendingMessage, updatePendingRequestedAction } from './pendingMessageService';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { logger } from '@/utils/logging/log';

const source = { bindingKind: 'account', ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai' }, accountId: 'account' } } as const;
const measureSql = process.env.HAPPIER_TEST_PG_STAT_STATEMENTS === '1';

// Profiling only: EXPLAIN the actual normalized Prisma candidate statement
// with this fixture's bindings. The route and access owner still produce SQL.
async function explainCandidates(query: string, accountId: string) {
    const values = new Map<string, string>();
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const bind = (pattern: RegExp, value: string) => {
        for (const match of query.matchAll(pattern)) values.set(match[1], value);
    };
    bind(/LIMIT \$(\d+)/gu, '1');
    bind(/\bON \$(\d+)/gu, 'true');
    for (const match of query.matchAll(/\$(\d+), "[^"]+"\."([^"]+)"/gu)) values.set(match[1], literal(match[2]));
    bind(/\$(\d+)::text AS "public"\."SessionPendingMessageStatus"/gu, literal('queued'));
    bind(/\$(\d+)::text AS "public"\."AccountStatus"/gu, literal('active'));
    bind(/"(?:accountId|sharedWithUserId)" = \$(\d+)/gu, literal(accountId));
    const storage = [...query.matchAll(/"currentStorageState" = \$(\d+)/gu)];
    storage.forEach((match, index) => values.set(match[1], literal(index === 0 ? 'hosted' : 'snapshot_complete')));
    bind(/"materializationPublicationId" <> \$(\d+)/gu, literal(''));
    bind(/"(?:materializedThroughSourceAt|publishedThroughServerSeq)" >= \$(\d+)/gu, '0');
    bind(/"materializedThroughSourceAt" <= \$(\d+)/gu, String(Number.MAX_SAFE_INTEGER));
    [...query.matchAll(/\$(\d+)::text AS "public"\."ShareAccessLevel"/gu)]
        .forEach((match, index) => values.set(match[1], literal(['view', 'edit', 'admin'][index])));
    const statement = query.replace(/\$(\d+)/gu, (_match, id: string) => {
        const value = values.get(id);
        if (value === undefined) throw new Error(`Unknown candidate-query profile binding ${id}`);
        return value;
    });
    const result = await db.$queryRawUnsafe<unknown[]>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`);
    console.log(JSON.stringify({ resetCandidateExplainAnalyze: result }));
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('reset read set-oriented snapshot (real PostgreSQL)', () => {
    let originalUrl: string;
    let connected = false;
    let peerClient: PrismaClientType | undefined;
    const phases: { phase: string; elapsedMs: number }[] = [];
    let collecting = false;
    let restoreLogger: (() => void) | undefined;
    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error('Use the task-owned disposable PostgreSQL harness');
        originalUrl = supplied;
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', 'srv_01234567890123456789012345678901');
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        // Observe the real adapter's timing output; all domain and SQL logic runs.
        const original = logger.warn.bind(logger);
        const spy = vi.spyOn(logger, 'warn').mockImplementation((value: unknown, ...args: unknown[]) => {
            if (typeof value === 'object' && value !== null && 'module' in value && value.module === 'web-latency') {
                if (collecting && 'phase' in value && typeof value.phase === 'string'
                    && 'elapsedMs' in value && typeof value.elapsedMs === 'number') phases.push({ phase: value.phase, elapsedMs: value.elapsedMs });
                return;
            }
            Reflect.apply(original, logger, [value, ...args]);
        });
        restoreLogger = () => spy.mockRestore();
        initDbPostgres();
        await db.$connect();
        connected = true;
        peerClient = await createDbMaintenanceClient('postgres', supplied);
        await peerClient.$connect();
        if (measureSql) await db.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    });
    afterAll(async () => {
        if (connected) await db.$disconnect();
        await peerClient?.$disconnect();
        restoreLogger?.();
        vi.unstubAllEnvs();
        if (originalUrl) process.env.DATABASE_URL = originalUrl;
    });

    it('keeps historic unbound and held inputs while SQL work stays set-oriented as the queue grows', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] }, sessionPendingResetStart: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: account.id, sessionId: session.id, machineId: machine.id, data: 'key' }));
        const localId = randomUUID();
        expect(await enqueuePendingMessage({ actorUserId: account.id, authentication: createPresentUserSessionAccessAuthentication(),
            sessionId: session.id, localId, targetMachineId: machine.id, requestedAction: { v: 1, kind: 'enqueue' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'task-owned private pending text' } } } })).toMatchObject({ ok: true });
        const produced = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } });
        const receipt = SessionInputAdmissionReceiptV1Schema.parse(produced.inputAdmissionReceipt);
        const reset = { source, recordId: 'paug_v1_abcdefgh', meterId: 'weekly', witness: { id: 'accepted-history-entry', observedAtMs: 1000 } } as const;
        await db.providerAccountUsageRecord.create({ data: { accountId: account.id, recordId: reset.recordId,
            providerId: 'openai', accountSubjectId: 'account', subjectKind: 'account', quotaScope: 'account', quotaScopeIdKey: '',
            recordKeyJson: {}, payloadMode: 'plain_json_v1', status: 'ok',
            history: { create: { id: `${reset.witness.id}-${account.id}`, observedAt: new Date(reset.witness.observedAtMs), payload: {} } } } });
        expect(await updatePendingRequestedAction({ actorUserId: account.id, authentication: createPresentUserSessionAccessAuthentication(),
            sessionId: session.id, localId, requestedAction: { v: 1, kind: 'reset_start', reset } })).toMatchObject({ ok: true });
        const peerAccount = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        await withAuthenticatedTestApp(sessionPendingRoutes, async app => {
            const read = async () => {
                phases.length = 0;
                if (measureSql) await db.$queryRawUnsafe('SELECT pg_stat_statements_reset()');
                const started = performance.now();
                collecting = true;
                let finished = false;
                let peerWrites = 0;
                const peer = (async () => {
                    while (!finished) {
                        await peerClient!.$executeRaw`UPDATE "Account" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${peerAccount.id}`;
                        peerWrites += 1;
                    }
                })();
                const response = await app.inject({ method: 'POST', url: '/v2/pending/reset-starts/read',
                    headers: { 'x-test-user-id': account.id }, payload: { source } }).finally(async () => {
                        collecting = false;
                        finished = true;
                        await peer;
                    });
                const elapsedMs = performance.now() - started;
                expect(response.statusCode).toBe(200);
                const value = PendingResetStartsReadResultV1Schema.parse(response.json());
                const sql = measureSql ? await db.$queryRaw<Array<{ query: string; calls: bigint; total_exec_time: number }>>`
                    SELECT query, calls, total_exec_time FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                    AND query NOT LIKE '%pg_stat_statements%' AND query NOT LIKE 'UPDATE %' ORDER BY total_exec_time DESC
                ` : [];
                const sqlCalls = sql.reduce((n, row) => n + Number(row.calls), 0);
                const grouped = new Map<string, { calls: number; elapsedMs: number }>();
                for (const row of phases) {
                    const group = grouped.get(row.phase) ?? { calls: 0, elapsedMs: 0 };
                    group.calls += 1;
                    group.elapsedMs += row.elapsedMs;
                    grouped.set(row.phase, group);
                }
                console.log(JSON.stringify({ resetReadMeasurement: { elapsedMs, sqlCalls, peerWrites, sqlExecutionMs: sql.reduce((n, row) => n + row.total_exec_time, 0),
                    entries: value.entries.length, unbound: value.unboundEntries?.length ?? 0,
                    phases: Object.fromEntries(grouped) },
                    sql: sql.map(row => ({ ...row, calls: Number(row.calls) })) }));
                if (measureSql) {
                    const candidate = sql.find(row => row.query.startsWith('SELECT ') && row.query.includes('FROM "public"."SessionPendingMessage"'));
                    if (!candidate) throw new Error('Candidate SELECT was not observed');
                    await explainCandidates(candidate.query, account.id);
                }
                expect(JSON.stringify(value)).not.toContain('task-owned private pending text');
                const ormCalls = phases.filter(row => /^db\.[A-Z]/u.test(row.phase)).length;
                expect(peerWrites).toBeGreaterThan(0);
                return { value, sqlCalls, ormCalls };
            };
            const baseline = await read();
            const expected: { sessionId: string; localId: string; authorityCurrent: boolean }[] = [];
            const newSessions = Array.from({ length: 27 }, () => ({ id: randomUUID(), accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' as const }));
            await db.session.createMany({ data: newSessions });
            await db.accessKey.createMany({ data: newSessions.map(s => ({ accountId: account.id, sessionId: s.id, machineId: machine.id, data: 'key' })) });
            await db.sessionPendingMessage.createMany({ data: newSessions.map((s, i) => {
                const id = randomUUID();
                expected.push({ sessionId: s.id, localId: id, authorityCurrent: i !== 0 && i !== 1 });
                return { sessionId: s.id, localId: id, position: 1, status: 'queued', messageRole: 'user', authorAccountId: account.id,
                    content: produced.content!, requestedAction: { v: 1, kind: 'enqueue' }, inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.parse({ ...receipt,
                        admittedTarget: { ...receipt.admittedTarget!, sessionId: s.id, ...(i === 0 ? { installationId: randomUUID() } : {}) } }) };
            }) });
            // A key on the same Machine for another Session is not authority
            // for this exact receipt tuple.
            await db.accessKey.delete({ where: { accountId_machineId_sessionId: {
                accountId: account.id, machineId: machine.id, sessionId: newSessions[1].id,
            } } });
            await db.sessionPendingMessage.createMany({ data: Array.from({ length: 500 }, (_, i) => ({ sessionId: session.id,
                localId: randomUUID(), position: i + 2, status: 'queued', messageRole: 'assistant', authorAccountId: null,
                content: produced.content!, requestedAction: { v: 1, kind: 'enqueue' }, inputAdmissionReceipt: getActivePrismaRuntime().DbNull })) });
            const expanded = await read();
            expect(expanded.value).toEqual({ entries: [{ sessionId: session.id, localId, reset, authorityCurrent: true }],
                unboundEntries: expected.sort((a, b) => a.sessionId.localeCompare(b.sessionId)) });
            // Adding Sessions/irrelevant rows must not repeat full access/target
            // SQL per Pending row; this detects the reproduced N+1 independently
            // of host speed and does not impose a product latency cutoff.
            expect(expanded.sqlCalls).toBeLessThanOrEqual(baseline.sqlCalls * 2);
            expect(expanded.ormCalls).toBeLessThanOrEqual(baseline.ormCalls * 2);
        });
    });
});
