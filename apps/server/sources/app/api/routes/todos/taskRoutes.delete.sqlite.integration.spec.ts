import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { buildTaskResourceChangeEntityIdV1, TaskResourceDeleteResponseV1Schema, TaskResourceErrorResponseV1Schema } from '@happier-dev/protocol/actions/internalTaskActions';
import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';

import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { kvRoutes } from '../kv/kvRoutes';
import { taskRoutes } from './taskRoutes';

describe('Task resource deletion', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-task-delete-', initAuth: true });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('allows only the owner to delete and invalidates the Task for the grantee', async () => {
        const createAccount = () => db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const owner = await createAccount();
        const grantee = await createAccount();
        const outsider = await createAccount();
        await makeShareEligibleForTest(owner.id, grantee.id);
        const accountHeaders = async (accountId: string) => ({
            authorization: `Bearer ${await auth.createToken(accountId, undefined, { kind: 'account', authority: 'present_user' })}`,
            'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
        });
        const [ownerHeaders, granteeHeaders, outsiderHeaders] = await Promise.all([owner.id, grantee.id, outsider.id].map(accountHeaders));
        const taskId = 'shared-task';
        const key = `todo.${taskId}`;
        const taskUrl = `/v1/tasks/${owner.id}/${taskId}`;
        const entityId = buildTaskResourceChangeEntityIdV1({ ownerAccountId: owner.id, taskId });
        const content = StoredJsonContentEnvelopeSchema.parse({ t: 'plain', v: { id: taskId, title: 'Keep until owner deletes', done: false } });
        const value = Buffer.from(JSON.stringify(content)).toString('base64');
        const grant = { principal: { kind: 'account', accountId: grantee.id }, accessLevel: 'admin' };
        const granteeChange = () => db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: grantee.id, kind: 'kv', entityId },
        } });

        await withAuthenticatedTestApp(app => { kvRoutes(app); taskRoutes(app); }, async app => {
            const create = await app.inject({ method: 'POST', url: '/v1/kv', headers: ownerHeaders,
                payload: { mutations: [{ key, version: -1, value }] } });
            expect(create.statusCode, create.body).toBe(200);
            const share = await app.inject({ method: 'PUT', url: `${taskUrl}/grants`, headers: ownerHeaders, payload: grant });
            expect(share.statusCode, share.body).toBe(200);
            const before = await granteeChange();

            for (const headers of [granteeHeaders, outsiderHeaders]) {
                const denied = await app.inject({ method: 'DELETE', url: taskUrl, headers });
                expect(denied.statusCode, denied.body).toBe(404);
                expect(TaskResourceErrorResponseV1Schema.parse(denied.json())).toEqual({ error: 'task_not_found' });
            }
            const intact = await app.inject({ method: 'GET', url: taskUrl, headers: granteeHeaders });
            expect(intact.statusCode, intact.body).toBe(200);
            expect(intact.json()).toMatchObject({ access: 'admin', content, version: 0 });
            expect((await granteeChange()).cursor).toBe(before.cursor);

            const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
            const deleted = await fetch(`${baseUrl}${taskUrl}`, { method: 'DELETE', headers: ownerHeaders });
            const receipt: unknown = await deleted.json();
            expect(deleted.status, JSON.stringify(receipt)).toBe(200);
            expect(TaskResourceDeleteResponseV1Schema.parse(receipt)).toEqual({ deleted: true });
            const change = await granteeChange();
            expect(change.cursor).toBeGreaterThan(before.cursor);
            expect(change.hint).toBeNull();
            for (const headers of [ownerHeaders, granteeHeaders]) {
                const missing = await app.inject({ method: 'GET', url: taskUrl, headers });
                expect(missing.statusCode, missing.body).toBe(404);
                expect(TaskResourceErrorResponseV1Schema.parse(missing.json())).toEqual({ error: 'task_not_found' });
            }
            const repeated = await app.inject({ method: 'DELETE', url: taskUrl, headers: ownerHeaders });
            expect(repeated.statusCode, repeated.body).toBe(404);
            expect(TaskResourceErrorResponseV1Schema.parse(repeated.json())).toEqual({ error: 'task_not_found' });
            expect((await granteeChange()).cursor).toBe(change.cursor);
            const tombstone = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: owner.id, key } },
                select: { value: true, version: true, _count: { select: { grants: true } } } });
            expect(tombstone).toEqual({ value: null, version: 1, _count: { grants: 0 } });
        }, { authentication: 'real' });
    });
});
