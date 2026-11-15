import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { registerSessionMessageRoutes } from './registerSessionMessageRoutes';

describe('Session message activity snapshot (SQLite integration)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-message-activity-', initAuth: true,
            initEncrypt: false, initFiles: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['server_partial', 'snapshot_complete', 'machine_only'] as const)(
        'withholds live activity and custody from a %s publication without reading the queue', async currentStorageState => {
            const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}',
                encryptionMode: 'plain', seq: 2, currentStorageState, acceptedThroughServerSeq: 1,
                materializationPublicationId: randomUUID(), materializedThroughSourceAt: BigInt(Date.now()),
                publishedThroughServerSeq: 1, pendingCount: 3, pendingBlockedCount: 1,
                pendingPermissionRequestCount: 2, pendingUserActionRequestCount: 4, latestTurnStatus: 'in_progress' } });
            const localId = randomUUID();
            await db.sessionMessage.createMany({ data: [
                { sessionId: session.id, seq: 1, localId, messageRole: 'user',
                    content: { t: 'plain', v: { text: 'published' } } },
                { sessionId: session.id, seq: 2, localId: randomUUID(), messageRole: 'user',
                    content: { t: 'plain', v: { text: 'private catch-up' } } },
            ] });
            await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId, position: 0,
                content: { t: 'plain', v: 'private queue' }, requestedAction: { v: 1, kind: 'enqueue' },
                deliveryState: 'blocked', deliveryBlockedReason: 'invalid_prompt_text' } });
            const token = await createAccountTokenForTests(owner.id, { kind: 'account', authority: 'present_user' });
            const headers = { authorization: `Bearer ${token}`, 'x-happier-account-stored-content-protocol': '4' };
            await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
                let privateActivityReads = 0;
                const stop = observeSqliteRequests({ before: request => {
                    if (request.model === 'SessionPendingMessage'
                        || (request.model === 'Session' && JSON.stringify(request.args).includes('"_count"'))) {
                        privateActivityReads++;
                    }
                } });
                try {
                    const response = await app.inject({ method: 'GET',
                        url: `/v1/sessions/${session.id}/messages?projection=activity&scope=main`, headers });
                    expect(response.statusCode, response.body).toBe(200);
                    const page = response.json();
                    expect(page).not.toHaveProperty('activity');
                    expect(page.messages).toHaveLength(currentStorageState === 'machine_only' ? 0 : 1);
                    for (const message of page.messages) expect(message).not.toHaveProperty('pendingOwnsTranscript');
                    expect(privateActivityReads).toBe(0);
                } finally { stop(); }
            }, { authentication: 'real' });
        },
    );

    it('distinguishes a provisional safe refusal from actual and unmaterialized input', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}',
            encryptionMode: 'plain', pendingCount: 1, pendingBlockedCount: 1 } });
        const localId = randomUUID();
        await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, localId,
            messageRole: 'user', content: { t: 'plain', v: { text: 'provisional' } } } });
        const pending = await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId, position: 0,
            content: { t: 'plain', v: 'provisional' }, requestedAction: { v: 1, kind: 'enqueue' },
            deliveryState: 'blocked', deliveryBlockedReason: 'invalid_prompt_text' } });
        const token = await createAccountTokenForTests(owner.id, { kind: 'account', authority: 'present_user' });
        const headers = { authorization: `Bearer ${token}`, 'x-happier-account-stored-content-protocol': '4' };
        await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
            const read = async (query = 'projection=activity&scope=main') => {
                const response = await app.inject({ method: 'GET', url: `/v1/sessions/${session.id}/messages?${query}`, headers });
                expect(response.statusCode, response.body).toBe(200);
                return response.json();
            };
            const safe = await read();
            expect(safe.activity).toEqual({ pendingCount: 1, pendingBlockedCount: 1, pendingBlockedNoEffectCount: 1,
                pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, latestTurnStatus: null });
            expect(safe.messages).toHaveLength(1);
            expect(safe.messages[0]).toMatchObject({ localId, pendingOwnsTranscript: true });
            expect(safe.messages[0]).not.toHaveProperty('deliveryResolution');
            // Cursor pages answer a selected transcript interval, not whole-Session idleness.
            for (const cursor of ['afterSeq=0', 'beforeSeq=2']) {
                let scalarReads = 0;
                const stop = observeSqliteRequests({ before: request => {
                    if (request.model === 'Session') {
                        const selection = JSON.stringify(request.args);
                        if (selection.includes('"_count"') || selection.includes('"pendingCount":true')) scalarReads++;
                    }
                } });
                try {
                    const interval = await read(`projection=activity&scope=main&${cursor}`);
                    expect(interval.messages).toHaveLength(1);
                    expect(interval.messages[0]).toMatchObject({ localId, pendingOwnsTranscript: true });
                    expect(scalarReads).toBe(0);
                    expect(interval).not.toHaveProperty('activity');
                } finally { stop(); }
            }
            const ordinary = await read('scope=main');
            expect(ordinary).not.toHaveProperty('activity');
            expect(ordinary.messages[0]).not.toHaveProperty('pendingOwnsTranscript');

            // A queued item that has no transcript twin is still input in flight.
            await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId: randomUUID(), position: 1,
                content: { t: 'plain', v: 'unmaterialized' }, requestedAction: { v: 1, kind: 'enqueue' } } });
            await db.session.update({ where: { id: session.id }, data: { pendingCount: 2 } });
            expect((await read()).activity).toMatchObject({ pendingCount: 2, pendingBlockedNoEffectCount: 1 });
            for (const reason of ['ambiguous_terminal_delivery', 'team_access_removed', 'future_unrecognized_reason', null]) {
                await db.sessionPendingMessage.update({ where: { id: pending.id }, data: { deliveryBlockedReason: reason } });
                const uncertain = await read();
                expect(uncertain.activity).toMatchObject({ pendingCount: 2, pendingBlockedNoEffectCount: 0 });
                expect(uncertain.messages[0].pendingOwnsTranscript).toBe(true);
            }
            await db.sessionPendingMessage.update({ where: { id: pending.id }, data: { deliveryState: 'delivering' } });
            expect((await read()).messages[0]).not.toHaveProperty('pendingOwnsTranscript');
            // Acceptance/materialization retires the twin; the real input remains.
            await db.sessionPendingMessage.delete({ where: { id: pending.id } });
            await db.session.update({ where: { id: session.id }, data: { pendingCount: 1, pendingBlockedCount: 0 } });
            const accepted = await read();
            expect(accepted.messages[0]).toMatchObject({ localId, messageRole: 'user' });
            expect(accepted.messages[0]).not.toHaveProperty('pendingOwnsTranscript');
            expect(accepted.activity).toMatchObject({ pendingCount: 1, pendingBlockedCount: 0, pendingBlockedNoEffectCount: 0 });
            const invalid = await app.inject({ method: 'GET', url: `/v1/sessions/${session.id}/messages?projection=activity&scope=all`, headers });
            expect(invalid.statusCode).toBe(400);
        }, { authentication: 'real' });
    });
});
