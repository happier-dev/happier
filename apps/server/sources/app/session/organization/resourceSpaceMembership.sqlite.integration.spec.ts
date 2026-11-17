import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionOrganizationRoutes } from '@/app/api/routes/session/registerSessionOrganizationRoutes';

describe('personal resource space membership through organization HTTP', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'review-spaces-', initAuth: false, initEncrypt: false, initFiles: false }); });
    afterAll(async () => { await harness.close(); });

    it('lets a View recipient organize only their own memberships and withdraws visibility with the grant', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const reader = await db.account.create({ data: { publicKey: randomUUID() } });
        const outsider = await db.account.create({ data: { publicKey: randomUUID() } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id, kind: 'review.v1', header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
        await db.artifactGrant.create({ data: { artifactId: artifact.id, principalKind: 'account', accountId: reader.id, accessLevel: 'view', createdByAccountId: owner.id } });
        const app = createAuthenticatedTestApp();
        registerSessionOrganizationRoutes(app);
        await app.ready();
        const mutate = (accountId: string, operation: string, spaceId?: string, sourceSpaceId?: string) => app.inject({ method: 'POST', url: '/v2/session-organization/resource-space-memberships', headers: { 'x-test-user-id': accountId }, payload: {
            resourceKind: 'artifact', resourceId: artifact.id, operation, ...(spaceId ? { spaceId } : {}), ...(sourceSpaceId ? { sourceSpaceId } : {}),
        } });
        const memberships = (accountId: string, spaceId: string) => app.inject({ method: 'GET', url: `/v2/session-organization/resource-space-memberships?spaceId=${spaceId}&resourceKind=artifact`, headers: { 'x-test-user-id': accountId } });
        try {
            expect((await mutate(owner.id, 'add', 'owner-space')).statusCode).toBe(200);
            const ownerChanges = await db.accountChange.count({ where: { accountId: owner.id } });
            expect((await mutate(reader.id, 'add', 'reader-space')).statusCode).toBe(200);
            expect(await db.accountChange.count({ where: { accountId: owner.id } })).toBe(ownerChanges);
            expect(await db.accountChange.count({ where: { accountId: outsider.id } })).toBe(0);
            expect((await mutate(outsider.id, 'add', 'reader-space')).statusCode).toBe(404);
            expect((await memberships(reader.id, 'owner-space')).json()).toEqual({ resourceIds: [] });
            expect((await memberships(owner.id, 'reader-space')).json()).toEqual({ resourceIds: [] });
            expect((await memberships(reader.id, 'reader-space')).json()).toEqual({ resourceIds: [artifact.id] });
            const before = await db.accountChange.count({ where: { accountId: reader.id } });
            expect((await mutate(reader.id, 'add', 'reader-space')).json()).toMatchObject({ changed: false });
            expect(await db.accountChange.count({ where: { accountId: reader.id } })).toBe(before);
            await mutate(reader.id, 'add', 'other-space');
            await mutate(reader.id, 'move', 'destination', 'reader-space');
            expect((await memberships(reader.id, 'reader-space')).json()).toEqual({ resourceIds: [] });
            expect((await memberships(reader.id, 'other-space')).json()).toEqual({ resourceIds: [artifact.id] });
            expect((await memberships(reader.id, 'destination')).json()).toEqual({ resourceIds: [artifact.id] });
            await mutate(reader.id, 'remove', 'destination');
            expect((await memberships(reader.id, 'destination')).json()).toEqual({ resourceIds: [] });
            expect((await mutate(reader.id, 'reset')).json()).toEqual({ changed: true });
            expect((await memberships(reader.id, 'other-space')).json()).toEqual({ resourceIds: [] });
            await mutate(reader.id, 'add', 'other-space');
            const deleteSpace = () => app.inject({ method: 'POST', url: '/v2/session-organization/resource-space-memberships',
                headers: { 'x-test-user-id': reader.id }, payload: { resourceKind: 'artifact', operation: 'delete_space', spaceId: 'other-space' } });
            expect((await deleteSpace()).json()).toEqual({ changed: true });
            expect((await deleteSpace()).json()).toEqual({ changed: false });
            expect((await memberships(owner.id, 'owner-space')).json()).toEqual({ resourceIds: [artifact.id] });
            await mutate(reader.id, 'add', 'other-space');
            expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).headerVersion).toBe(0);
            expect(await db.artifactGrant.count({ where: { artifactId: artifact.id } })).toBe(1);
            await db.artifactGrant.deleteMany({ where: { artifactId: artifact.id, accountId: reader.id } });
            expect((await memberships(reader.id, 'other-space')).json()).toEqual({ resourceIds: [] });
            expect((await mutate(reader.id, 'add', 'other-space')).statusCode).toBe(404);
            expect((await memberships(owner.id, 'owner-space')).json()).toEqual({ resourceIds: [artifact.id] });
        } finally { await app.close(); }
    });
});
