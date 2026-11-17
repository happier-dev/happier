// Cross-owner CLI/HTTP composition uses the DB-contract harness's per-importer aliases.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { createActionExecutor } from '@happier-dev/protocol';

import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { registerSessionDeleteRoute } from '@/app/api/routes/session/registerSessionDeleteRoute';
import { createCliApprovalsArtifactStore } from '../../../../cli/src/session/actions/approvals/artifactStore';
import { createAccountServerActionDeps } from '../../../../cli/src/api/accountServerActionDeps';
import { runWithServerHttpBaseUrl } from '../../../../cli/src/api/client/serverHttpBaseUrl';
import { createUnavailableActionTransportDeps } from '../../../../cli/src/testkit/actionTransportDeps';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('receipt-backed Approval settlement through CLI, HTTP and PostgreSQL', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = 'none';
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it('settles executed after one rolled-back terminal CAS without repeating Session deletion', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: JSON.stringify({ v: 1 }) } });
        let deletes = 0;
        let effectSucceeded = false;
        let conflicts = 0;
        const app = createAuthenticatedTestApp();
        app.addHook('onRequest', async request => {
            request.headers['x-test-user-id'] = account.id;
            if (request.method === 'DELETE' && request.url === `/v1/sessions/${session.id}`) deletes += 1;
        });
        app.addHook('onResponse', async (request, reply) => {
            if (request.method === 'DELETE' && request.url === `/v1/sessions/${session.id}` && reply.statusCode === 200) {
                effectSucceeded = true;
            }
        });
        artifactsRoutes(app);
        registerSessionDeleteRoute(app);
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        const transaction = db.$transaction;
        // Inject the observed Prisma rollback only at the database boundary.
        // Admission, effect, strict HTTP codecs, CAS and recovery remain real.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                get(inner, property, innerReceiver) {
                    if (property !== 'artifact') return Reflect.get(inner, property, innerReceiver);
                    return new Proxy(inner.artifact, { get(delegate, method, delegateReceiver) {
                        const operation = Reflect.get(delegate, method, delegateReceiver);
                        if (method !== 'updateMany') return operation;
                        return (...queryArgs: Parameters<typeof tx.artifact.updateMany>) => {
                            if (effectSucceeded && conflicts === 0) {
                                conflicts += 1;
                                throw new PrismaClientKnownRequestError('Expired terminal publication', {
                                    code: 'P2028', clientVersion: '6.19.2',
                                    meta: { error: 'Transaction already closed: A query cannot be executed on an expired transaction.' },
                                });
                            }
                            return Reflect.apply(operation, delegate, queryArgs);
                        };
                    } });
                },
            })), ...args.slice(1)]);
        } });
        try {
            await runWithServerHttpBaseUrl(origin, async () => {
                const store = createCliApprovalsArtifactStore({ credentials: { token: 'fixture', encryption: null },
                    serverId: 'home', serverHttpBaseUrl: origin, getAccountEncryptionMode: async () => 'plain' });
                const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...store,
                    isApprovalExecutionOriginCurrent: async () => true,
                    isActionApprovalRequired: actionId => actionId === 'session.delete',
                    homeDomainAction: createAccountServerActionDeps({ token: 'fixture', serverId: 'home',
                        serverHttpBaseUrl: origin }).homeDomainAction,
                });
                const context = { surface: 'cli', authority: 'present_user', serverId: 'home',
                    runtimeAccountId: account.id, defaultSessionId: session.id,
                    actionRequestId: randomUUID(), actionCaller: { kind: 'host' } } as const;
                const created = await executor.execute('session.delete', { sessionId: session.id }, context);
                expect(created).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                if (!created.ok || !created.result || typeof created.result !== 'object'
                    || !('artifactId' in created.result) || typeof created.result.artifactId !== 'string') {
                    throw new Error('Expected a deferred deletion Approval');
                }
                const artifactId = created.result.artifactId;
                const result = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context);
                expect(effectSucceeded).toBe(true);
                expect(conflicts).toBe(1);
                expect(result).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
                expect(await store.approvalsGet({ artifactId, serverId: null })).toMatchObject({ status: 'executed',
                    execution: { ok: true, effectAttempted: true, result: { success: true } } });
                expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();
                expect(await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context))
                    .toMatchObject({ ok: true, result: { status: 'executed' } });
                expect(deletes).toBe(1);
            });
        } finally {
            db.$transaction = transaction;
            await app.close();
        }
    });
});
