import * as privacyKit from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { TaskResourceErrorResponseV1Schema, TaskResourceV1Schema } from '@happier-dev/protocol/actions/internalTaskActions';

import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { kvRoutes } from '../kv/kvRoutes';
import { taskRoutes } from './taskRoutes';

describe('Task resource mutation', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-task-mutate-', initAuth: true });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['legacy', 'wrapped'] as const)('preserves %s Account ciphertext through competing writes at one version', async representation => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' },
            select: { id: true } });
        const headers = {
            authorization: `Bearer ${await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' })}`,
            'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
        };
        const taskId = `task-${representation}`;
        const key = `todo.${taskId}`;
        // The server handles ciphertext as opaque, so the fixture needs only distinct binary payloads.
        const content = (byte: number) => ({ t: 'encrypted', c: privacyKit.encodeBase64(new Uint8Array([255, byte])) });
        const stored = (ciphertext: ReturnType<typeof content>) => representation === 'legacy' ? ciphertext.c
            : privacyKit.encodeBase64(new TextEncoder().encode(JSON.stringify(ciphertext)));

        await withAuthenticatedTestApp(app => { kvRoutes(app); taskRoutes(app); }, async app => {
            const created = await app.inject({ method: 'POST', url: '/v1/kv', headers,
                payload: { mutations: [{ key, version: -1, value: stored(content(1)) }] } });
            expect(created.statusCode, created.body).toBe(200);
            const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
            const taskUrl = `${baseUrl}/v1/tasks/${owner.id}/${taskId}`;
            const initial = await fetch(taskUrl, { headers });
            expect(initial.status).toBe(200);
            const observed = TaskResourceV1Schema.parse(await initial.json());
            expect(observed).toMatchObject({ content: content(1), version: 0 });

            const writes = await Promise.all([content(2), content(3)].map(async (next) => {
                const response = await fetch(taskUrl, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
                    body: JSON.stringify({ content: next, expectedVersion: observed.version }) });
                return { next, status: response.status, body: await response.json() as unknown };
            }));
            expect(writes.map(write => write.status).sort(), JSON.stringify(writes.map(write => write.body))).toEqual([200, 409]);
            const winner = writes.find(write => write.status === 200)!;
            const loser = writes.find(write => write.status === 409)!;
            expect(TaskResourceV1Schema.parse(winner.body)).toMatchObject({ content: winner.next, version: 1 });
            expect(TaskResourceErrorResponseV1Schema.parse(loser.body)).toEqual({ error: 'task_version_conflict' });
            if (representation === 'legacy') {
                const malformed = await app.inject({ method: 'PUT', url: `/v1/tasks/${owner.id}/${taskId}`, headers,
                    payload: { expectedVersion: 1, content: { t: 'encrypted', c: 'invalid_!' } } });
                expect(malformed.statusCode, malformed.body).toBe(400);
                expect(TaskResourceErrorResponseV1Schema.parse(malformed.json())).toEqual({ error: 'task_invalid_content' });
            }
            const row = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: owner.id, key } } });
            expect(row.value && privacyKit.encodeBase64(row.value)).toBe(stored(winner.next));
            const readBack = await fetch(taskUrl, { headers });
            expect(TaskResourceV1Schema.parse(await readBack.json())).toEqual(winner.body);
        }, { authentication: 'real' });
    });
});
