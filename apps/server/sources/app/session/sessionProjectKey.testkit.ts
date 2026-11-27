import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { V2SessionListRowSchema } from '@happier-dev/protocol/sessions/control/contract';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { createPlainSessionOwnerMetadataEnvelopeV1, encodeSessionOwnerMetadataEnvelopeV1, SessionMetadataTuplePatchV1Schema, SessionMetadataInactiveModelIntentOwnerPatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { db } from '@/storage/db';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionPatchRoute } from '@/app/api/routes/session/registerSessionPatchRoute';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { eventRouter, type ClientConnection } from '@/app/events/eventRouter';
import { evaluateAccountStoredContentCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { createPresentUserSessionAccessAuthentication } from './access/sessionAccessAuthentication.testkit';
import { updateSessionMetadataEnvelopeTuple } from './sessionWriteService';

/** The same HTTP/storage contract runs against migrated SQLite and PostgreSQL. */
export function sessionProjectKeyContractTests(): void {
    const headers = (accountId: string) => ({ 'x-test-user-id': accountId,
        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) });
    it('persists owner Project identity atomically and projects it to owner and shared readers', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const editor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ownerMetadata = createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', active: true,
            metadataLayoutVersion: 1, metadata: '{"v":1}',
            ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(ownerMetadata), agentState: '{}',
        } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, accountId: editor.id, createdByAccountId: owner.id,
            accessLevel: 'edit', canApprovePermissions: false } });
        await db.accountSessionFollow.createMany({ data: [owner.id, editor.id].map(accountId => ({ accountId, sessionId: session.id })) });
        const received: Array<{ accountId: string; body: Record<string, unknown> }> = [];
        const connections = [owner.id, editor.id].map(accountId => {
            const connection: ClientConnection = {
                connectionType: 'user-scoped', userId: accountId,
                // Only the Socket.IO boundary is represented; publication and current access admission stay real.
                socket: { id: randomUUID(), data: { userId: accountId, clientType: 'user-scoped',
                    authTokenKind: 'account', authAuthority: 'present_user',
                    accountStoredContentCompatibility: evaluateAccountStoredContentCompatibility({ status: 'valid',
                        declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION }) },
                    emit: (_name: string, packet: unknown) => {
                        const parsed = UpdateContainerSchema.safeParse(packet);
                        if (parsed.success && parsed.data.body.t === 'update-session') {
                            received.push({ accountId, body: parsed.data.body });
                        }
                    },
                } as unknown as ClientConnection['socket'],
            };
            eventRouter.addConnection(accountId, connection);
            return connection;
        });
        const app = createAuthenticatedTestApp();
        registerSessionPatchRoute(app);
        registerSessionListingRoutes(app);
        const ownerPatch = (expectedVersion: number, projectKey?: string) => ({
            mode: 'owner' as const, metadataLayoutVersion: 1 as const,
            expectedOwnerMetadata: ownerMetadata, ownerMetadata,
            sharedMetadata: { ciphertext: '{"v":1}', expectedVersion },
            agentState: { ciphertext: '{}', expectedVersion: 0 },
            ...(projectKey === undefined ? {} : { projectKey }),
        });
        const patch = (payload: unknown, accountId = owner.id) => app.inject({ method: 'PATCH',
            url: `/v2/sessions/${session.id}`, headers: headers(accountId), payload });
        const read = async (accountId: string) => {
            const response = await app.inject({ method: 'GET', url: '/v2/sessions', headers: headers(accountId) });
            expect(response.statusCode, response.body).toBe(200);
            const record = response.json().sessions.find((row: { id: string }) => row.id === session.id);
            return V2SessionListRowSchema.parse(record);
        };
        try {
            // The patch is the genuine strict HTTP boundary: removing its new
            // schema member makes this fail with 400 before storage is reached.
            const first = await patch(ownerPatch(0, 'accepted-project'));
            expect(first.statusCode, first.body).toBe(200);
            expect(first.json()).toMatchObject({ success: true });
            for (const accountId of [owner.id, editor.id]) {
                await expect.poll(() => received.find(packet => packet.accountId === accountId)?.body)
                    .toMatchObject({ t: 'update-session', id: session.id, projectKey: 'accepted-project' });
            }
            expect(await read(owner.id)).toMatchObject({ projectKey: 'accepted-project' });
            const sharedRow = await read(editor.id);
            expect(sharedRow.projectKey).toBe('accepted-project');
            expect(sharedRow.ownerMetadata ?? null).toBeNull();
            const persisted = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(persisted).toMatchObject({ projectKey: 'accepted-project', metadataVersion: 1, agentStateVersion: 0 });
            const recipients = await db.accountChange.findMany({ where: { kind: 'session', entityId: session.id }, select: { accountId: true } });
            expect(recipients.map(row => row.accountId)).toEqual(expect.arrayContaining([owner.id, editor.id]));

            expect((await patch(ownerPatch(0, 'accepted-project'))).json()).toMatchObject({ success: true });
            // A different key is not an exact retry, even with identical envelopes.
            expect((await patch(ownerPatch(0, 'other-project'))).statusCode).toBe(409);
            expect((await patch(ownerPatch(1))).json()).toMatchObject({ success: true });
            expect(await read(owner.id)).toMatchObject({ projectKey: 'accepted-project' });
            expect((await patch(ownerPatch(2, 'other-project'))).json()).toMatchObject({ success: true });
            expect(await read(editor.id)).toMatchObject({ projectKey: 'other-project' });

            const sharedPatch = { mode: 'shared_editor' as const, metadataLayoutVersion: 1 as const,
                sharedMetadata: { ciphertext: '{"v":1}', expectedVersion: 3 }, projectKey: 'spoofed-project' };
            expect((await patch(sharedPatch, editor.id)).statusCode).toBe(400);
            const directSharedPatch = { ...sharedPatch, actorUserId: editor.id, sessionId: session.id,
                authentication: createPresentUserSessionAccessAuthentication() };
            expect(await updateSessionMetadataEnvelopeTuple(directSharedPatch)).toMatchObject({ ok: false, error: 'invalid-params' });
            expect((await patch(ownerPatch(3, 'spoofed-project'), editor.id)).statusCode).toBe(403);
            expect(await read(owner.id)).toMatchObject({ projectKey: 'other-project' });
            for (const invalid of ['', '  ']) {
                expect((await patch({ ...ownerPatch(3), projectKey: invalid })).statusCode).toBe(400);
            }
            expect(SessionMetadataInactiveModelIntentOwnerPatchV1Schema.safeParse({
                ...ownerPatch(3, 'spoofed-project'), mode: 'owner_inactive_model_intent',
                sessionExpectation: { kind: 'inactive_model_intent' },
            }).success).toBe(false);
            // Owner migration is a separate closed envelope and cannot publish identity.
            expect(SessionMetadataTuplePatchV1Schema.safeParse({
                mode: 'owner_migration', projectKey: 'spoofed-project',
                expectedAccountEncryptionMode: 'plain', expectedAccountContentPublicKeyFingerprint: null,
                source: { metadataLayoutVersion: 0, metadata: { version: 0, ciphertext: '{}' }, ownerMetadata: null,
                    agentState: { version: 0, ciphertext: '{}' } },
                target: { metadataLayoutVersion: 1, sharedMetadata: { ciphertext: '{"v":1}' }, ownerMetadata,
                    agentState: { ciphertext: '{}' } },
            }).success).toBe(false);
        } finally {
            for (const connection of connections) eventRouter.removeConnection(connection.userId, connection);
            await app.close();
            await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: session.id } });
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, editor.id] } } });
        }
    });

    it('selects a Project in one page: members and unclassified Sessions, never owner-published no-Project ones', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ownerMetadata = createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 });
        const sessions = await Promise.all(Array.from({ length: 8 }, (_, index) => db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', active: true,
            metadataLayoutVersion: 1, metadata: '{"v":1}', agentState: '{}', meaningfulActivityAt: new Date(index + 1),
            ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(ownerMetadata),
            ...(index === 0 ? { projectKey: 'payments' } : {}),
        } })));
        const [member, unclassified, ...withoutProject] = sessions;
        await db.accountSessionFollow.createMany({ data: sessions.map(session => ({ accountId: owner.id, sessionId: session.id })) });
        const app = createAuthenticatedTestApp();
        registerSessionPatchRoute(app);
        registerSessionListingRoutes(app);
        const publish = (sessionId: string, expectedVersion: number, projectKey: string | null) => app.inject({ method: 'PATCH',
            url: `/v2/sessions/${sessionId}`, headers: headers(owner.id), payload: {
                mode: 'owner', metadataLayoutVersion: 1, expectedOwnerMetadata: ownerMetadata, ownerMetadata,
                sharedMetadata: { ciphertext: '{"v":1}', expectedVersion },
                agentState: { ciphertext: '{}', expectedVersion: 0 }, projectKey,
            } });
        // Reads the Project roster's own selector and counts the pages one open walks.
        const select = async (projectKeys: { include: string[]; exclude: string[] }) => {
            const ids: string[] = [];
            let pages = 0;
            let cursor: string | undefined;
            do {
                const response = await app.inject({ method: 'POST', url: '/v2/sessions/query', headers: headers(owner.id), payload: {
                    v: 1, storage: 'active', scope: 'my_work', attention: 'any', includeInactive: true,
                    audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, projectKeys, limit: 2, includeAttention: false, ...(cursor ? { cursor } : {}),
                } });
                expect(response.statusCode, response.body).toBe(200);
                const page = response.json();
                pages += 1;
                ids.push(...page.sessions.map((row: { id: string }) => row.id));
                cursor = page.hasNext ? page.nextCursor : undefined;
            } while (cursor && pages < 10);
            return { ids: ids.sort(), pages };
        };
        try {
            for (const session of withoutProject) {
                const published = await publish(session.id, 0, null);
                expect(published.statusCode, published.body).toBe(200);
                // An exact retry of the no-Project publication is idempotent.
                expect((await publish(session.id, 0, null)).json()).toMatchObject({ success: true });
            }
            const listed = await app.inject({ method: 'GET', url: '/v2/sessions', headers: headers(owner.id) });
            const rows = listed.json().sessions.map((row: unknown) => V2SessionListRowSchema.parse(row));
            expect(rows.find((row: { id: string }) => row.id === withoutProject[0]!.id)).toMatchObject({ projectKey: null, projectKeyNone: true });
            expect(rows.find((row: { id: string }) => row.id === unclassified!.id)).not.toHaveProperty('projectKeyNone');

            expect(await select({ include: ['payments'], exclude: [] })).toEqual({ ids: [member!.id, unclassified!.id].sort(), pages: 1 });
            // Excluding other Projects still admits Sessions known to have none.
            expect((await select({ include: [], exclude: ['other'] })).ids).toHaveLength(sessions.length);

            // A Session gaining a Project later is selected once its owner publishes the key.
            expect((await publish(withoutProject[0]!.id, 1, 'payments')).statusCode).toBe(200);
            expect(await select({ include: ['payments'], exclude: [] }))
                .toEqual({ ids: [member!.id, unclassified!.id, withoutProject[0]!.id].sort(), pages: 2 });
            expect(await db.session.findUniqueOrThrow({ where: { id: withoutProject[0]!.id } }))
                .toMatchObject({ projectKey: 'payments', projectKeyNone: false });
        } finally {
            await app.close();
            await db.accountSessionFollow.deleteMany({ where: { accountId: owner.id } });
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it('lists a never-published Session as null and accepts older server records without the field', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain',
            active: true, metadataLayoutVersion: 1, metadata: '{"v":1}',
            ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 })),
        } });
        await db.accountSessionFollow.create({ data: { accountId: owner.id, sessionId: session.id } });
        const app = createAuthenticatedTestApp();
        registerSessionListingRoutes(app);
        try {
            const response = await app.inject({ method: 'GET', url: '/v2/sessions', headers: headers(owner.id) });
            expect(response.statusCode, response.body).toBe(200);
            const record = V2SessionListRowSchema.parse(response.json().sessions.find((row: { id: string }) => row.id === session.id));
            expect(record.projectKey).toBeNull();
            const { projectKey: _key, ...olderServerRecord } = record;
            expect(V2SessionListRowSchema.safeParse(olderServerRecord).success).toBe(true);
        } finally {
            await app.close();
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });
}
