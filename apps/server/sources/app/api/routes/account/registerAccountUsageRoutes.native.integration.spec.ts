import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { registerAccountUsageRoutes } from './registerAccountUsageRoutes';
import { eventRouter } from '@/app/events/eventRouter';
import { EphemeralUpdateSchema } from '@happier-dev/protocol/updates';

// Event delivery is the process-external boundary; admission and SQLite storage stay real.
vi.mock('@/utils/logging/log', () => ({ log: vi.fn() }));

describe('native usage HTTP admission', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        vi.spyOn(eventRouter, 'emitEphemeral').mockImplementation(() => {});
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-native-usage-', initAuth: false });
    }, 120_000);
    afterAll(async () => {
        await harness.close();
        vi.mocked(eventRouter.emitEphemeral).mockRestore();
    });
    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([() => db.usageEvent.deleteMany(), () => db.session.deleteMany(), () => db.machine.deleteMany(), () => db.account.deleteMany()]);
    });

    it('deletes only the authenticated native root/range while keeping runtime witness history', async () => {
        const account = await db.account.create({ data: { publicKey: 'native-route-account' } });
        const other = await db.account.create({ data: { publicKey: 'native-route-other' } });
        await db.machine.create({ data: { id: 'native-route-machine', accountId: account.id, metadata: 'ciphertext' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'native-route-session', metadata: 'ciphertext' } });
        const subject = { kind: 'native', machineId: 'native-route-machine', agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, sourceRootKey: 'root-1', nativeSessionKey: 'native-1' };
        const base = { observedAt: 10, agentId: 'codex', source: 'codex-native', scope: 'turn_delta', isCumulative: false, tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 }, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } };
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async (app) => {
            const post = (payload: unknown, userId = account.id, url = '/v2/usage-events') => app.inject({ method: 'POST', url, headers: { 'x-test-user-id': userId }, payload });
            expect((await post({ ...base, subject: { ...subject, linkedSessionId: session.id }, externalKey: 'unwitnessed' })).statusCode).toBe(400);
            const runtime = await post({ ...base, sessionId: session.id, machineId: subject.machineId, externalKey: 'shared', metadata: { accountingSubject: subject, usageAccounting: { path: 'runtime', status: 'available', inferenceId: 'shared-inference' } } });
            expect(runtime.statusCode).toBe(200);
            expect((await post({ ...base, subject: { ...subject, sourceRootKey: 'wrong-root', linkedSessionId: session.id }, externalKey: 'wrong-link' })).statusCode).toBe(400);
            const native = await post({ ...base, subject: { ...subject, linkedSessionId: session.id }, externalKey: 'shared', accounting: { status: 'available', inferenceKey: 'shared-inference' } });
            expect(native.statusCode).toBe(200);
            expect((await post({ ...base, subject, externalKey: 'earlier', observedAt: 5 })).statusCode).toBe(200);
            expect((await post({ ...base, subject: { ...subject, sourceRootKey: 'root-2' }, externalKey: 'other-root' })).statusCode).toBe(200);
            const deletion = { machineId: subject.machineId, sourceRootKey: 'root-1', dateRange: { startMs: 10, endMs: 11 } };
            const path = '/v2/usage-events/delete-native-history';
            expect((await post(deletion, other.id, path)).statusCode).toBe(404);
            const deleted = await post(deletion, account.id, path);
            expect(deleted.statusCode).toBe(200);
            expect(deleted.json()).toEqual({ success: true, deletedEventCount: 1 });
            const wake = vi.mocked(eventRouter.emitEphemeral).mock.calls.at(-1)?.[0];
            expect(wake).toMatchObject({ userId: account.id, recipientFilter: { type: 'user-scoped-only' }, payload: { type: 'usage', id: null, key: 'native_history_deleted' } });
            expect(EphemeralUpdateSchema.safeParse(wake?.payload).success).toBe(true);
            expect((await post(deletion, account.id, path)).json()).toEqual({ success: true, deletedEventCount: 0 });
        });
        const rows = await db.usageEvent.findMany({ where: { accountId: account.id } });
        expect(rows.map((row) => row.externalKey).sort()).toEqual(['earlier', 'other-root', 'shared']);
        expect(rows.find((row) => row.externalKey === 'shared')?.sessionId).toBe(session.id);
    });
});
