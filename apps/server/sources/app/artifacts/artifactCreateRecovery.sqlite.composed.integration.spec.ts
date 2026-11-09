import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { TransactionConflictExhaustedError, TransactionDeadlineExceededError } from '@/storage/inTx';

const fault = vi.hoisted(() => ({ once: null as unknown, persistent: null as unknown, responseRead: null as unknown }));
vi.mock('@/storage/db', async importOriginal => {
    const actual = await importOriginal<typeof import('@/storage/db')>();
    return { ...actual, db: new Proxy(actual.db, {
        get(target, key) {
            const value: unknown = Reflect.get(target, key);
            if (key !== '$transaction' || typeof value !== 'function') return value;
            return (...args: unknown[]) => {
                const error = fault.once ?? fault.persistent;
                fault.once = null;
                return error ? Promise.reject(error) : Reflect.apply(value, target, args);
            };
        },
    }) };
});
vi.mock('@/storage/prisma', async importOriginal => {
    const actual = await importOriginal<typeof import('@/storage/prisma')>();
    return { ...actual, withSqliteReadSnapshot: (...args: Parameters<typeof actual.withSqliteReadSnapshot>) => {
        if (fault.responseRead) throw fault.responseRead;
        return actual.withSqliteReadSnapshot(...args);
    } };
});

describe('Artifact creation storage recovery through real HTTP wiring', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-artifact-create-recovery-', initEncrypt: true,
            env: { HAPPIER_DB_TX_MAX_RETRIES: '1', HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: '0', HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: '0' } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(() => { fault.once = null; fault.persistent = null; fault.responseRead = null; });

    function payload(id: string) {
        return { id, header: encodePlainArtifactStoredContent({ title: 'Approval' }),
            body: encodePlainArtifactStoredContent({ body: 'Approve gateway creation' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };
    }

    it('preserves storage deadlines as typed 503 for create and update without changing durable content', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const existingId = randomUUID();
        const newId = randomUUID();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            expect((await app.inject({ method: 'POST', url: '/v1/artifacts', headers, payload: payload(existingId) })).statusCode).toBe(200);
            fault.persistent = new TransactionDeadlineExceededError(null, 'artifact-timeout');
            for (const request of [
                { url: '/v1/artifacts', payload: payload(newId) },
                { url: `/v1/artifacts/${existingId}`, payload: { body: encodePlainArtifactStoredContent({ body: 'changed' }), expectedBodyVersion: 1 } },
            ]) {
                const response = await app.inject({ method: 'POST', headers, ...request });
                expect(response.statusCode, response.body).toBe(503);
                expect(response.json()).toEqual({ error: 'database_transaction_timeout', statusCode: 503 });
            }
            expect(await db.artifact.count({ where: { id: newId } })).toBe(0);
            expect(await db.artifact.findUniqueOrThrow({ where: { id: existingId } })).toMatchObject({ bodyVersion: 1 });
        });
    });

    it('recovers a rolled-back create within the canonical transaction budget, without duplicate durable content', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = randomUUID();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            // Genuine DB/driver boundary: the first attempt is rejected before
            // commit; every subsequent attempt uses the real migrated database.
            fault.once = Object.assign(new Error('private SQL conflict'), { code: 'P2034' });
            const request = { method: 'POST' as const, url: '/v1/artifacts', headers: { 'x-test-user-id': owner.id }, payload: payload(id) };
            const response = await app.inject(request);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ id, headerVersion: 1, bodyVersion: 1 });
            expect((await app.inject(request)).statusCode).toBe(200);
            expect(await db.artifact.count({ where: { id } })).toBe(1);
            expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ headerVersion: 1, bodyVersion: 1 });
        });
    });

    it.each([
        { nativeCode: 'P2034', expectedCode: 'database_transaction_conflict_exhausted' },
        { nativeCode: 'P2024', expectedCode: 'database_connection_unavailable' },
    ])('preserves $nativeCode exhaustion as typed 503 and writes nothing', async ({ nativeCode, expectedCode }) => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = randomUUID();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            fault.persistent = Object.assign(new Error('private SQL contents'), { code: nativeCode });
            const response = await app.inject({ method: 'POST', url: '/v1/artifacts', headers: { 'x-test-user-id': owner.id }, payload: payload(id) });
            expect(response.statusCode, response.body).toBe(503);
            expect(response.json()).toEqual({ error: expectedCode, statusCode: 503 });
            expect(response.body).not.toContain('private');
            expect(await db.artifact.findUnique({ where: { id } })).toBeNull();
        });
    });

    it('retains typed rollback exhaustion on revision update without changing content', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = randomUUID();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            expect((await app.inject({ method: 'POST', url: '/v1/artifacts', headers, payload: payload(id) })).statusCode).toBe(200);
            // Access is captured normally; only the actual write's transaction
            // acquisition fails. No internal admission or mutation is replaced.
            fault.persistent = Object.assign(new Error('private SQL contents'), { code: 'P2034' });
            const response = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers,
                payload: { body: encodePlainArtifactStoredContent({ body: 'changed' }), expectedBodyVersion: 1 } });
            expect(response.statusCode, response.body).toBe(503);
            expect(response.json()).toEqual({ error: 'database_transaction_conflict_exhausted', statusCode: 503 });
            expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ bodyVersion: 1 });
        });
    });

    it('carries real server refusal through the CLI store, then recovers the same create after a committed response-read failure', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = randomUUID();
        await withAuthenticatedTestApp(app => {
            app.addHook('onRequest', async (request: { headers: Record<string, unknown> }) => { request.headers['x-test-user-id'] = owner.id; });
            artifactsRoutes(app);
        }, async app => {
            // Cross-package source is loaded by the composed Vitest harness;
            // the Server production compiler must retain its own rootDir.
            const cliStorePath = '../../../../cli/src/api/artifacts/accountArtifactStore';
            const cliServerUrlPath = '../../../../cli/src/api/client/serverHttpBaseUrl';
            const { createAccountArtifactStore } = await import(cliStorePath);
            const { runWithServerHttpBaseUrl } = await import(cliServerUrlPath);
            const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
            await runWithServerHttpBaseUrl(baseUrl, async () => {
                const store = createAccountArtifactStore({ credentials: { token: 'fixture', encryption: null }, getAccountEncryptionMode: async () => 'plain' });
                fault.persistent = Object.assign(new Error('private SQL contents'), { code: 'P2034' });
                const refusal: unknown = await store.create({ artifactId: id, header: {}, body: 'approval' }).catch((error: unknown) => error);
                expect(refusal).toMatchObject({ code: 'database_transaction_conflict_exhausted', response: { status: 503 } });
                expect(await db.artifact.count({ where: { id } })).toBe(0);
                fault.persistent = null;
                // The driver snapshot fails after the write commits. Even a
                // confirmed rollback of this later read is not mutation rollback.
                fault.responseRead = new TransactionConflictExhaustedError(new Error('private SQL contents'));
                const failure: unknown = await store.create({ artifactId: id, header: {}, body: 'approval' }).catch((error: unknown) => error);
                expect(failure).toMatchObject({ code: 'create_failed', response: { status: 500 } });
                expect(JSON.stringify(failure)).not.toContain('private');
                fault.responseRead = null;
                expect(await db.artifact.count({ where: { id } })).toBe(1);
                expect(await store.create({ artifactId: id, header: {}, body: 'approval' })).toMatchObject({ artifactId: id,
                    revision: { headerVersion: 1, bodyVersion: 1 } });
            });
        });
    });
});
